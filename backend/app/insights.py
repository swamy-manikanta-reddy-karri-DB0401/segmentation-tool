"""Read-only views for the product shell: overview numbers, source datasets and customer profiles."""
from __future__ import annotations

from . import audiences, catalog, connection, db, destinations
from .catalog import quote_column, quote_ident
from .compiler import CompileError, column_setting, join_keys, source, trait_type
from .databricks import DatabricksError, client

MASKED = {"redacted", "blocked", "sync_only"}


def missing_fields(dest: dict) -> list[str]:
    """Labels of required destination settings that are still empty."""
    cls = destinations.get(dest["type"])
    return [f.label for f in cls.config_fields if f.required and not str((dest.get("config") or {}).get(f.name) or "").strip()]


def destination_configured(destination_id: int) -> bool:
    d = db.one("SELECT type, config FROM destinations WHERE id = ?", (destination_id,))
    return bool(d) and not missing_fields(d)


# ---- sources ---------------------------------------------------------------------

def _table_stats(full_name: str) -> dict:
    out = {"rows": None, "columns": None, "size_bytes": None, "last_modified": None, "comment": None}
    dbx = client()
    quoted = catalog.quote_table(full_name)
    try:
        out["rows"] = dbx.execute(f"SELECT COUNT(*) FROM {quoted}").rows[0][0]
        detail = dbx.execute(f"DESCRIBE DETAIL {quoted}").dicts()[0]
        out.update(size_bytes=detail.get("sizeInBytes"), last_modified=detail.get("lastModified"),
                   comment=detail.get("description"))
        out["columns"] = len(catalog.describe(full_name))
    except DatabricksError:
        pass
    return out


def connection_out(c: dict, secret_mask: str) -> dict:
    """A connection as the UI sees it: secret masked, plus the parent models that use it."""
    parents = db.query("SELECT id, name FROM models WHERE kind = 'parent' AND connection_id = ? ORDER BY id", (c["id"],))
    return {**{k: c[k] for k in ("id", "name", "host", "auth_type", "client_id", "warehouse_id", "state_schema", "created_at")},
            "secret": secret_mask if c["secret"] else "", "parents": parents, "is_default": c["id"] == connection.default_id()}


def sources() -> dict:
    out = []
    for c in connection.all_connections():
        connection.use(c["id"])
        item = connection_out(c, "set")
        try:
            item["warehouse"] = client(c["id"]).warehouse_info()
            item["ok"] = True
        except Exception as e:  # noqa: BLE001
            item.update(ok=False, error=str(e), warehouse=None)
        item["datasets"] = _datasets(c["id"]) if item["ok"] else []
        out.append(item)
    return {"connections": out}


def _datasets(cid: int) -> list[dict]:
    models = db.query("SELECT m.id, m.name, m.kind, m.table_ref, m.query_type FROM models m "
                      "LEFT JOIN models p ON p.id = m.parent_id "
                      "WHERE COALESCE(p.connection_id, m.connection_id) = ? ORDER BY m.id", (cid,))
    used: dict[str, list] = {}
    for m in models:
        if m["query_type"] != "sql":
            used.setdefault(m["table_ref"], []).append({"model_id": m["id"], "model_name": m["name"], "kind": m["kind"]})
    datasets: dict[tuple, list] = {}
    for ref in sorted(used):
        cat, sch, _ = ref.split(".")
        datasets.setdefault((cat, sch), [])
    out = []
    for (cat, sch) in datasets:
        tables = []
        try:
            names = catalog.list_tables(cat, sch)
        except Exception:  # noqa: BLE001
            names = []
        for name in names:
            full = f"{cat}.{sch}.{name}"
            tables.append({"name": name, "full_name": full, **_table_stats(full), "used_by": used.get(full, [])})
        out.append({"catalog": cat, "schema": sch, "tables": tables})
    return out


def _datasets_refs(cid: int) -> list[dict]:
    return db.query("SELECT m.table_ref FROM models m LEFT JOIN models p ON p.id = m.parent_id "
                    "WHERE m.query_type != 'sql' AND COALESCE(p.connection_id, m.connection_id) = ?", (cid,))


# ---- overview --------------------------------------------------------------------

