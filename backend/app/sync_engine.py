"""Warehouse-native diff sync engine.

Each run:
  1. materializes the sync's rows into <state>.sync_<id>_current
       - audience syncs: one row per audience member (after destination rules, priority
         lists and split groups)
       - event syncs:    rows of an event/related model whose customer is in the audience
  2. diffs them against <state>.sync_<id>_snapshot -> added / changed / removed
  3. sends changes according to the sync mode (insert: added only; update/upsert: added +
     changed) and handles removed rows with the sync's delete behavior
  4. rebuilds the snapshot so that rejected rows are retried on the next run
  5. optionally writes audience snapshots (enter / exit) and fires alerts

All diffing happens inside Databricks; only changed rows leave the warehouse.
"""
from __future__ import annotations

import json
import re
import threading
import traceback
from typing import Iterator

import logging

import httpx

from . import alerts, config, connection, db, destinations, mapping
from .audiences import _load_audience, as_of, load_schema, null_matches_negation
from .catalog import IDENT_RE, quote_column, quote_ident
from .compiler import CompileError, Compiler, check_privacy, join_keys, source
from .databricks import client

log = logging.getLogger(__name__)

TARGET_RE = re.compile(r"^[A-Za-z0-9_\-. ]{1,128}$")
CUSTOMER_PREFIX = "customer."
MAX_LOGGED_ERRORS = 200
_running: set[int] = set()
_running_lock = threading.Lock()


class SyncError(Exception):
    pass


# ---- configuration ---------------------------------------------------------------

def normalize_config(cfg: dict, dest_cls) -> dict:
    """Fill defaults and translate configs saved before sync types existed."""
    st = dest_cls.get_sync_type(cfg.get("sync_type"))
    mode = cfg.get("mode")
    behavior = cfg.get("delete_behavior")
    if "sync_type" not in cfg and mode in ("mirror", "upsert"):
        # Legacy: "mode" used to mean what happens to people who leave the audience.
        behavior = behavior or ("remove" if mode == "mirror" else "do_nothing")
        mode = None
    mode = mode if mode in st.modes else st.modes[0]
    if st.source == "events" or behavior not in st.delete_behaviors:
        behavior = "do_nothing"
    options = {o.name: o.default for o in st.options if o.default is not None}
    options.update({k: v for k, v in (cfg.get("options") or {}).items() if v not in (None, "")})
    return {**cfg, "sync_type": st.name, "mode": mode, "delete_behavior": behavior, "options": options,
            "mapping": cfg.get("mapping") or [], "match": cfg.get("match"), "alerts": cfg.get("alerts") or {}}


def validate_config(cfg: dict, dest_cls, schema: dict) -> dict:
    cfg = normalize_config(cfg, dest_cls)
    st = dest_cls.get_sync_type(cfg["sync_type"])
    sources = source_columns(st, cfg, schema)
    mapping_ = []
    for m in cfg["mapping"]:
        k = mapping.kind(m)
        if not m.get("target"):
            continue
        if k == "column":
            if not m.get("source"):
                continue
            if m["source"] not in sources:
                raise SyncError(f"Column {m['source']!r} isn't available for this sync")
            parent_col = m["source"].removeprefix(CUSTOMER_PREFIX) if st.source == "events" else m["source"]
            if st.source != "events" or m["source"].startswith(CUSTOMER_PREFIX):
                try:
                    check_privacy(schema["parent"], parent_col, "sync")
                except CompileError as e:
                    raise SyncError(str(e))
        elif k == "template":
            missing = mapping.template_columns(m.get("template", "")) - sources
            if missing:
                raise SyncError(f"Template uses unknown columns: {', '.join(sorted(missing))}")
            try:
                mapping.env.from_string(m.get("template", ""))
            except Exception as e:  # noqa: BLE001
                raise SyncError(f"Template for {m['target']!r} is invalid: {e}")
        elif k == "variable" and m.get("variable") not in mapping.VARIABLES:
            raise SyncError(f"Unknown variable {m.get('variable')!r}")
        if not TARGET_RE.match(m["target"]):
            raise SyncError(f"Invalid destination field name {m['target']!r}")
        mapping_.append(m)
    if not st.custom_fields:
        allowed = {t.name for t in st.target_fields}
        bad = [m["target"] for m in mapping_ if m["target"] not in allowed]
        if bad:
            raise SyncError(f"{st.label} doesn't accept fields: {', '.join(bad)}")
    mapped = {m["target"] for m in mapping_}
    missing = [t.label for t in st.target_fields if t.required and t.name not in mapped]
    if missing:
        raise SyncError(f"Map the required fields: {', '.join(missing)}")
    if st.identifiers:
        match = cfg.get("match") or {}
        ids = {i.name: i for i in st.identifiers}
        if match.get("field") not in ids:
            raise SyncError("Choose how records are matched (record matching)")
        if ids[match["field"]].modes and cfg["mode"] not in ids[match["field"]].modes:
            raise SyncError(f"{ids[match['field']].label} matching only works in {', '.join(ids[match['field']].modes)} mode")
        if match.get("source") not in sources:
            raise SyncError("Choose the column to match records on")
    if not mapping_ and not st.identifiers:
        raise SyncError("Map at least one field")
    for opt in st.options:
        if opt.required and not cfg["options"].get(opt.name) and (not opt.modes or cfg["mode"] in opt.modes):
            raise SyncError(f"{opt.label} is required")
        if opt.type == "column" and cfg["options"].get(opt.name) and cfg["options"][opt.name] not in sources:
            raise SyncError(f"{opt.label}: unknown column")
    if st.source == "events":
        model = event_model(cfg, schema)
        if not model.get("primary_key"):
            raise SyncError(f"{model['name']} needs a unique primary key for event syncs (set it in Data setup)")
    url = (cfg["alerts"] or {}).get("webhook_url")
    if url and not url.startswith("https://"):
        raise SyncError("Alert webhook URL must start with https://")
    return {**cfg, "mapping": mapping_}


