from __future__ import annotations

import asyncio
import dataclasses
import os
import re
from datetime import datetime, timedelta, timezone
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import access, alerts, auth, targeting, audiences, catalog, config, connection, db, destinations, insights, routes_auth, scheduler, sync_engine
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
    access.seed()
    auth.seed()
    alerts.migrate_legacy()
    asyncio.get_running_loop().run_in_executor(None, access.check_group_lookup)  # self-test, result in settings
    scheduler.recover_interrupted_runs()
    task = asyncio.create_task(scheduler.loop())
    yield
    task.cancel()


app = FastAPI(title="MediaMint CDP", lifespan=lifespan, dependencies=[Depends(access.bind_user)])
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])
app.include_router(routes_auth.router)


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


def _visible_parents() -> list[dict]:
    u = access.current()
    return [p for p in audiences.parents() if u.sees(p.get("brand_id"))]


def _pid(value) -> int:
    """A parent model the caller may see: the one asked for, else their first visible one."""
    if value:
        pid = int(value)
        access.require_view(access.brand_of_parent(pid))
        return pid
    visible = _visible_parents()
    if not visible:
        raise ValueError("No parent model available — ask a Platform Admin to set one up for your brand")
    return visible[0]["id"]


def _brand(value) -> int | None:
    if value in (None, "", 0):
        return None
    if not db.one("SELECT id FROM brands WHERE id = ?", (int(value),)):
        raise ValueError(f"Brand {value} not found")
    return int(value)


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
    access.require("source.manage")
    return connection.list_warehouses(_conn_values(body))


@app.post("/api/connections/test")
def test_connection(body: dict = Body(...)):
    access.require("source.manage")
    return connection.test(_conn_values(body))


@app.post("/api/connections")
def create_connection(body: dict = Body(...)):
    access.require("source.manage")
    values = connection.normalize(_conn_values(body))
    result = connection.test(values)
    if not result["ok"]:
        raise ValueError(f"Connection test failed: {result['message']}")
    cid = db.insert("connections", {**values, "created_at": db.now()})
    return {**insights.connection_out(_get("connections", cid), MASK), "test": result}


@app.put("/api/connections/{cid}")
def update_connection(cid: int, body: dict = Body(...)):
    access.require("source.manage")
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
    access.require("source.manage")
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
    access.require("settings.manage")
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
    return insights.search_profiles(q, _pid(parent_id))


@app.get("/api/profiles/{profile_id}")
def get_profile(profile_id: str, parent_id: int | None = None):
    return insights.profile(profile_id, _pid(parent_id))


# ---- catalog browsing ----------------------------------------------------------

@app.get("/api/catalog/catalogs")
def catalogs(connection_id: int | None = None):
    access.require("schema.manage")
    connection.use(connection_id)
    return catalog.list_catalogs()


@app.get("/api/catalog/schemas")
def schemas(catalog_name: str, connection_id: int | None = None):
    access.require("schema.manage")
    connection.use(connection_id)
    return catalog.list_schemas(catalog_name)


@app.get("/api/catalog/tables")
def tables(catalog_name: str, schema: str, connection_id: int | None = None):
    access.require("schema.manage")
    connection.use(connection_id)
    return catalog.list_tables(catalog_name, schema)


@app.get("/api/catalog/columns")
def columns(table: str, connection_id: int | None = None):
    access.require("schema.manage")
    connection.use(connection_id)
    return catalog.describe(table)


@app.get("/api/catalog/preview")
def preview_table(table: str, connection_id: int | None = None):
    access.require("schema.manage")
    connection.use(connection_id)
    res = client().execute(f"SELECT * FROM {catalog.quote_table(table)} LIMIT 50")
    return {"columns": res.column_names, "rows": res.rows}


@app.post("/api/catalog/describe-sql")
def describe_sql(body: dict = Body(...)):
    access.require("schema.manage")
    connection.use(body.get("connection_id"))
    return catalog.describe_sql(body.get("sql", ""))


@app.post("/api/catalog/preview-sql")
def preview_sql(body: dict = Body(...)):
    access.require("schema.manage")
    connection.use(body.get("connection_id"))
    src = source({"name": "query", "query_type": "sql", "sql": body.get("sql", "")})
    res = client().execute(f"SELECT * FROM {src} LIMIT 20")
    return {"columns": res.column_names, "rows": res.rows}


# ---- schema models (parent / related / event) ----------------------------------

MODEL_FIELDS = ("kind", "connection_id", "brand_id", "name", "description", "table_ref", "query_type", "sql", "primary_key", "label_column",
                "secondary_label", "parent_id", "relationship", "join_keys", "merge_columns", "column_settings",
                "timestamp_column", "event_name_column")


def _validate_model(m: dict) -> dict:
    if m["kind"] == "parent":
        m["brand_id"] = _brand(m.get("brand_id"))
        m["connection_id"] = int(m.get("connection_id") or 0) or connection.default_id()
        if not m["connection_id"]:
            raise ValueError("Add a Databricks connection on the Sources page first")
        connection.use(m["connection_id"])
    else:
        m["connection_id"] = m["brand_id"] = None  # related/event models follow their parent
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
    return _visible_parents()


@app.get("/api/models")
def list_models():
    u = access.current()
    return [m for m in db.query("SELECT * FROM models ORDER BY kind = 'parent' DESC, id")
            if u.sees(access.brand_of_model(m["id"]))]