def overview() -> dict:
    count = lambda sql, args=(): db.one(sql, args)["n"]  # noqa: E731
    conns = connection.all_connections()
    src = {"ok": False, "warehouse": None, "host": connection.host(), "connections": len(conns), "connections_ok": 0,
           "datasets": 0, "tables": 0, "rows": 0}
    profiles = 0
    for c in conns:
        connection.use(c["id"])
        try:
            wh = client(c["id"]).warehouse_info()
        except Exception:  # noqa: BLE001
            continue
        src["connections_ok"] += 1
        if c["id"] == connection.default_id():
            src.update(warehouse=wh, host=c["host"])
        refs = {r["table_ref"] for r in _datasets_refs(c["id"])}
        src["datasets"] += len({r.rsplit(".", 1)[0] for r in refs})
        src["tables"] += len(refs)
        for ref in refs:
            try:
                src["rows"] += client(c["id"]).execute(f"SELECT COUNT(*) FROM {catalog.quote_table(ref)}").rows[0][0]
            except DatabricksError:
                continue
        for p in db.query("SELECT * FROM models WHERE kind = 'parent' AND connection_id = ?", (c["id"],)):
            try:
                profiles += client(c["id"]).execute(f"SELECT COUNT(*) FROM {source(p)}").rows[0][0]
            except (DatabricksError, CompileError):
                pass
    src["ok"] = bool(conns) and src["connections_ok"] == len(conns)
    dests = db.query("SELECT * FROM destinations ORDER BY id")
    unconfigured = [{"id": d["id"], "name": d["name"], "type": d["type"]} for d in dests if missing_fields(d)]
    largest = db.one("SELECT id, name, last_size AS size FROM audiences WHERE last_size IS NOT NULL ORDER BY last_size DESC LIMIT 1")
    last_run = db.one("SELECT status, started_at FROM sync_runs ORDER BY id DESC LIMIT 1")
    return {
        "source": src,
        "schema": {"parents": count("SELECT COUNT(*) AS n FROM models WHERE kind = 'parent'"),
                   "related": count("SELECT COUNT(*) AS n FROM models WHERE kind = 'related'"),
                   "events": count("SELECT COUNT(*) AS n FROM models WHERE kind = 'event'"),
                   "parent_names": [p["name"] for p in db.query("SELECT name FROM models WHERE kind = 'parent' ORDER BY id")]},
        "modeling": {"traits": count("SELECT COUNT(*) AS n FROM traits"), "profiles": profiles},
        "segmentation": {"audiences": count("SELECT COUNT(*) AS n FROM audiences"), "largest": largest},
        "activation": {"destinations": len(dests), "configured_destinations": len(dests) - len(unconfigured),
                       "unconfigured": unconfigured, "syncs": count("SELECT COUNT(*) AS n FROM syncs"),
                       "records_synced": count("SELECT COALESCE(SUM(added + changed + removed), 0) AS n FROM sync_runs"),
                       "last_run": last_run},
    }


# ---- profiles --------------------------------------------------------------------

def _display(model: dict, column: str) -> str:
    return column_setting(model, column, "alias") or column.replace("_", " ").replace(".", " ").title()


def _masked(model: dict, column: str) -> bool:
    return column_setting(model, column, "privacy", "unreviewed") in MASKED


def _label_sql(parent: dict, column: str | None, alias: str = "p") -> str:
    if not column:
        return "CAST(NULL AS STRING)"
    if _masked(parent, column):
        return "'••••'"
    return f"CAST({quote_column(column, alias)} AS STRING)"


def search_profiles(q: str, parent_id: int | None) -> dict:
    schema = audiences.load_schema(parent_id)
    parent = schema["parent"]
    if not parent:
        raise CompileError("Set up a parent model first")
    connection.use_parent(parent["id"])
    pk = quote_column(parent["primary_key"], "p")
    label_col = parent.get("label_column") or parent["primary_key"]
    second = parent.get("secondary_label")
    params, where = [], ""
    if q.strip():
        searchable = [pk] + [quote_column(c, "p") for c in (label_col, second) if c and not _masked(parent, c)]
        where = "WHERE " + " OR ".join(f"lower(CAST({c} AS STRING)) LIKE :q" for c in searchable)
        params.append({"name": "q", "value": f"%{q.strip().lower()}%", "type": "STRING"})
    sql = (f"SELECT CAST({pk} AS STRING), {_label_sql(parent, label_col)}, {_label_sql(parent, second)} "
           f"FROM {source(parent)} p {where} ORDER BY 1 LIMIT 20")
    rows = client().execute(sql, params).rows
    return {"parent": {k: parent.get(k) for k in ("id", "name", "primary_key", "label_column", "secondary_label")},
            "results": [{"id": r[0], "label": r[1] or r[0], "secondary": r[2]} for r in rows]}


