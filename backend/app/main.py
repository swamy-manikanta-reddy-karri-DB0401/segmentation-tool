from __future__ import annotations

import asyncio
import re
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import audiences, catalog, config, connection, db, destinations, insights, scheduler, sync_engine
from .compiler import CompileError, Compiler, source, trait_type
from .databricks import DatabricksError, client, reset_client
from .scheduler import ScheduleError
from .sync_engine import SyncError

MASK = "••••••••"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PRIVACY = {"unreviewed", "approved", "blocked", "redacted", "sync_only", "sync_blocked"}
RELATIONSHIPS = {"1:many", "1:1", "many:1"}
TRAIT_METHODS = {"aggregation", "count", "occurrence", "list", "sql_aggregation", "sql_formula"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.conn()
    connection.seed()
    scheduler.recover_interrupted_runs()
    task = asyncio.create_task(scheduler.loop())
    yield
    task.cancel()


app = FastAPI(title="MediaMint CDP", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(CompileError)
@app.exception_handler(SyncError)
@app.exception_handler(ScheduleError)
@app.exception_handler(ValueError)
async def bad_request(_: Request, exc: Exception):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(DatabricksError)
async def warehouse_error(_: Request, exc: Exception):
    return JSONResponse({"detail": f"Databricks: {exc}"}, status_code=502)


def _get(table: str, id_: int) -> dict:
    row = db.one(f"SELECT * FROM {table} WHERE id = ?", (id_,))
    if not row:
        raise HTTPException(404, f"{table.rstrip('s').replace('_', ' ').capitalize()} {id_} not found")
    return row


def _pid(value) -> int:
    pid = int(value or audiences.default_parent_id() or 0)
    if not pid:
        raise ValueError("Set up a parent model first")
    return pid


# ---- connection & settings ---------------------------------------------------

@app.get("/api/connection")
def connection_status():
    info = {"host": connection.host(), "state_schema": connection.state_schema() if connection.current_id() else ""}
    try:
        info["warehouse"] = client().warehouse_info()
        info["ok"] = True
    except Exception as e:  # noqa: BLE001
        info["ok"], info["error"] = False, str(e)
    return info


# ---- source connections ------------------------------------------------------------

def _conn_values(body: dict, cid: int | None = None) -> dict:
    """Form values; a masked secret means "keep the stored one"."""
    values = {k: body.get(k) for k in connection.FIELDS}
    if (not values["secret"] or values["secret"] == MASK) and (cid or body.get("id")):
        values["secret"] = connection.get(int(cid or body["id"]))["secret"]
    return values


@app.get("/api/connections")
def list_connections():
    return [insights.connection_out(c, MASK) for c in connection.all_connections()]


@app.post("/api/connections/warehouses")
def connection_warehouses(body: dict = Body(...)):
    return connection.list_warehouses(_conn_values(body))


@app.post("/api/connections/test")
def test_connection(body: dict = Body(...)):
    return connection.test(_conn_values(body))


@app.post("/api/connections")
def create_connection(body: dict = Body(...)):
    values = connection.normalize(_conn_values(body))
    result = connection.test(values)
    if not result["ok"]:
        raise ValueError(f"Connection test failed: {result['message']}")
    cid = db.insert("connections", {**values, "created_at": db.now()})
    return {**insights.connection_out(_get("connections", cid), MASK), "test": result}


@app.put("/api/connections/{cid}")
def update_connection(cid: int, body: dict = Body(...)):
    _get("connections", cid)
    values = connection.normalize(_conn_values(body, cid))
    result = connection.test(values)
    if not result["ok"]:
        raise ValueError(f"Connection test failed: {result['message']}")
    db.update("connections", cid, values)
    reset_client(cid)
    catalog.clear_cache()
    return {**insights.connection_out(_get("connections", cid), MASK), "test": result}


@app.delete("/api/connections/{cid}")
def delete_connection(cid: int):
    _get("connections", cid)
    used = db.query("SELECT name FROM models WHERE kind = 'parent' AND connection_id = ?", (cid,))
    if used:
        raise ValueError(f"Parent models use this connection ({', '.join(u['name'] for u in used)}). Move or delete them first.")
    db.delete("connections", cid)
    reset_client(cid)
    return {"ok": True}


@app.get("/api/settings")
def get_settings():
    return {"as_of_date": db.get_setting("as_of_date", ""), "null_behavior": db.get_setting("null_behavior", "value"),
            "audience_snapshots": bool(db.get_setting("audience_snapshots", False)),
            "parent_as_of_date": db.get_setting("parent_as_of_date", {}) or {},
            "snapshot_table": f"{connection.state_schema()}.audience_membership" if connection.current_id() else ""}


@app.put("/api/settings")
def put_settings(body: dict = Body(...)):
    if "as_of_date" in body:
        as_of = (body.get("as_of_date") or "").strip()
        if as_of and not DATE_RE.match(as_of):
            raise ValueError("as_of_date must be YYYY-MM-DD or empty")
        db.set_setting("as_of_date", as_of)
    if "null_behavior" in body:
        if body["null_behavior"] not in ("value", "special"):
            raise ValueError("null_behavior must be 'value' or 'special'")
        db.set_setting("null_behavior", body["null_behavior"])
    if "parent_as_of_date" in body:
        # {"parent_id": .., "value": "YYYY-MM-DD" | "" (today) | null (use workspace default)}
        item = body["parent_as_of_date"] or {}
        value = item.get("value")
        if value and not DATE_RE.match(value):
            raise ValueError("Analysis date must be YYYY-MM-DD")
        current = dict(db.get_setting("parent_as_of_date", {}) or {})
        if value is None:
            current.pop(str(item.get("parent_id")), None)
        else:
            current[str(item.get("parent_id"))] = value
        db.set_setting("parent_as_of_date", current)
    if "audience_snapshots" in body:
        db.set_setting("audience_snapshots", bool(body["audience_snapshots"]))
    return get_settings()


# ---- overview, sources, profiles -------------------------------------------------

@app.get("/api/overview")
def overview():
    return insights.overview()


@app.get("/api/sources")
def sources():
    return insights.sources()


@app.get("/api/profiles/search")
def search_profiles(q: str = "", parent_id: int | None = None):
    return insights.search_profiles(q, parent_id)


@app.get("/api/profiles/{profile_id}")
def get_profile(profile_id: str, parent_id: int | None = None):
    return insights.profile(profile_id, parent_id)


# ---- catalog browsing ----------------------------------------------------------

@app.get("/api/catalog/catalogs")
def catalogs(connection_id: int | None = None):
    connection.use(connection_id)
    return catalog.list_catalogs()


@app.get("/api/catalog/schemas")
def schemas(catalog_name: str, connection_id: int | None = None):
    connection.use(connection_id)
    return catalog.list_schemas(catalog_name)


@app.get("/api/catalog/tables")
def tables(catalog_name: str, schema: str, connection_id: int | None = None):
    connection.use(connection_id)
    return catalog.list_tables(catalog_name, schema)


@app.get("/api/catalog/columns")
def columns(table: str, connection_id: int | None = None):
    connection.use(connection_id)
    return catalog.describe(table)


@app.get("/api/catalog/preview")
def preview_table(table: str, connection_id: int | None = None):
    connection.use(connection_id)
    res = client().execute(f"SELECT * FROM {catalog.quote_table(table)} LIMIT 50")
    return {"columns": res.column_names, "rows": res.rows}


@app.post("/api/catalog/describe-sql")
def describe_sql(body: dict = Body(...)):
    connection.use(body.get("connection_id"))
    return catalog.describe_sql(body.get("sql", ""))


@app.post("/api/catalog/preview-sql")
def preview_sql(body: dict = Body(...)):
    connection.use(body.get("connection_id"))
    src = source({"name": "query", "query_type": "sql", "sql": body.get("sql", "")})
    res = client().execute(f"SELECT * FROM {src} LIMIT 20")
    return {"columns": res.column_names, "rows": res.rows}


# ---- schema models (parent / related / event) ----------------------------------

MODEL_FIELDS = ("kind", "connection_id", "name", "description", "table_ref", "query_type", "sql", "primary_key", "label_column",
                "secondary_label", "parent_id", "relationship", "join_keys", "merge_columns", "column_settings",
                "timestamp_column", "event_name_column")


def _validate_model(m: dict) -> dict:
    if m["kind"] == "parent":
        m["connection_id"] = int(m.get("connection_id") or 0) or connection.default_id()
        if not m["connection_id"]:
            raise ValueError("Add a Databricks connection on the Sources page first")
        connection.use(m["connection_id"])
    else:
        m["connection_id"] = None
        connection.use_parent(m.get("parent_id"))
    if m.get("query_type") == "sql":
        cols = catalog.describe_sql(m.get("sql") or "")
        m["table_ref"] = m.get("table_ref") or "sql"
    else:
        m["query_type"] = "table"
        cols = catalog.describe(m["table_ref"], refresh=True)
    names = {c["name"] for c in cols}
    for f in ("primary_key", "label_column", "secondary_label", "timestamp_column", "event_name_column"):
        if m.get(f) and m[f] not in names:
            raise ValueError(f"{f.replace('_', ' ').capitalize()} {m[f]!r} is not a column of this model")
    m["column_settings"] = {k: v for k, v in (m.get("column_settings") or {}).items() if k in names}
    for col, st in m["column_settings"].items():
        if st.get("privacy", "unreviewed") not in PRIVACY:
            raise ValueError(f"Unknown privacy level for {col}")
    if m["kind"] == "parent":
        if not m.get("primary_key"):
            raise ValueError("The parent model needs a primary key")
        m.update(parent_id=None, join_keys=[], merge_columns=[], relationship=None)
    else:
        parent = _get("models", int(m.get("parent_id") or 0))
        if parent["kind"] != "parent":
            raise ValueError("parent_id must reference a parent model")
        keys = [k for k in (m.get("join_keys") or []) if k.get("parent") and k.get("model")]
        if not keys:
            raise ValueError("Choose at least one join key linking this model to the parent")
        parent_cols = {c["name"] for c in parent["columns"]}
        for k in keys:
            if k["parent"] not in parent_cols or k["model"] not in names:
                raise ValueError(f"Join key {k['parent']} → {k['model']} doesn't match the columns")
        m["join_keys"] = keys
        m["foreign_key"], m["parent_key"] = keys[0]["model"], keys[0]["parent"]
        m["relationship"] = m.get("relationship") or "1:many"
        if m["relationship"] not in RELATIONSHIPS:
            raise ValueError("Relationship must be 1:many, 1:1 or many:1")
        merges = [c for c in (m.get("merge_columns") or []) if c in names]
        if merges and m["relationship"] == "1:many":
            raise ValueError("Columns can only be merged from 1:1 or many:1 relationships")
        m["merge_columns"] = merges
        if m["kind"] == "event" and not m.get("timestamp_column"):
            raise ValueError("Event models need a timestamp column")
    m["columns"] = cols
    m["description"] = m.get("description") or ""
    m["name"] = (m.get("name") or "").strip() or (m["table_ref"].split(".")[-1] if m["query_type"] == "table" else "Query")
    return m


@app.get("/api/parents")
def list_parents():
    return audiences.parents()


@app.get("/api/models")
def list_models():
    return db.query("SELECT * FROM models ORDER BY kind = 'parent' DESC, id")


@app.get("/api/schema")
def get_schema(parent_id: int | None = None):
    s = audiences.load_schema(parent_id)
    if not s["parent"]:
        return {"parent": None, "models": [], "traits": [], "virtual_columns": [], "parents": audiences.parents()}
    comp = Compiler(s)
    virtual = []
    for t in s["traits"].values():
        try:
            ttype = trait_type(t["method"], t["config"], comp)
        except CompileError:
            ttype = "string"
        virtual.append({"name": f"trait.{t['id']}", "label": t["name"], "group": "Traits",
                        "description": t["description"], "type": ttype})
    for mid, m in s["models"].items():
        for col in m.get("merge_columns") or []:
            info = next((c for c in m["columns"] if c["name"] == col), {"type": "string"})
            virtual.append({"name": f"merged.{mid}.{col}", "label": f"{m['name']} → {col}",
                            "group": f"Merged from {m['name']}", "type": info["type"], "description": ""})
    return {"parent": s["parent"], "models": list(s["models"].values()), "traits": list(s["traits"].values()),
            "virtual_columns": virtual, "parents": audiences.parents()}


@app.post("/api/models")
def create_model(body: dict = Body(...)):
    m = {k: body.get(k) for k in MODEL_FIELDS}
    if m["kind"] not in ("parent", "related", "event"):
        raise ValueError("kind must be parent, related or event")
    if m["kind"] != "parent":
        m["parent_id"] = _pid(m.get("parent_id"))
    m = _validate_model(m)
    m["created_at"] = db.now()
    return _get("models", db.insert("models", m))


@app.put("/api/models/{model_id}")
def update_model(model_id: int, body: dict = Body(...)):
    current = _get("models", model_id)
    m = {k: body[k] if k in body else current.get(k) for k in MODEL_FIELDS}
    m["kind"] = current["kind"]
    if current["kind"] != "parent":
        m["parent_id"] = current["parent_id"]
    db.update("models", model_id, _validate_model(m))
    return _get("models", model_id)


@app.delete("/api/models/{model_id}")
def delete_model(model_id: int):
    m = _get("models", model_id)
    if m["kind"] == "parent" and db.one("SELECT id FROM audiences WHERE parent_id = ?", (model_id,)):
        raise ValueError("Audiences are built on this parent model. Delete them first.")
    db.delete("models", model_id)
    return {"ok": True}


@app.get("/api/models/{model_id}/values")
def model_values(model_id: int, column: str, q: str = ""):
    m = _get("models", model_id)
    connection.use_model(model_id)
    settings = (m.get("column_settings") or {}).get(column) or {}
    if settings.get("suggestions") is False or settings.get("privacy") in ("redacted", "blocked", "sync_only"):
        return []
    return catalog.values_for(source(m), m["columns"], column, q)


# ---- traits -----------------------------------------------------------------------

def _validate_trait(body: dict, parent_id: int) -> dict:
    name = (body.get("name") or "").strip()
    if not name:
        raise ValueError("Give the trait a name")
    if body.get("method") not in TRAIT_METHODS:
        raise ValueError("Choose a calculation method")
    audiences.compiler(parent_id).trait_expr(body["method"], body.get("config") or {}, "validate_trait")
    return {"name": name, "description": body.get("description", ""), "method": body["method"],
            "config": body.get("config") or {}}


@app.get("/api/traits")
def list_traits(parent_id: int | None = None):
    return db.query("SELECT * FROM traits WHERE parent_id = ? ORDER BY name", (_pid(parent_id),))


@app.post("/api/traits")
def create_trait(body: dict = Body(...)):
    pid = _pid(body.get("parent_id"))
    values = _validate_trait(body, pid)
    ts = db.now()
    return _get("traits", db.insert("traits", {**values, "parent_id": pid, "created_at": ts, "updated_at": ts}))


@app.put("/api/traits/{trait_id}")
def update_trait(trait_id: int, body: dict = Body(...)):
    t = _get("traits", trait_id)
    db.update("traits", trait_id, {**_validate_trait({**t, **body}, t["parent_id"]), "updated_at": db.now()})
    return _get("traits", trait_id)


@app.delete("/api/traits/{trait_id}")
def delete_trait(trait_id: int):
    _get("traits", trait_id)
    db.delete("traits", trait_id)
    return {"ok": True}


@app.post("/api/traits/preview")
def preview_trait(body: dict = Body(...)):
    return audiences.trait_preview(body.get("method"), body.get("config") or {}, body.get("parent_id"))


# ---- audiences ------------------------------------------------------------------

@app.get("/api/audiences")
def list_audiences(parent_id: int | None = None):
    sql = ("SELECT a.*, m.name AS parent_name, (SELECT COUNT(*) FROM syncs s WHERE s.audience_id = a.id) AS sync_count "
           "FROM audiences a LEFT JOIN models m ON m.id = a.parent_id")
    if parent_id:
        return db.query(sql + " WHERE a.parent_id = ? ORDER BY a.updated_at DESC", (parent_id,))
    return db.query(sql + " ORDER BY a.updated_at DESC")


@app.get("/api/audiences/{audience_id}")
def get_audience(audience_id: int):
    return _get("audiences", audience_id)


def _validate_splits(splits: dict | None) -> dict:
    splits = splits or {}
    if not splits.get("enabled"):
        return {"enabled": False, "groups": splits.get("groups") or []}
    groups = [g for g in splits.get("groups") or [] if (g.get("name") or "").strip()]
    if len(groups) < 2 or sum(int(g.get("percent") or 0) for g in groups) != 100:
        raise ValueError("Splits need at least two groups whose percentages add up to 100")
    if len({g["name"].strip() for g in groups}) != len(groups):
        raise ValueError("Split group names must be unique")
    return {"enabled": True, "groups": [{"name": g["name"].strip(), "percent": int(g["percent"])} for g in groups]}


@app.post("/api/audiences")
def create_audience(body: dict = Body(...)):
    if not (body.get("name") or "").strip():
        raise ValueError("Give the audience a name")
    pid = _pid(body.get("parent_id"))
    audiences.compile_definition(body.get("definition") or {}, parent_id=pid)  # validate
    ts = db.now()
    id_ = db.insert("audiences", {"name": body["name"].strip(), "description": body.get("description", ""), "parent_id": pid,
                                  "definition": body.get("definition") or {}, "splits": _validate_splits(body.get("splits")),
                                  "created_at": ts, "updated_at": ts, "last_size": body.get("last_size"),
                                  "size_updated_at": ts if body.get("last_size") is not None else None})
    return _get("audiences", id_)


@app.put("/api/audiences/{audience_id}")
def update_audience(audience_id: int, body: dict = Body(...)):
    a = _get("audiences", audience_id)
    values = {k: body[k] for k in ("name", "description", "definition") if k in body}
    if "definition" in values:
        audiences.compile_definition(values["definition"], parent_id=a["parent_id"])
    if "splits" in body:
        values["splits"] = _validate_splits(body["splits"])
    if body.get("last_size") is not None:
        values.update(last_size=body["last_size"], size_updated_at=db.now())
    values["updated_at"] = db.now()
    db.update("audiences", audience_id, values)
    return _get("audiences", audience_id)


@app.delete("/api/audiences/{audience_id}")
def delete_audience(audience_id: int):
    if db.one("SELECT id FROM syncs WHERE audience_id = ?", (audience_id,)):
        raise ValueError("This audience has syncs. Delete them first.")
    db.delete("audiences", audience_id)
    return {"ok": True}


@app.post("/api/audiences/compile")
def compile_audience(body: dict = Body(...)):
    c = audiences.compile_definition(body.get("definition") or {}, parent_id=body.get("parent_id"))
    return {"sql": c.sql, "params": c.params}


@app.post("/api/audiences/calculate")
def calculate(body: dict = Body(...)):
    return audiences.calculate(body.get("definition") or {}, body.get("parent_id"))


@app.post("/api/audiences/breakdown")
def breakdown(body: dict = Body(...)):
    return audiences.breakdown(body.get("definition") or {}, body.get("column"), body.get("parent_id"),
                               body.get("source", "property"), body.get("model_id"), body.get("metric", "users"))


@app.post("/api/audiences/overlap")
def overlap(body: dict = Body(...)):
    return audiences.overlap(body.get("definition") or {}, int(body["audience_id"]), body.get("parent_id"))


@app.post("/api/audiences/preview")
def preview(body: dict = Body(...)):
    return audiences.preview(body.get("definition") or {}, body.get("parent_id"))


# ---- destinations ------------------------------------------------------------------

def _secret_fields(type_: str) -> set[str]:
    return {f.name for f in destinations.get(type_).config_fields if f.type == "password"}


def _mask(dest: dict) -> dict:
    dest["missing_fields"] = insights.missing_fields(dest)
    dest["configured"] = not dest["missing_fields"]
    secrets = _secret_fields(dest["type"])
    dest["config"] = {k: (MASK if k in secrets and v else v) for k, v in dest["config"].items()}
    return dest


def _merge_secrets(new: dict, old: dict) -> dict:
    return {k: (old.get(k) if v == MASK else v) for k, v in new.items()}


@app.get("/api/destination-types")
def destination_types():
    return [cls.describe() for cls in destinations.REGISTRY.values()]


@app.get("/api/destinations")
def list_destinations():
    rows = db.query("SELECT d.*, (SELECT COUNT(*) FROM syncs s WHERE s.destination_id = d.id) AS sync_count "
                    "FROM destinations d ORDER BY id DESC")
    return [_mask(r) for r in rows]


@app.post("/api/destinations")
def create_destination(body: dict = Body(...)):
    destinations.get(body.get("type"))
    if not (body.get("name") or "").strip():
        raise ValueError("Give the destination a name")
    id_ = db.insert("destinations", {"name": body["name"].strip(), "type": body["type"],
                                     "config": body.get("config") or {}, "created_at": db.now()})
    return _mask(_get("destinations", id_))


@app.put("/api/destinations/{dest_id}")
def update_destination(dest_id: int, body: dict = Body(...)):
    current = _get("destinations", dest_id)
    values = {}
    if "name" in body:
        values["name"] = body["name"]
    if "config" in body:
        values["config"] = _merge_secrets(body["config"], current["config"])
    db.update("destinations", dest_id, values)
    return _mask(_get("destinations", dest_id))


@app.delete("/api/destinations/{dest_id}")
def delete_destination(dest_id: int):
    if db.one("SELECT id FROM syncs WHERE destination_id = ?", (dest_id,)):
        raise ValueError("This destination is used by syncs. Delete them first.")
    db.delete("destinations", dest_id)
    return {"ok": True}


@app.post("/api/destinations/test")
def test_destination(body: dict = Body(...)):
    cfg = body.get("config") or {}
    if body.get("id"):
        cfg = _merge_secrets(cfg, _get("destinations", body["id"])["config"])
    dest = destinations.get(body["type"])(cfg)
    try:
        return {"ok": True, "message": dest.test()}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": str(e)}
    finally:
        dest.close()


# ---- governance: destination rules & priority lists -------------------------------------

@app.get("/api/destination-rules")
def list_rules(parent_id: int | None = None):
    sql = ("SELECT r.*, d.name AS destination_name, d.type AS destination_type FROM destination_rules r "
           "JOIN destinations d ON d.id = r.destination_id")
    if parent_id:
        return db.query(sql + " WHERE r.parent_id = ? ORDER BY r.id", (parent_id,))
    return db.query(sql + " ORDER BY r.id")


def _rule_values(body: dict) -> dict:
    pid = _pid(body.get("parent_id"))
    _get("destinations", int(body["destination_id"]))
    definition = body.get("definition") or {"type": "group", "op": "and", "conditions": []}
    if not definition.get("conditions"):
        raise ValueError("Add at least one filter to the rule")
    audiences.compile_definition(definition, parent_id=pid)
    return {"parent_id": pid, "destination_id": int(body["destination_id"]),
            "name": (body.get("name") or "").strip() or "Destination rule", "definition": definition}


@app.post("/api/destination-rules")
def create_rule(body: dict = Body(...)):
    return _get("destination_rules", db.insert("destination_rules", {**_rule_values(body), "created_at": db.now()}))


@app.put("/api/destination-rules/{rule_id}")
def update_rule(rule_id: int, body: dict = Body(...)):
    current = _get("destination_rules", rule_id)
    db.update("destination_rules", rule_id, _rule_values({**current, **body}))
    return _get("destination_rules", rule_id)


@app.delete("/api/destination-rules/{rule_id}")
def delete_rule(rule_id: int):
    db.delete("destination_rules", rule_id)
    return {"ok": True}


@app.post("/api/destination-rules/preview")
def preview_rule(body: dict = Body(...)):
    """How many audience members a destination would receive after its rules."""
    a_def = body.get("definition") or {"type": "group", "op": "and", "conditions": []}
    pid = _pid(body.get("parent_id"))
    rules = [r["definition"] for r in db.query("SELECT definition FROM destination_rules WHERE destination_id = ? AND parent_id = ?",
                                               (int(body["destination_id"]), pid))]
    full = {"type": "group", "op": "and", "conditions": [a_def, *rules]}
    return {"audience": audiences.size(a_def, pid), "after_rules": audiences.size(full, pid), "rules": len(rules)}


@app.get("/api/priority-lists")
def list_priority_lists():
    return db.query("SELECT * FROM priority_lists ORDER BY id")


def _priority_values(body: dict, list_id: int | None = None) -> dict:
    pid = _pid(body.get("parent_id"))
    ids = [int(x) for x in (body.get("config") or {}).get("audience_ids", [])]
    if len(set(ids)) != len(ids):
        raise ValueError("An audience can only appear once in a list")
    for aid in ids:
        a = _get("audiences", aid)
        if a["parent_id"] != pid:
            raise ValueError(f"“{a['name']}” is built on a different parent model")
        for other in db.query("SELECT id, name, config FROM priority_lists WHERE id != ?", (list_id or 0,)):
            if aid in [int(x) for x in other["config"].get("audience_ids", [])]:
                raise ValueError(f"“{a['name']}” is already in the priority list “{other['name']}”")
    return {"parent_id": pid, "name": (body.get("name") or "").strip() or "Priority list", "config": {"audience_ids": ids}}


@app.post("/api/priority-lists")
def create_priority_list(body: dict = Body(...)):
    return _get("priority_lists", db.insert("priority_lists", {**_priority_values(body), "created_at": db.now()}))


@app.put("/api/priority-lists/{list_id}")
def update_priority_list(list_id: int, body: dict = Body(...)):
    current = _get("priority_lists", list_id)
    db.update("priority_lists", list_id, _priority_values({**current, **body}, list_id))
    return _get("priority_lists", list_id)


@app.delete("/api/priority-lists/{list_id}")
def delete_priority_list(list_id: int):
    db.delete("priority_lists", list_id)
    return {"ok": True}


# ---- sync templates -------------------------------------------------------------------

@app.get("/api/sync-templates")
def list_templates(destination_id: int | None = None):
    if destination_id:
        return db.query("SELECT * FROM sync_templates WHERE destination_id = ? ORDER BY name", (destination_id,))
    return db.query("SELECT * FROM sync_templates ORDER BY name")


@app.post("/api/sync-templates")
def create_template(body: dict = Body(...)):
    dest = _get("destinations", int(body["destination_id"]))
    cfg = sync_engine.normalize_config(body.get("config") or {}, destinations.get(dest["type"]))
    name = (body.get("name") or "").strip()
    if not name:
        raise ValueError("Give the template a name")
    return _get("sync_templates", db.insert("sync_templates", {"name": name, "destination_id": dest["id"],
                                                               "config": cfg, "created_at": db.now()}))


@app.delete("/api/sync-templates/{template_id}")
def delete_template(template_id: int):
    db.delete("sync_templates", template_id)
    return {"ok": True}


# ---- syncs -----------------------------------------------------------------------------

SYNC_LIST_SQL = """
SELECT s.*, a.name AS audience_name, a.parent_id AS parent_id, d.name AS destination_name, d.type AS destination_type,
  (SELECT status FROM sync_runs r WHERE r.sync_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_status
FROM syncs s JOIN audiences a ON a.id = s.audience_id JOIN destinations d ON d.id = s.destination_id
"""


def _sync_out(s: dict) -> dict:
    s["running"] = sync_engine.is_running(s["id"])
    s["destination_configured"] = insights.destination_configured(s["destination_id"])
    s["config"] = sync_engine.normalize_config(s["config"], destinations.get(s["destination_type"]))
    return s


@app.get("/api/syncs")
def list_syncs(audience_id: int | None = None):
    if audience_id:
        rows = db.query(SYNC_LIST_SQL + " WHERE s.audience_id = ? ORDER BY s.id DESC", (audience_id,))
    else:
        rows = db.query(SYNC_LIST_SQL + " ORDER BY s.id DESC")
    return [_sync_out(r) for r in rows]


@app.get("/api/syncs/{sync_id}")
def get_sync(sync_id: int):
    row = db.one(SYNC_LIST_SQL + " WHERE s.id = ?", (sync_id,))
    if not row:
        raise HTTPException(404, "Sync not found")
    return _sync_out(row)


def _validate_sync(body: dict) -> dict:
    audience = _get("audiences", int(body["audience_id"]))
    dest = _get("destinations", int(body["destination_id"]))
    cfg = sync_engine.validate_config(body.get("config") or {}, destinations.get(dest["type"]),
                                      audiences.load_schema(audience["parent_id"]))
    group = cfg.get("split_group")
    if group:
        splits = audience.get("splits") or {}
        if not splits.get("enabled") or group not in [g["name"] for g in splits.get("groups", [])]:
            raise ValueError(f"Split group {group!r} doesn't exist on this audience")
    return {"audience_id": audience["id"], "destination_id": dest["id"],
            "name": (body.get("name") or "").strip() or "Untitled sync", "config": cfg,
            "schedule": scheduler.validate(body.get("schedule")), "enabled": 1 if body.get("enabled", True) else 0}


@app.post("/api/syncs")
def create_sync(body: dict = Body(...)):
    values = _validate_sync(body)
    values["created_at"] = db.now()
    sync_id = db.insert("syncs", values)
    scheduler.refresh_next(sync_id)
    return get_sync(sync_id)


@app.put("/api/syncs/{sync_id}")
def update_sync(sync_id: int, body: dict = Body(...)):
    current = _get("syncs", sync_id)
    db.update("syncs", sync_id, _validate_sync({**current, **body}))
    scheduler.refresh_next(sync_id)
    return get_sync(sync_id)


@app.delete("/api/syncs/{sync_id}")
def delete_sync(sync_id: int):
    _get("syncs", sync_id)
    if sync_engine.is_running(sync_id):
        raise ValueError("Wait for the current run to finish")
    try:
        sync_engine.drop_state(sync_id)
    except DatabricksError:
        pass  # best effort — app record is removed regardless
    db.delete("syncs", sync_id)
    return {"ok": True}


@app.post("/api/syncs/{sync_id}/run")
def run_sync(sync_id: int, body: dict = Body(default={})):
    sync = _get("syncs", sync_id)
    dest = _get("destinations", sync["destination_id"])
    missing = insights.missing_fields(dest)
    if missing:
        raise ValueError(f"Add {', '.join(missing)} to the {dest['name']} destination before running this sync")
    return {"run_id": sync_engine.start_run(sync_id, "manual", bool(body.get("full_resync")))}


@app.get("/api/syncs/{sync_id}/runs")
def sync_runs(sync_id: int):
    return db.query("SELECT id, sync_id, status, trigger, started_at, finished_at, audience_rows, added, changed, "
                    "removed, failed, error FROM sync_runs WHERE sync_id = ? ORDER BY id DESC LIMIT 50", (sync_id,))


@app.get("/api/runs/recent")
def recent_runs():
    return db.query("SELECT r.id, r.sync_id, r.status, r.trigger, r.started_at, r.finished_at, r.added, r.changed, "
                    "r.removed, r.failed, s.name AS sync_name FROM sync_runs r JOIN syncs s ON s.id = r.sync_id "
                    "ORDER BY r.id DESC LIMIT 15")


@app.get("/api/runs/{run_id}")
def get_run(run_id: int):
    return _get("sync_runs", run_id)


# ---- dashboard -----------------------------------------------------------------------

@app.get("/api/dashboard")
def dashboard():
    count = lambda t: db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"]  # noqa: E731
    return {
        "audiences": count("audiences"),
        "destinations": count("destinations"),
        "syncs": count("syncs"),
        "traits": count("traits"),
        "runs_24h": db.one("SELECT COUNT(*) AS n FROM sync_runs WHERE started_at >= datetime('now', '-1 day')")["n"],
        "rows_synced": db.one("SELECT COALESCE(SUM(added + changed + removed), 0) AS n FROM sync_runs")["n"],
        "schema_ready": db.one("SELECT id FROM models WHERE kind = 'parent'") is not None,
    }


# ---- built-in test inbox (a webhook receiver for demos) ---------------------------------

_inbox: deque = deque(maxlen=100)


@app.post("/api/inbox")
async def inbox_receive(request: Request):
    payload = await request.json()
    _inbox.appendleft({"received_at": db.now(), "action": payload.get("action"),
                       "audience": payload.get("audience"), "row_count": len(payload.get("rows") or []),
                       "sample": (payload.get("rows") or [])[:5]})
    return {"ok": True}


@app.get("/api/inbox")
def inbox_list():
    return list(_inbox)


@app.delete("/api/inbox")
def inbox_clear():
    _inbox.clear()
    return {"ok": True}


# ---- serve the built frontend (production mode) -----------------------------------------

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        file = DIST / path
        return FileResponse(file if path and file.is_file() else DIST / "index.html")