@app.get("/api/schema")
def get_schema(parent_id: int | None = None):
    if not _visible_parents():
        return {"parent": None, "models": [], "traits": [], "virtual_columns": [], "parents": []}
    s = audiences.load_schema(_pid(parent_id))
    if not s["parent"]:
        return {"parent": None, "models": [], "traits": [], "virtual_columns": [], "parents": _visible_parents()}
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
            "virtual_columns": virtual, "parents": _visible_parents()}


@app.post("/api/models")
def create_model(body: dict = Body(...)):
    access.require("schema.manage")
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
    access.require("schema.manage")
    current = _get("models", model_id)
    m = {k: body[k] if k in body else current.get(k) for k in MODEL_FIELDS}
    m["kind"] = current["kind"]
    if current["kind"] != "parent":
        m["parent_id"] = current["parent_id"]
    db.update("models", model_id, _validate_model(m))
    return _get("models", model_id)


@app.delete("/api/models/{model_id}")
def delete_model(model_id: int):
    access.require("schema.manage")
    m = _get("models", model_id)
    if m["kind"] == "parent" and db.one("SELECT id FROM audiences WHERE parent_id = ?", (model_id,)):
        raise ValueError("Audiences are built on this parent model. Delete them first.")
    db.delete("models", model_id)
    return {"ok": True}


@app.get("/api/models/{model_id}/values")
def model_values(model_id: int, column: str, q: str = ""):
    m = _get("models", model_id)
    access.require_view(access.brand_of_model(model_id))
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
    access.require("traits.manage", access.brand_of_parent(pid))
    values = _validate_trait(body, pid)
    ts = db.now()
    return _get("traits", db.insert("traits", {**values, "parent_id": pid, "created_at": ts, "updated_at": ts}))


@app.put("/api/traits/{trait_id}")
def update_trait(trait_id: int, body: dict = Body(...)):
    t = _get("traits", trait_id)
    access.require("traits.manage", access.brand_of_parent(t["parent_id"]))
    db.update("traits", trait_id, {**_validate_trait({**t, **body}, t["parent_id"]), "updated_at": db.now()})
    return _get("traits", trait_id)


@app.delete("/api/traits/{trait_id}")
def delete_trait(trait_id: int):
    access.require("traits.manage", access.brand_of_parent(_get("traits", trait_id)["parent_id"]))
    db.delete("traits", trait_id)
    return {"ok": True}


@app.post("/api/traits/preview")
def preview_trait(body: dict = Body(...)):
    return audiences.trait_preview(body.get("method"), body.get("config") or {}, _pid(body.get("parent_id")))


# ---- audiences ------------------------------------------------------------------

@app.get("/api/audiences")
def list_audiences(parent_id: int | None = None):
    sql = ("SELECT a.*, m.name AS parent_name, m.brand_id AS brand_id, "
           "(SELECT COUNT(*) FROM syncs s WHERE s.audience_id = a.id) AS sync_count "
           "FROM audiences a LEFT JOIN models m ON m.id = a.parent_id")
    if parent_id:
        rows = db.query(sql + " WHERE a.parent_id = ? ORDER BY a.updated_at DESC", (parent_id,))
    else:
        rows = db.query(sql + " ORDER BY a.updated_at DESC")
    u = access.current()
    return [r for r in rows if u.sees(r["brand_id"])]


@app.get("/api/audiences/{audience_id}")
def get_audience(audience_id: int):
    a = _get("audiences", audience_id)
    access.require_view(access.brand_of_parent(a["parent_id"]))
    return a


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
    access.require("audiences.edit", access.brand_of_parent(pid))
    audiences.compile_definition(body.get("definition") or {}, parent_id=pid)  # validate
    ts = db.now()
    id_ = db.insert("audiences", {"name": body["name"].strip(), "description": body.get("description", ""), "parent_id": pid,
                                  "definition": body.get("definition") or {}, "splits": _validate_splits(body.get("splits")),
                                  "created_at": ts, "updated_at": ts, "last_size": body.get("last_size"),
                                  "size_updated_at": ts if body.get("last_size") is not None else None,
                                  "created_by": access.current().email})
    access.audit("create", "audience", id_, access.brand_of_parent(pid), name=body["name"].strip())
    return _get("audiences", id_)


@app.put("/api/audiences/{audience_id}")
def update_audience(audience_id: int, body: dict = Body(...)):
    a = _get("audiences", audience_id)
    access.require("audiences.edit", access.brand_of_parent(a["parent_id"]))
    values = {k: body[k] for k in ("name", "description", "definition") if k in body}
    if "definition" in values:
        audiences.compile_definition(values["definition"], parent_id=a["parent_id"])
    if "splits" in body:
        values["splits"] = _validate_splits(body["splits"])
    if body.get("last_size") is not None:
        values.update(last_size=body["last_size"], size_updated_at=db.now())
    if set(body) - {"last_size"}:  # recounting only refreshes the size; it is not an edit
        values["updated_at"] = db.now()
    db.update("audiences", audience_id, values)
    return _get("audiences", audience_id)


@app.delete("/api/audiences/{audience_id}")
def delete_audience(audience_id: int):
    access.require("audiences.edit", access.brand_of_audience(audience_id))
    if db.one("SELECT id FROM syncs WHERE audience_id = ?", (audience_id,)):
        raise ValueError("This audience has syncs. Delete them first.")
    db.delete("audiences", audience_id)
    return {"ok": True}


@app.post("/api/audiences/compile")
def compile_audience(body: dict = Body(...)):
    c = audiences.compile_definition(body.get("definition") or {}, parent_id=_pid(body.get("parent_id")))
    return {"sql": c.sql, "params": c.params}


@app.post("/api/audiences/calculate")
def calculate(body: dict = Body(...)):
    return audiences.calculate(body.get("definition") or {}, _pid(body.get("parent_id")))