def event_model(cfg: dict, schema: dict) -> dict:
    try:
        return schema["models"][int(cfg.get("model_id"))]
    except (KeyError, TypeError, ValueError):
        raise SyncError("Choose which event or related table to send")


def parent_sources(schema: dict) -> set[str]:
    parent = schema["parent"]
    cols = {c["name"] for c in parent["columns"]}
    cols |= {f"trait.{t}" for t in schema.get("traits", {})}
    for mid, m in schema.get("models", {}).items():
        cols |= {f"merged.{mid}.{c}" for c in m.get("merge_columns") or []}
    return cols


def source_columns(st, cfg: dict, schema: dict) -> set[str]:
    parents = parent_sources(schema)
    if st.source != "events":
        return parents
    model = event_model(cfg, schema)
    return {c["name"] for c in model["columns"]} | {CUSTOMER_PREFIX + c for c in parents}


def _col_sql(comp, name: str, st, schema: dict) -> str:
    if st.source == "events" and not name.startswith(CUSTOMER_PREFIX):
        return quote_column(name, "e")
    name = name.removeprefix(CUSTOMER_PREFIX) if st.source == "events" else name
    try:
        return comp.parent_column(name, purpose="sync")[0]
    except CompileError as e:
        raise SyncError(str(e))


# ---- state tables ----------------------------------------------------------------

def _state_schema() -> str:
    parts = connection.state_schema().split(".")
    if len(parts) != 2 or not all(IDENT_RE.match(p) for p in parts):
        raise SyncError("The sync state schema (Sources → Databricks connection) must look like catalog.schema")
    return ".".join(quote_ident(p) for p in parts)


def _tables(sync_id: int) -> dict[str, str]:
    s = _state_schema()
    return {k: f"{s}.{quote_ident(f'sync_{sync_id}_{k}')}" for k in ("snapshot", "current", "failed", "next")}