def profile(profile_id: str, parent_id: int | None) -> dict:
    comp = audiences.compiler(parent_id)
    parent = comp.parent
    pk = quote_column(parent["primary_key"], comp.alias)
    dbx = client()
    res = dbx.execute(f"SELECT * FROM {source(parent)} p WHERE CAST(p.{quote_ident(parent['primary_key'])} AS STRING) = :id LIMIT 1",
                      [{"name": "id", "value": profile_id, "type": "STRING"}])
    if not res.rows:
        raise CompileError(f"No {parent['name'].lower()} with ID {profile_id}")
    row = dict(zip(res.column_names, res.rows[0]))
    types = {c["name"]: c["type"] for c in parent["columns"]}
    attributes = [{"name": k, "label": _display(parent, k), "type": types.get(k, "string"),
                   "value": "••••" if _masked(parent, k) else v}
                  for k, v in row.items() if not column_setting(parent, k, "hidden")]

    # traits + audience memberships in one query, evaluated for this person only
    selects, keys = [], []
    for t in comp.traits.values():
        try:
            selects.append(comp.parent_column(f"trait.{t['id']}")[0]); keys.append(("trait", t))
        except CompileError:
            pass
    aud_rows = db.query("SELECT id, name, definition FROM audiences WHERE parent_id = ? ORDER BY name", (parent["id"],))
    for a in aud_rows:
        try:
            selects.append(f"({comp.node(a['definition'])})"); keys.append(("audience", a))
        except CompileError:
            pass
    traits, memberships = [], []
    if selects:
        idp = comp.param(profile_id)
        c = comp.wrap(f"SELECT {', '.join(selects)} FROM {comp.parent_from()} WHERE CAST({pk} AS STRING) = {idp}")
        values = dbx.execute(c.sql, c.params).rows[0]
        for (kind, item), value in zip(keys, values):
            if kind == "trait":
                traits.append({"id": item["id"], "name": item["name"], "type": trait_type(item["method"], item["config"], comp), "value": value})
            else:
                memberships.append({"id": item["id"], "name": item["name"], "member": bool(value)})

    events = []
    for m in comp.models.values():
        if m["kind"] != "event" and not m.get("timestamp_column"):
            continue
        conds, params = [], []
        for i, k in enumerate(join_keys(m, parent)):
            conds.append(f"CAST({quote_column(k['model'], 'e')} AS STRING) = :k{i}")
            params.append({"name": f"k{i}", "value": None if row.get(k["parent"]) is None else str(row.get(k["parent"])), "type": "STRING"})
        visible = [c["name"] for c in m["columns"] if not column_setting(m, c["name"], "hidden") and "." not in c["name"]]
        cols = ", ".join(("'••••'" if _masked(m, c) else quote_column(c, "e")) + f" AS {quote_ident(c)}" for c in visible)
        order = f" ORDER BY {quote_column(m['timestamp_column'], 'e')} DESC" if m.get("timestamp_column") else ""
        try:
            r = dbx.execute(f"SELECT {cols} FROM {source(m)} e WHERE {' AND '.join(conds)}{order} LIMIT 10", params)
        except DatabricksError:
            continue
        events.append({"model_id": m["id"], "model_name": m["name"], "kind": m["kind"], "timestamp_column": m.get("timestamp_column"),
                       "columns": r.column_names, "rows": r.rows})

    label_col = parent.get("label_column") or parent["primary_key"]
    second = parent.get("secondary_label")
    return {"id": profile_id, "parent": {"id": parent["id"], "name": parent["name"]},
            "label": "••••" if _masked(parent, label_col) else row.get(label_col),
            "secondary": None if not second else ("••••" if _masked(parent, second) else row.get(second)),
            "attributes": attributes, "traits": traits, "audiences": memberships, "events": events}