@app.post("/api/audiences/breakdown")
def breakdown(body: dict = Body(...)):
    return audiences.breakdown(body.get("definition") or {}, body.get("column"), _pid(body.get("parent_id")),
                               body.get("source", "property"), body.get("model_id"), body.get("metric", "users"))


@app.post("/api/audiences/overlap")
def overlap(body: dict = Body(...)):
    access.require_view(access.brand_of_audience(int(body["audience_id"])))
    return audiences.overlap(body.get("definition") or {}, int(body["audience_id"]), _pid(body.get("parent_id")))


@app.post("/api/audiences/preview")
def preview(body: dict = Body(...)):
    return audiences.preview(body.get("definition") or {}, _pid(body.get("parent_id")))


# ---- destinations ------------------------------------------------------------------

def _secret_fields(type_: str) -> set[str]:
    return {f.name for f in destinations.get(type_).config_fields if f.type == "password" or f.secret}


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
    u = access.current()
    return [_mask(r) for r in rows if u.sees(r["brand_id"])]


@app.post("/api/destinations")
def create_destination(body: dict = Body(...)):
    destinations.get(body.get("type"))
    brand_id = _brand(body.get("brand_id"))
    access.require("destinations.manage", brand_id)
    if not (body.get("name") or "").strip():
        raise ValueError("Give the destination a name")
    id_ = db.insert("destinations", {"name": body["name"].strip(), "type": body["type"], "brand_id": brand_id,
                                     "config": body.get("config") or {}, "created_at": db.now()})
    access.audit("create", "destination", id_, brand_id, name=body["name"].strip())
    return _mask(_get("destinations", id_))


@app.put("/api/destinations/{dest_id}")
def update_destination(dest_id: int, body: dict = Body(...)):
    current = _get("destinations", dest_id)
    access.require("destinations.manage", current["brand_id"])
    values = {}
    if "name" in body:
        values["name"] = body["name"]
    if "config" in body:
        values["config"] = _merge_secrets(body["config"], current["config"])
    db.update("destinations", dest_id, values)
    return _mask(_get("destinations", dest_id))


@app.delete("/api/destinations/{dest_id}")
def delete_destination(dest_id: int):
    access.require("destinations.manage", access.brand_of_destination(dest_id))
    if db.one("SELECT id FROM syncs WHERE destination_id = ?", (dest_id,)):
        raise ValueError("This destination is used by syncs. Delete them first.")
    db.delete("destinations", dest_id)
    return {"ok": True}


@app.post("/api/destinations/{dest_id}/segments")
def create_destination_segment(dest_id: int, body: dict = Body(...)):
    """Create an audience segment in an ad platform (Google Ad Manager) and return its ID."""
    d = _get("destinations", dest_id)
    access.require("syncs.edit", d["brand_id"])
    cls = destinations.get(d["type"])
    if not hasattr(cls, "create_segment"):
        raise ValueError(f"{cls.label} doesn't support creating segments")
    dest = cls(d["config"])
    try:
        return dest.create_segment(body.get("name", ""), body.get("membership_days"))
    finally:
        dest.close()


@app.post("/api/destinations/test")
def test_destination(body: dict = Body(...)):
    cfg = body.get("config") or {}
    if body.get("id"):
        stored = _get("destinations", body["id"])
        access.require("destinations.manage", stored["brand_id"])
        cfg = _merge_secrets(cfg, stored["config"])
    else:
        access.require("destinations.manage", _brand(body.get("brand_id")))
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
    rows = db.query(sql + " WHERE r.parent_id = ? ORDER BY r.id", (parent_id,)) if parent_id else db.query(sql + " ORDER BY r.id")
    u = access.current()
    return [r for r in rows if u.sees(access.brand_of_parent(r["parent_id"]))]


def _rule_values(body: dict) -> dict:
    pid = _pid(body.get("parent_id"))
    access.require("governance.manage", access.brand_of_parent(pid))
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
    access.require("governance.manage", access.brand_of_parent(_get("destination_rules", rule_id)["parent_id"]))
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
    u = access.current()
    return [p for p in db.query("SELECT * FROM priority_lists ORDER BY id") if u.sees(access.brand_of_parent(p["parent_id"]))]


def _priority_values(body: dict, list_id: int | None = None) -> dict:
    pid = _pid(body.get("parent_id"))
    access.require("governance.manage", access.brand_of_parent(pid))
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
    access.require("governance.manage", access.brand_of_parent(_get("priority_lists", list_id)["parent_id"]))
    db.delete("priority_lists", list_id)
    return {"ok": True}


# ---- sync templates -------------------------------------------------------------------

@app.get("/api/sync-templates")
def list_templates(destination_id: int | None = None):
    rows = (db.query("SELECT * FROM sync_templates WHERE destination_id = ? ORDER BY name", (destination_id,)) if destination_id
            else db.query("SELECT * FROM sync_templates ORDER BY name"))
    u = access.current()
    return [t for t in rows if u.sees(access.brand_of_destination(t["destination_id"]))]


@app.post("/api/sync-templates")
def create_template(body: dict = Body(...)):
    dest = _get("destinations", int(body["destination_id"]))
    access.require("syncs.edit", dest["brand_id"])
    cfg = sync_engine.normalize_config(body.get("config") or {}, destinations.get(dest["type"]))
    name = (body.get("name") or "").strip()
    if not name:
        raise ValueError("Give the template a name")
    return _get("sync_templates", db.insert("sync_templates", {"name": name, "destination_id": dest["id"],
                                                               "config": cfg, "created_at": db.now()}))