def _lit(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def effective_definition(sync: dict, audience: dict) -> dict:
    """Audience definition + destination rules + priority-list exclusions + split group."""
    conds = [audience["definition"]]
    for rule in db.query("SELECT definition FROM destination_rules WHERE destination_id = ? AND parent_id = ?",
                         (sync["destination_id"], audience["parent_id"])):
        conds.append(rule["definition"])
    for pl in db.query("SELECT config FROM priority_lists WHERE parent_id = ?", (audience["parent_id"],)):
        order = [int(x) for x in pl["config"].get("audience_ids", [])]
        if audience["id"] in order:
            conds += [{"type": "audience", "audience_id": h, "included": False} for h in order[:order.index(audience["id"])]]
    group = (sync["config"] or {}).get("split_group")
    if group:
        splits = audience.get("splits") or {}
        conds.append({"type": "split", "audience_id": audience["id"], "groups": splits.get("groups", []), "group": group})
    return {"type": "group", "op": "and", "conditions": conds}


def build_query(cfg: dict, st, schema: dict, definition: dict):
    """SELECT producing (__pk, __payload). The payload JSON holds the match value (m),
    grouping value (g), column-mapped fields (f) and template inputs (r)."""
    comp = compiler_for(schema)
    parent = schema["parent"]
    column_maps = [m for m in cfg["mapping"] if mapping.kind(m) == "column"]
    raw_cols = sorted({c for m in cfg["mapping"] if mapping.kind(m) == "template" for c in mapping.template_columns(m["template"])})
    struct = lambda pairs: f"named_struct({', '.join(pairs)})" if pairs else "map()"  # noqa: E731
    fields = struct([f"'{m['target']}', {_col_sql(comp, m['source'], st, schema)}" for m in column_maps])
    raw = struct([f"'{c}', {_col_sql(comp, c, st, schema)}" for c in raw_cols])
    match = cfg.get("match") or {}
    match_sql = f"CAST({_col_sql(comp, match['source'], st, schema)} AS STRING)" if match.get("source") else "CAST(NULL AS STRING)"
    group = cfg["options"].get("group_by")
    group_sql = f"CAST({_col_sql(comp, group, st, schema)} AS STRING)" if group else "CAST(NULL AS STRING)"
    payload = f"to_json(named_struct('m', {match_sql}, 'g', {group_sql}, 'f', {fields}, 'r', {raw}))"
    if st.source == "events":
        m = event_model(cfg, schema)
        keys = " AND ".join(f"{quote_column(k['model'], 'e')} = {quote_column(k['parent'], 'p')}" for k in join_keys(m, parent))
        from_ = f"{source(m)} e JOIN {source(parent)} p ON {keys}"
        return comp.compile(definition, select=f"CAST({quote_column(m['primary_key'], 'e')} AS STRING) AS __pk, {payload} AS __payload", from_=from_)
    return comp.compile(definition, select=f"CAST({quote_column(parent['primary_key'], 'p')} AS STRING) AS __pk, {payload} AS __payload")


def compiler_for(schema: dict) -> Compiler:
    return Compiler(schema, as_of(schema["parent"].get("id")), _load_audience, null_matches_negation=null_matches_negation())


def _parse(pk: str, payload: str | None) -> dict:
    data = json.loads(payload) if payload else {}
    if "f" not in data:  # snapshot written before match/group were stored
        return {"id": pk, "match": pk, "group": None, "fields": data, "raw": {}}
    return {"id": pk, "match": data.get("m"), "group": data.get("g"), "fields": data.get("f") or {}, "raw": data.get("r") or {}}


def _stream(sql: str, default_match_pk: bool) -> Iterator[dict]:
    _, rows = client().iter_rows(sql)
    for pk, payload in rows:
        row = _parse(pk, payload)
        if default_match_pk and row["match"] is None:
            row["match"] = pk
        yield row


def _batches(it: Iterator[dict], size: int) -> Iterator[list[dict]]:
    batch = []
    for row in it:
        batch.append(row)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


# ---- runs ------------------------------------------------------------------------

def start_run(sync_id: int, trigger: str = "manual", full_resync: bool = False) -> int:
    with _running_lock:
        if sync_id in _running:
            raise SyncError("This sync is already running")
        _running.add(sync_id)
    run_id = db.insert("sync_runs", {"sync_id": sync_id, "status": "running", "trigger": trigger, "started_at": db.now()})
    threading.Thread(target=_run_guarded, args=(sync_id, run_id, full_resync), daemon=True).start()
    return run_id


def _run_guarded(sync_id: int, run_id: int, full_resync: bool) -> None:
    try:
        execute(sync_id, run_id, full_resync)
    except Exception as e:  # noqa: BLE001 — everything is recorded on the run
        db.update("sync_runs", run_id, {"status": "failed", "finished_at": db.now(), "error": str(e),
                                        "details": {"traceback": traceback.format_exc()[-4000:]}})
    finally:
        db.update("syncs", sync_id, {"last_run_at": db.now()})
        with _running_lock:
            _running.discard(sync_id)
        try:
            alerts.after_run(sync_id, run_id)
        except Exception:  # noqa: BLE001 — alerts must never break a run
            log.exception("Alert evaluation failed for sync %s run %s", sync_id, run_id)


def execute(sync_id: int, run_id: int, full_resync: bool = False) -> None:
    sync = db.one("SELECT * FROM syncs WHERE id = ?", (sync_id,))
    audience = db.one("SELECT * FROM audiences WHERE id = ?", (sync["audience_id"],))
    dest_row = db.one("SELECT * FROM destinations WHERE id = ?", (sync["destination_id"],))
    connection.use_parent(audience["parent_id"])  # runs on its own thread: pick the audience's connection
    schema = load_schema(audience["parent_id"])
    dest_cls = destinations.get(dest_row["type"])
    cfg = validate_config(sync["config"], dest_cls, schema)
    st = dest_cls.get_sync_type(cfg["sync_type"])
    t = _tables(sync_id)
    dbx = client()
    context = {"sync_id": sync_id, "run_id": run_id, "audience_name": audience["name"], "sync_type": st.name,
               "mode": cfg["mode"], "options": cfg["options"], "match_field": (cfg.get("match") or {}).get("field"),
               "model_id": audience["id"], "model_name": audience["name"],
               "mapped_targets": [m.get("target") for m in cfg.get("mapping") or []]}
    dest = dest_cls(dest_row["config"], context)
    created = dest.prepare()
    if created:  # e.g. an ad-platform segment made on the first run: remember it for later runs
        cfg["options"].update(created)
        db.update("syncs", sync_id, {"config": {**sync["config"], "options": {**(sync["config"].get("options") or {}), **created}}})

    # 1. materialize current rows
    dbx.execute(f"CREATE SCHEMA IF NOT EXISTS {_state_schema()}")
    table_ddl = "(__pk STRING, __payload STRING, __hash STRING)"
    if full_resync:
        dbx.execute(f"CREATE OR REPLACE TABLE {t['snapshot']} {table_ddl}")
    else:
        dbx.execute(f"CREATE TABLE IF NOT EXISTS {t['snapshot']} {table_ddl}")
    compiled = build_query(cfg, st, schema, effective_definition({**sync, "config": cfg}, audience))
    dbx.execute(f"CREATE OR REPLACE TABLE {t['current']} {table_ddl}")
    # Parameterized INSERT (DDL can't take parameter markers). Dedupe defensively on the key.
    dbx.execute(
        f"INSERT INTO {t['current']} SELECT __pk, max(__payload), sha2(max(__payload), 256) "
        f"FROM (\n{compiled.sql}\n) WHERE __pk IS NOT NULL GROUP BY __pk",
        compiled.params,
    )
    current_rows = dbx.execute(f"SELECT COUNT(*) FROM {t['current']}").rows[0][0]
    db.update("sync_runs", run_id, {"audience_rows": current_rows})

    # 2+3. diff and send
    order = " ORDER BY get_json_object(c.__payload, '$.g')" if cfg["options"].get("group_by") else ""
    plans = [("added", "upsert",
              f"SELECT c.__pk, c.__payload FROM {t['current']} c LEFT ANTI JOIN {t['snapshot']} s ON s.__pk = c.__pk{order}")]
    if cfg["mode"] != "insert":
        plans.append(("changed", "upsert",
                      f"SELECT c.__pk, c.__payload FROM {t['current']} c JOIN {t['snapshot']} s "
                      f"ON s.__pk = c.__pk WHERE s.__hash <> c.__hash"))
    behavior = cfg["delete_behavior"]
    if behavior in ("remove", "delete", "clear"):
        plans.append(("removed", "clear" if behavior == "clear" else "remove",
                      f"SELECT s.__pk, s.__payload FROM {t['snapshot']} s LEFT ANTI JOIN {t['current']} c ON s.__pk = c.__pk"))

    counts = {"added": 0, "changed": 0, "removed": 0}
    failed: list[tuple[str, str]] = []  # (pk, kind)
    errors: list[dict] = []

    def reject(pk, kind, err):
        failed.append((pk, kind))
        if len(errors) < MAX_LOGGED_ERRORS:
            errors.append({"id": pk, "kind": kind, "error": err})

    try:
        for kind, action, sql in plans:
            for batch in _batches(_stream(sql, not st.identifiers), dest.batch_size_for_run()):
                ready = []
                for row in batch:
                    try:
                        row["fields"] = mapping.finalize(cfg["mapping"], row["fields"], row["raw"], context)
                        ready.append(row)
                    except (mapping.RowRejected, ValueError, TypeError) as e:
                        reject(row["id"], kind, f"Mapping: {e}")
                result = getattr(dest, action)(ready) if ready else {}
                counts[kind] += len(ready) - len(result)
                for pk, err in result.items():
                    reject(pk, kind, err)
                db.update("sync_runs", run_id, {**counts, "failed": len(failed)})
    finally:
        dest.close()

    # 4. new snapshot = current, except rejected rows keep their previous state.
    if not failed:
        dbx.execute(f"CREATE OR REPLACE TABLE {t['snapshot']} AS SELECT * FROM {t['current']}")
    else:
        dbx.execute(f"CREATE OR REPLACE TABLE {t['failed']} (__pk STRING, kind STRING)")
        for i in range(0, len(failed), 1000):
            values = ", ".join(f"({_lit(pk)}, {_lit(kind)})" for pk, kind in failed[i:i + 1000])
            dbx.execute(f"INSERT INTO {t['failed']} VALUES {values}")
        dbx.execute(
            f"CREATE OR REPLACE TABLE {t['next']} AS "
            f"SELECT * FROM {t['current']} WHERE __pk NOT IN (SELECT __pk FROM {t['failed']} WHERE kind IN ('added', 'changed')) "
            f"UNION ALL SELECT * FROM {t['snapshot']} WHERE __pk IN (SELECT __pk FROM {t['failed']} WHERE kind IN ('changed', 'removed'))"
        )
        dbx.execute(f"CREATE OR REPLACE TABLE {t['snapshot']} AS SELECT * FROM {t['next']}")
        dbx.execute(f"DROP TABLE IF EXISTS {t['next']}")

    # 5. audience snapshots (enter / exit history in the warehouse)
    snapshot_info = None
    if db.get_setting("audience_snapshots", False) and st.source == "audience":
        snapshot_info = write_audience_snapshot(audience, schema)

    # "Completed with errors" when some rows were rejected; "Failed" is reserved for runs that error out.
    db.update("sync_runs", run_id, {
        **counts, "failed": len(failed), "status": "success" if not failed else "completed_with_errors",
        "finished_at": db.now(), "error": errors[0]["error"] if errors else None,
        "details": {"errors": errors, "query": compiled.sql, "requests": dest.debug_log, "snapshot": snapshot_info},
    })


def write_audience_snapshot(audience: dict, schema: dict) -> dict:
    """Record who entered / exited the audience since the previous snapshot, in
    <state>.audience_membership (row_id, audience_id, timestamp, event_type, split_group)."""
    s = _state_schema()
    members = f"{s}.{quote_ident('audience_' + str(audience['id']) + '_members')}"
    history = f"{s}.audience_membership"
    dbx = client()
    comp = compiler_for(schema)
    pk = quote_column(schema["parent"]["primary_key"], "p")
    groups = (audience.get("splits") or {}).get("groups") or []
    if groups and (audience.get("splits") or {}).get("enabled"):
        bucket = f"pmod(xxhash64(CAST({pk} AS STRING), 'audience-{audience['id']}'), 100)"
        case, start = [], 0
        for g in groups:
            end = start + int(g["percent"])
            case.append(f"WHEN {bucket} >= {start} AND {bucket} < {end} THEN {_lit(g['name'])}")
            start = end
        split_sql = f"CASE {' '.join(case)} END"
    else:
        split_sql = "CAST(NULL AS STRING)"
    c = comp.compile(audience["definition"], select=f"CAST({pk} AS STRING) AS row_id, {split_sql} AS split_group")
    dbx.execute(f"CREATE TABLE IF NOT EXISTS {history} (ht_row_id STRING, ht_audience_id BIGINT, ht_timestamp TIMESTAMP, "
                f"ht_event_type STRING, ht_split_group STRING)")
    dbx.execute(f"CREATE TABLE IF NOT EXISTS {members} (row_id STRING, split_group STRING)")
    new = f"{s}.{quote_ident('audience_' + str(audience['id']) + '_members_new')}"
    dbx.execute(f"CREATE OR REPLACE TABLE {new} (row_id STRING, split_group STRING)")
    dbx.execute(f"INSERT INTO {new} SELECT DISTINCT * FROM (\n{c.sql}\n)", c.params)
    aid = int(audience["id"])
    dbx.execute(f"INSERT INTO {history} SELECT n.row_id, {aid}, current_timestamp(), 'enter', n.split_group "
                f"FROM {new} n LEFT ANTI JOIN {members} m ON m.row_id = n.row_id")
    dbx.execute(f"INSERT INTO {history} SELECT m.row_id, {aid}, current_timestamp(), 'exit', m.split_group "
                f"FROM {members} m LEFT ANTI JOIN {new} n ON m.row_id = n.row_id")
    dbx.execute(f"CREATE OR REPLACE TABLE {members} AS SELECT * FROM {new}")
    dbx.execute(f"DROP TABLE IF EXISTS {new}")
    return {"table": f"{connection.state_schema()}.audience_membership"}


def drop_state(sync_id: int) -> None:
    row = db.one("SELECT a.parent_id FROM syncs s JOIN audiences a ON a.id = s.audience_id WHERE s.id = ?", (sync_id,))
    connection.use_parent(row["parent_id"] if row else None)
    for table in _tables(sync_id).values():
        client().execute(f"DROP TABLE IF EXISTS {table}")


def is_running(sync_id: int) -> bool:
    return sync_id in _running