@app.delete("/api/sync-templates/{template_id}")
def delete_template(template_id: int):
    access.require("syncs.edit", access.brand_of_destination(_get("sync_templates", template_id)["destination_id"]))
    db.delete("sync_templates", template_id)
    return {"ok": True}


# ---- syncs -----------------------------------------------------------------------------

SYNC_LIST_SQL = """
SELECT s.*, a.name AS audience_name, a.parent_id AS parent_id, d.name AS destination_name, d.type AS destination_type,
  m.brand_id AS brand_id,
  (SELECT status FROM sync_runs r WHERE r.sync_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_status,
  (SELECT COUNT(*) FROM alerts al WHERE al.sync_id = s.id AND al.status != 'healthy') AS alert_count,
  (SELECT MAX(CASE WHEN al.status = 'critical' THEN 2 WHEN al.status = 'warning' THEN 1 ELSE 0 END)
     FROM alerts al WHERE al.sync_id = s.id) AS alert_level
FROM syncs s JOIN audiences a ON a.id = s.audience_id JOIN destinations d ON d.id = s.destination_id
LEFT JOIN models m ON m.id = a.parent_id
"""


def _sync_out(s: dict) -> dict:
    s["running"] = sync_engine.is_running(s["id"])
    s["destination_configured"] = insights.destination_configured(s["destination_id"])
    try:
        s["config"] = sync_engine.normalize_config(s["config"], destinations.get(s["destination_type"]))
        s["config_error"] = None
    except (ValueError, KeyError) as e:  # one broken sync must not take down the whole list
        s["config_error"] = str(e)
    u = access.current()
    s["can"] = {"edit": u.can("syncs.edit", s["brand_id"]), "approve": u.can("syncs.approve", s["brand_id"]),
                "run": u.can("syncs.run", s["brand_id"], s["destination_id"])}
    return s


@app.get("/api/syncs")
def list_syncs(audience_id: int | None = None):
    if audience_id:
        rows = db.query(SYNC_LIST_SQL + " WHERE s.audience_id = ? ORDER BY s.id DESC", (audience_id,))
    else:
        rows = db.query(SYNC_LIST_SQL + " ORDER BY s.id DESC")
    u = access.current()
    return [_sync_out(r) for r in rows if u.sees(r["brand_id"])]


@app.get("/api/syncs/{sync_id}")
def get_sync(sync_id: int):
    row = db.one(SYNC_LIST_SQL + " WHERE s.id = ?", (sync_id,))
    if not row:
        raise HTTPException(404, "Sync not found")
    access.require_view(row["brand_id"])
    return _sync_out(row)


def _validate_sync(body: dict) -> dict:
    audience = _get("audiences", int(body["audience_id"]))
    dest = _get("destinations", int(body["destination_id"]))
    brand_id = access.brand_of_parent(audience["parent_id"])
    access.require("syncs.edit", brand_id)
    if dest["brand_id"] is not None and dest["brand_id"] != brand_id:
        raise ValueError(f"{dest['name']} belongs to another brand")
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


def _approval(brand_id: int | None) -> dict:
    """Maker-checker: approvers publish directly; everyone else's changes wait for an approver."""
    u = access.current()
    if u.can("syncs.approve", brand_id):
        return {"approval_status": "approved", "approved_by": u.email, "approved_at": db.now(), "submitted_by": u.email}
    return {"approval_status": "pending", "approved_by": "", "approved_at": None, "submitted_by": u.email}


@app.post("/api/syncs")
def create_sync(body: dict = Body(...)):
    values = _validate_sync(body)
    brand_id = access.brand_of_audience(values["audience_id"])
    values.update(created_at=db.now(), created_by=access.current().email, review_note="", **_approval(brand_id))
    sync_id = db.insert("syncs", values)
    scheduler.refresh_next(sync_id)
    access.audit("create", "sync", sync_id, brand_id, name=values["name"], approval=values["approval_status"])
    return get_sync(sync_id)


@app.post("/api/syncs/{sync_id}/approve")
def approve_sync(sync_id: int, body: dict = Body(default={})):
    s = _get("syncs", sync_id)
    brand_id = access.brand_of_sync(sync_id)
    u = access.require("syncs.approve", brand_id)
    db.update("syncs", sync_id, {"approval_status": "approved", "approved_by": u.email, "approved_at": db.now(),
                                 "review_note": (body.get("note") or "").strip()})
    scheduler.refresh_next(sync_id)
    access.audit("approve", "sync", sync_id, brand_id, name=s["name"], note=body.get("note") or "")
    return get_sync(sync_id)


@app.post("/api/syncs/{sync_id}/reject")
def reject_sync(sync_id: int, body: dict = Body(default={})):
    s = _get("syncs", sync_id)
    brand_id = access.brand_of_sync(sync_id)
    u = access.require("syncs.approve", brand_id)
    note = (body.get("note") or "").strip()
    if not note:
        raise ValueError("Say why the sync is sent back, so the builder knows what to change")
    db.update("syncs", sync_id, {"approval_status": "rejected", "approved_by": u.email, "approved_at": db.now(), "review_note": note})
    access.audit("reject", "sync", sync_id, brand_id, name=s["name"], note=note)
    return get_sync(sync_id)


@app.put("/api/syncs/{sync_id}")
def update_sync(sync_id: int, body: dict = Body(...)):
    current = _get("syncs", sync_id)
    brand_id = access.brand_of_sync(sync_id)
    if set(body) <= {"enabled"}:  # pausing / resuming is operational, not a configuration change
        u = access.current()
        if not (u.can("syncs.edit", brand_id) or u.can("syncs.run", brand_id, current["destination_id"])):
            raise HTTPException(403, "Your role can't pause or resume this sync")
        db.update("syncs", sync_id, {"enabled": bool(body["enabled"])})
        access.audit("resume" if body["enabled"] else "pause", "sync", sync_id, brand_id, name=current["name"])
    else:
        values = _validate_sync({**current, **body})
        values.update(_approval(brand_id))
        old_value = ((current.get("config") or {}).get("options") or {}).get("value")
        if (values["config"].get("options") or {}).get("value") != old_value and \
                (_get("destinations", values["destination_id"])["type"] == "gam_kv"):
            # the audience is published under a new name: drop the old members and resend everyone
            targeting.clear_sync(sync_id)
            try:
                sync_engine.drop_state(sync_id)
            except DatabricksError:
                pass
        db.update("syncs", sync_id, values)
        access.audit("update", "sync", sync_id, brand_id, name=values["name"], approval=values["approval_status"])
    scheduler.refresh_next(sync_id)
    return get_sync(sync_id)


@app.delete("/api/syncs/{sync_id}")
def delete_sync(sync_id: int):
    s = _get("syncs", sync_id)
    access.require("syncs.edit", access.brand_of_sync(sync_id))
    if sync_engine.is_running(sync_id):
        raise ValueError("Wait for the current run to finish")
    try:
        sync_engine.drop_state(sync_id)
    except DatabricksError:
        pass  # best effort — app record is removed regardless
    targeting.clear_sync(sync_id)  # key-value members stop being served
    db.delete("syncs", sync_id)
    access.audit("delete", "sync", sync_id, None, name=s["name"])
    return {"ok": True}


@app.post("/api/syncs/{sync_id}/run")
def run_sync(sync_id: int, body: dict = Body(default={})):
    sync = _get("syncs", sync_id)
    brand_id = access.brand_of_sync(sync_id)
    access.require("syncs.run", brand_id, sync["destination_id"])
    if sync["approval_status"] != "approved":
        raise ValueError("This sync is waiting for approval by a Brand Marketing Admin")
    dest = _get("destinations", sync["destination_id"])
    missing = insights.missing_fields(dest)
    if missing:
        raise ValueError(f"Add {', '.join(missing)} to the {dest['name']} destination before running this sync")
    access.audit("run", "sync", sync_id, brand_id, name=sync["name"], full_resync=bool(body.get("full_resync")))
    return {"run_id": sync_engine.start_run(sync_id, "manual", bool(body.get("full_resync")))}


def _export_file(sync_id: int, run_id: int) -> Path | None:
    """The CSV a run wrote (CSV file export destination), if any — runs with no changes write no file."""
    files = sorted(config.EXPORT_DIR.glob(f"*/sync{sync_id}_run{run_id}_*.csv"))
    return files[-1] if files else None


@app.get("/api/syncs/{sync_id}/runs")
def sync_runs(sync_id: int):
    access.require_view(access.brand_of_sync(sync_id))
    runs = db.query("SELECT id, sync_id, status, trigger, started_at, finished_at, audience_rows, added, changed, "
                    "removed, failed, error FROM sync_runs WHERE sync_id = ? ORDER BY id DESC LIMIT 50", (sync_id,))
    dest = db.one("SELECT d.type FROM syncs s JOIN destinations d ON d.id = s.destination_id WHERE s.id = ?", (sync_id,))
    if dest and dest["type"] == "csv":
        for r in runs:
            r["file"] = _export_file(sync_id, r["id"]) is not None
    return runs


@app.get("/api/runs/{run_id}/file")
def run_file(run_id: int):
    """Download the CSV a run wrote. It holds personal data, so only people who may run the sync can take it."""
    run = _get("sync_runs", run_id)
    sync = _get("syncs", run["sync_id"])
    brand_id = access.brand_of_sync(sync["id"])
    access.require("syncs.run", brand_id, sync["destination_id"])
    file = _export_file(sync["id"], run_id)
    if not file:
        raise HTTPException(404, "This run has no file. Runs with no changes write nothing, and files are cleared when the app restarts.")
    name = re.sub(r"[^A-Za-z0-9]+", "_", sync["name"]).strip("_") or "sync"
    access.audit("download", "sync", sync["id"], brand_id, name=sync["name"], run_id=run_id)
    return FileResponse(file, media_type="text/csv", filename=f"{name}_run{run_id}_{file.stem.rsplit('_', 2)[-2]}.csv")


@app.get("/api/runs/recent")
def recent_runs():
    u = access.current()
    rows = db.query("SELECT r.id, r.sync_id, r.status, r.trigger, r.started_at, r.finished_at, r.added, r.changed, "
                    "r.removed, r.failed, s.name AS sync_name FROM sync_runs r JOIN syncs s ON s.id = r.sync_id "
                    "ORDER BY r.id DESC LIMIT 50")
    return [r for r in rows if u.sees(access.brand_of_sync(r["sync_id"]))][:15]


@app.get("/api/runs/{run_id}")
def get_run(run_id: int):
    run = _get("sync_runs", run_id)
    access.require_view(access.brand_of_sync(run["sync_id"]))
    return run


# ---- dashboard -----------------------------------------------------------------------

@app.get("/api/dashboard")
def dashboard():
    count = lambda t: db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"]  # noqa: E731
    return {
        "audiences": count("audiences"),
        "destinations": count("destinations"),
        "syncs": count("syncs"),
        "traits": count("traits"),
        "runs_24h": db.one("SELECT COUNT(*) AS n FROM sync_runs WHERE started_at >= ?",
                           ((datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec="seconds"),))["n"],
        "rows_synced": db.one("SELECT COALESCE(SUM(added + changed + removed), 0) AS n FROM sync_runs")["n"],
        "schema_ready": db.one("SELECT id FROM models WHERE kind = 'parent'") is not None,
    }


# ---- alerts ---------------------------------------------------------------------------------

ALERT_SQL = """
SELECT al.*, s.name AS sync_name, s.destination_id, d.name AS destination_name, d.type AS destination_type,
       a.name AS audience_name, m.brand_id AS brand_id
FROM alerts al JOIN syncs s ON s.id = al.sync_id JOIN destinations d ON d.id = s.destination_id
JOIN audiences a ON a.id = s.audience_id LEFT JOIN models m ON m.id = a.parent_id
"""


def _alert_out(r: dict) -> dict:
    u = access.current()
    r["label"] = alerts.TRIGGERS[r["trigger"]]["label"]
    r["muted"] = alerts._muted(r)
    r["can_mute"] = u.can("syncs.run", r["brand_id"], r["destination_id"]) or u.can("syncs.approve", r["brand_id"])
    return r


@app.get("/api/alerts/catalog")
def alert_catalog():
    return {"triggers": [{"key": k, "label": v["label"], "description": v["description"], "defaults": v["defaults"],
                          "threshold": alerts.THRESHOLDS.get(k)} for k, v in alerts.TRIGGERS.items()],
            "channels": [{"key": k, **v} for k, v in alerts.CHANNELS.items()],
            "email_configured": bool((db.get_setting("smtp") or {}).get("host"))}


@app.get("/api/alerts")
def list_alerts(status: str = "active", sync_id: int | None = None):
    where, args = [], []
    if status == "active":
        where.append("al.status != 'healthy'")
    if sync_id:
        where.append("al.sync_id = ?")
        args.append(sync_id)
    rows = db.query(ALERT_SQL + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY al.updated_at DESC", tuple(args))
    u = access.current()
    return [_alert_out(r) for r in rows if u.sees(r["brand_id"])]


@app.get("/api/alert-events")
def list_alert_events(sync_id: int | None = None, limit: int = 300):
    sql = ("SELECT e.*, s.name AS sync_name, s.destination_id, d.name AS destination_name, m.brand_id AS brand_id "
           "FROM alert_events e JOIN syncs s ON s.id = e.sync_id JOIN destinations d ON d.id = s.destination_id "
           "JOIN audiences a ON a.id = s.audience_id LEFT JOIN models m ON m.id = a.parent_id")
    rows = (db.query(sql + " WHERE e.sync_id = ? ORDER BY e.id DESC LIMIT ?", (sync_id, min(limit, 1000))) if sync_id
            else db.query(sql + " ORDER BY e.id DESC LIMIT ?", (min(limit, 1000),)))
    u = access.current()
    return [{**r, "label": alerts.TRIGGERS[r["trigger"]]["label"]} for r in rows if u.sees(r["brand_id"])]


def _require_alert_control(sync_id: int) -> None:
    s = _get("syncs", sync_id)
    brand = access.brand_of_sync(sync_id)
    u = access.current()
    if not (u.can("syncs.run", brand, s["destination_id"]) or u.can("syncs.approve", brand)):
        raise HTTPException(403, "Only Brand Marketing Admins and Sync Operators can mute alerts")


@app.post("/api/alerts/mute")
def mute_alert(body: dict = Body(...)):
    sid = int(body["sync_id"])
    _require_alert_control(sid)
    out = alerts.mute(sid, body["trigger"], body.get("minutes"))
    access.audit("mute", "alert", sid, access.brand_of_sync(sid), trigger=body["trigger"], minutes=body.get("minutes"))
    return out


@app.post("/api/alerts/unmute")
def unmute_alert(body: dict = Body(...)):
    sid = int(body["sync_id"])
    _require_alert_control(sid)
    alerts.unmute(sid, body["trigger"])
    access.audit("unmute", "alert", sid, access.brand_of_sync(sid), trigger=body["trigger"])
    return {"ok": True}


def _recipient_perm(brand_id: int | None) -> None:
    access.require("settings.manage" if brand_id is None else "destinations.manage", brand_id)


@app.get("/api/alert-recipients")
def list_recipients():
    u = access.current()
    return [alerts.mask(r) for r in db.query("SELECT * FROM alert_recipients ORDER BY name") if u.sees(r["brand_id"])]


@app.post("/api/alert-recipients")
def create_recipient(body: dict = Body(...)):
    brand_id = _brand(body.get("brand_id"))
    _recipient_perm(brand_id)
    values = alerts.validate_recipient(body)
    rid = db.insert("alert_recipients", {**values, "brand_id": brand_id, "created_by": access.current().email, "created_at": db.now()})
    access.audit("create", "alert_recipient", rid, brand_id, name=values["name"], channel=values["channel"])
    return alerts.mask(_get("alert_recipients", rid))


@app.put("/api/alert-recipients/{rid}")
def update_recipient(rid: int, body: dict = Body(...)):
    current = _get("alert_recipients", rid)
    _recipient_perm(current["brand_id"])
    db.update("alert_recipients", rid, alerts.validate_recipient(body, current))
    return alerts.mask(_get("alert_recipients", rid))


@app.delete("/api/alert-recipients/{rid}")
def delete_recipient(rid: int):
    current = _get("alert_recipients", rid)
    _recipient_perm(current["brand_id"])
    db.delete("alert_recipients", rid)
    access.audit("delete", "alert_recipient", rid, current["brand_id"], name=current["name"])
    return {"ok": True}


@app.post("/api/alert-recipients/test")
def test_recipient(body: dict = Body(...)):
    existing = _get("alert_recipients", int(body["id"])) if body.get("id") else None
    _recipient_perm((existing or {}).get("brand_id") if existing else _brand(body.get("brand_id")))
    values = alerts.validate_recipient(body, existing)
    try:
        return {"ok": True, "message": alerts.test_recipient({**values, "id": body.get("id") or 0})}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": str(e)}


@app.get("/api/alert-policies/{scope}/{scope_id}")
def get_alert_policy(scope: str, scope_id: int):
    if scope not in ("destination", "sync"):
        raise HTTPException(404, "Unknown scope")
    access.require_view(access.brand_of_destination(scope_id) if scope == "destination" else access.brand_of_sync(scope_id))
    return alerts.effective(scope, scope_id)


@app.put("/api/alert-policies/{scope}/{scope_id}")
def put_alert_policy(scope: str, scope_id: int, body: dict = Body(...)):
    if scope == "destination":
        access.require("destinations.manage", access.brand_of_destination(_get("destinations", scope_id)["id"]))
    elif scope == "sync":
        brand = access.brand_of_sync(_get("syncs", scope_id)["id"])
        u = access.current()
        if not (u.can("syncs.edit", brand) or u.can("syncs.approve", brand)):
            raise HTTPException(403, "Your role can't change alerting for this sync")
    else:
        raise HTTPException(404, "Unknown scope")
    out = alerts.save_policy(scope, scope_id, body.get("triggers") or {}, body.get("recipient_ids"))
    access.audit("update", f"{scope}_alerting", scope_id, None)
    return out


@app.get("/api/alerts/email-settings")
def get_email_settings():
    s = db.get_setting("smtp") or {}
    return {**{k: s.get(k, "") for k in ("host", "port", "username", "sender")}, "starttls": s.get("starttls", True),
            "password": MASK if s.get("password") else ""}


@app.put("/api/alerts/email-settings")
def put_email_settings(body: dict = Body(...)):
    access.require("settings.manage")
    current = db.get_setting("smtp") or {}
    s = {k: (body.get(k) or "").strip() if isinstance(body.get(k), str) else body.get(k) for k in ("host", "port", "username", "sender", "password", "starttls")}
    if s.get("password") in (None, "", MASK):
        s["password"] = current.get("password", "")
    if s.get("host") and not s.get("sender") and "@" not in (s.get("username") or ""):
        raise ValueError("Set the From address")
    db.set_setting("smtp", s)
    return get_email_settings()


# ---- on-site targeting (Ad Manager key-values) -------------------------------------------------

def _require_targeting_client() -> None:
    u = access.current()
    if not (u.platform_admin or u.email in targeting.clients()):
        db.set_setting("targeting_last_denied", {"identity": u.email, "at": db.now()})  # shown to admins so they can allow it
        raise HTTPException(403, "This identity isn't allowed to look up visitors. A Platform Admin can add it under "
                                 "Destinations → Ad Manager key-values → Website lookup.")


@app.get("/api/targeting")
def targeting_lookup(request: Request):
    """Which audiences a visitor is in, as Ad Manager key-values. ?user_id=… (repeat for several, max 100)."""
    _require_targeting_client()
    ids = request.query_params.getlist("user_id")
    if not ids:
        raise ValueError("Pass at least one user_id")
    found = targeting.lookup(ids)
    body = {"user_id": ids[0], "targeting": found.get(ids[0], {})} if len(ids) == 1 else {"visitors": found}
    return JSONResponse(body, headers={"Cache-Control": "private, max-age=60"})


@app.post("/api/targeting/lookup")
def targeting_lookup_batch(body: dict = Body(...)):
    _require_targeting_client()
    return {"visitors": targeting.lookup([str(x) for x in body.get("user_ids") or []])}


@app.get("/api/targeting/summary")
def targeting_summary():
    access.require("destinations.manage")
    return {"clients": targeting.clients(), "values": targeting.stats(), "last_denied": db.get_setting("targeting_last_denied"),
            "lookup_url": f"{alerts.app_url() or ''}/api/targeting?user_id=VISITOR_ID"}


@app.put("/api/targeting/clients")
def put_targeting_clients(body: dict = Body(...)):
    access.require("settings.manage")
    out = targeting.set_clients(body.get("clients") or [])
    access.audit("update", "targeting_clients", None, None, clients=out)
    return {"clients": out}


# ---- access control: me, brands, roles --------------------------------------------------------

def _brands_out(scoped: bool = True) -> list[dict]:
    """Brands the caller can see. `scoped`: only the one they've switched to; otherwise every brand they could switch to."""
    u = access.current()
    rows = db.query("SELECT b.*, (SELECT COUNT(*) FROM models m WHERE m.brand_id = b.id AND m.kind = 'parent') AS parent_count, "
                    "(SELECT COUNT(*) FROM destinations d WHERE d.brand_id = b.id) AS destination_count FROM brands b ORDER BY name")
    allowed = u.brands() if scoped else u.all_brands()
    return [b for b in rows if allowed is None or b["id"] in allowed]


@app.get("/api/me")
def me():
    u = access.current()
    brands = _brands_out()  # the brand they're working in now (all of theirs when they've chosen "all")
    perms = sorted(access.ALL_BRAND_PERMS)
    brand_names = {b["id"]: b["name"] for b in db.query("SELECT id, name FROM brands")}
    unscoped = dataclasses.replace(u, active_brand=None)  # what their roles give them on each brand, switch aside
    return {"email": u.email, "name": u.name, "groups": u.groups, "platform_admin": u.platform_admin,
            "active_brand_id": u.active_brand,
            "switch": {"brands": [{"id": b["id"], "name": b["name"]} for b in access.switchable_brands(u)],
                       "all": access.sees_every_brand(u)},
            "all_brands_access": [{"id": b["id"], "name": b["name"], "can": {p: unscoped.can(p, b["id"]) for p in perms}}
                                  for b in access.switchable_brands(u)],
            "roles": [{"role": b.role, "label": b.label or access.role_label(b.role), "brand_id": b.brand_id,
                       "brand_name": brand_names.get(b.brand_id) if b.brand_id is not None else None,
                       "destination_ids": b.destination_ids, "permissions": sorted(b.perms)} for b in u.bindings],
            "platform": {p: u.can(p) for p in sorted(access.PLATFORM_PERMS)},
            "brands": [{"id": b["id"], "name": b["name"], "can": {p: u.can(p, b["id"]) for p in perms}} for b in brands],
            "in_databricks_app": access.IN_DATABRICKS_APP,
            "auth_mode": routes_auth._mode(),
            "group_lookup": db.get_setting("group_lookup") if u.platform_admin else None}


@app.get("/api/roles")
def list_roles():
    return access.all_roles()


@app.get("/api/brands")
def list_brands():
    return _brands_out(scoped=False)  # brand management isn't narrowed by the brand switcher


@app.post("/api/brands")
def create_brand(body: dict = Body(...)):
    access.require("access.manage")
    name = (body.get("name") or "").strip()
    if not name:
        raise ValueError("Give the brand a name")
    if db.one("SELECT id FROM brands WHERE lower(name) = lower(?)", (name,)):
        raise ValueError(f"A brand called {name} already exists")
    bid = db.insert("brands", {"name": name, "description": body.get("description", ""), "created_at": db.now()})
    access.audit("create", "brand", bid, bid, name=name)
    return _get("brands", bid)


@app.put("/api/brands/{brand_id}")
def update_brand(brand_id: int, body: dict = Body(...)):
    access.require("access.manage")
    _get("brands", brand_id)
    values = {k: (body[k] or "").strip() for k in ("name", "description") if k in body}
    if "name" in values and not values["name"]:
        raise ValueError("Give the brand a name")
    db.update("brands", brand_id, values)
    return _get("brands", brand_id)


@app.delete("/api/brands/{brand_id}")
def delete_brand(brand_id: int):
    access.require("access.manage")
    b = _get("brands", brand_id)
    if db.one("SELECT id FROM models WHERE brand_id = ?", (brand_id,)) or db.one("SELECT id FROM destinations WHERE brand_id = ?", (brand_id,)):
        raise ValueError(f"{b['name']} still has parent models or destinations. Move or delete them first.")
    db.delete("brands", brand_id)
    access.audit("delete", "brand", brand_id, None, name=b["name"])
    return {"ok": True}


@app.get("/api/role-bindings")
def list_role_bindings():
    access.require("access.manage")
    return db.query("SELECT r.*, b.name AS brand_name FROM role_bindings r LEFT JOIN brands b ON b.id = r.brand_id "
                    "ORDER BY b.name, r.role, r.principal")


@app.post("/api/role-bindings")
def create_role_binding(body: dict = Body(...)):
    access.require("access.manage")
    role = body.get("role")
    if not access.role_exists(role or ""):
        raise ValueError("Choose a role")
    ptype = body.get("principal_type")
    principal = (body.get("principal") or "").strip()
    if ptype not in ("user", "group") or not principal:
        raise ValueError("Choose a Databricks user (email) or group name")
    brand_id = None if role == "platform_admin" else _brand(body.get("brand_id"))
    dest_ids = [int(x) for x in body.get("destination_ids") or []] if "syncs.run" in access.role_perms(role) else []
    for d in dest_ids:
        if access.brand_of_destination(d) not in (None, brand_id) and brand_id is not None:
            raise ValueError("Operators can only be limited to destinations of the same brand")
    rid = db.insert("role_bindings", {"principal_type": ptype, "principal": principal.lower() if ptype == "user" else principal,
                                      "role": role, "brand_id": brand_id, "destination_ids": dest_ids,
                                      "created_by": access.current().email, "created_at": db.now()})
    access.audit("grant", "role", rid, brand_id, principal=principal, role=role)
    return _get("role_bindings", rid)


@app.delete("/api/role-bindings/{binding_id}")
def delete_role_binding(binding_id: int):
    access.require("access.manage")
    r = _get("role_bindings", binding_id)
    db.delete("role_bindings", binding_id)
    access.audit("revoke", "role", binding_id, r["brand_id"], principal=r["principal"], role=r["role"])
    return {"ok": True}


@app.get("/api/audit")
def audit_log(limit: int = 100):
    u = access.current()
    rows = db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (min(int(limit), 500),))
    return [r for r in rows if u.platform_admin or (r["brand_id"] is not None and u.can("syncs.approve", r["brand_id"]))]


@app.get("/api/dev/personas")
def dev_personas():
    """Local development only: users with role grants, to preview the app as them."""
    if access.IN_DATABRICKS_APP or auth.local_enabled():
        raise HTTPException(404, "Not available")  # personas exist only when sign-in is switched off
    return sorted({r["principal"] for r in db.query("SELECT principal FROM role_bindings WHERE principal_type = 'user'")})


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

# CDP_DIST lets a preview server serve another frontend build (e.g. while reviewing UI changes)
DIST = Path(os.environ.get("CDP_DIST") or Path(__file__).resolve().parents[2] / "frontend" / "dist")
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        file = DIST / path
        return FileResponse(file if path and file.is_file() else DIST / "index.html")
