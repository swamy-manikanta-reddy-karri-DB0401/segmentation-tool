import os
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .connectors import SourceError, get_source
from .db import Alert, Connection, Model, Segment, SessionLocal, Sync, SyncMember, SyncRejection, SyncRun, init_db
from .modelctx import model_ctx
from .rules import OPERATORS, Ctx, RuleError, quote_table, build_count, build_select
from . import scheduler
from .health import DEFAULT_ALERTS, alert_cfg, health, next_run, normalize_schedule
from .privacy import LEVELS, MASK, annotate, masked_columns, require_approved
from .sailthru import ACTIONS, MATCH_KEYS, Sailthru, SailthruError
from .sync import CANCELS, SyncAbort, check_config, run_sync

_env = Path(__file__).resolve().parent.parent / ".env"
if _env.exists():
    for _l in _env.read_text().splitlines():
        if "=" in _l and not _l.startswith("#"):
            _k, _v = _l.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

SECRET_FIELDS = {"access_token", "api_secret"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    with SessionLocal() as db:
        if not db.query(Connection).filter_by(kind="demo").first():
            db.add(Connection(kind="demo", role="source", name="Demo warehouse (SQLite)", config={}))
            db.commit()
        if os.environ.get("DATABRICKS_TOKEN") and not db.query(Connection).filter_by(kind="databricks").first():
            db.add(Connection(kind="databricks", role="source", name="Databricks (from .env)", config={"from_env": True}))
            db.commit()
    scheduler.start()
    yield
    scheduler.stop()


app = FastAPI(title="Segmentation Tool API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["http://localhost:3100", "http://127.0.0.1:3100"],
    allow_methods=["*"], allow_headers=["*"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _get(db: Session, model, id_: int):
    obj = db.get(model, id_)
    if not obj:
        raise HTTPException(404, f"{model.__name__} {id_} not found")
    return obj


@app.exception_handler(RuleError)
async def rule_error(_, exc: RuleError):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.exception_handler(SourceError)
async def source_error(_, exc: SourceError):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(SailthruError)
async def sailthru_error(_, exc: SailthruError):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=502, content={"detail": str(exc)})


# ---------- meta ----------
@app.get("/api/meta/operators")
def operators():
    return OPERATORS


@app.get("/api/meta/sync-options")
def sync_options():
    return {
        "actions": ACTIONS, "match_keys": MATCH_KEYS, "privacy_levels": LEVELS,
        "require_approved_fields": require_approved(), "alert_defaults": DEFAULT_ALERTS,
    }


# ---------- connections ----------
class ConnectionIn(BaseModel):
    kind: str  # databricks | sailthru
    name: str
    config: dict[str, Any]


def _mask(c: Connection) -> dict:
    cfg = {k: ("••••••••" if k in SECRET_FIELDS and v else v) for k, v in c.config.items()}
    return {"id": c.id, "kind": c.kind, "role": c.role, "name": c.name, "config": cfg}


@app.get("/api/connections")
def list_connections(role: str | None = None, db: Session = Depends(get_db)):
    q = db.query(Connection)
    if role:
        q = q.filter_by(role=role)
    return [_mask(c) for c in q.order_by(Connection.id)]


@app.post("/api/connections")
def create_connection(body: ConnectionIn, db: Session = Depends(get_db)):
    if body.kind not in ("databricks", "sailthru"):
        raise HTTPException(400, "kind must be databricks or sailthru")
    role = "source" if body.kind == "databricks" else "destination"
    c = Connection(kind=body.kind, role=role, name=body.name, config=body.config)
    db.add(c)
    db.commit()
    return _mask(c)


@app.delete("/api/connections/{cid}")
def delete_connection(cid: int, db: Session = Depends(get_db)):
    c = _get(db, Connection, cid)
    used = db.query(Model).filter_by(source_id=cid).count() + db.query(Sync).filter_by(destination_id=cid).count()
    if used:
        raise HTTPException(409, "Connection is used by segments or syncs")
    db.delete(c)
    db.commit()
    return {"ok": True}


def _sailthru(c: Connection) -> Sailthru:
    return Sailthru(c.config.get("api_key", ""), c.config.get("api_secret", ""), bool(c.config.get("dry_run", True)))


@app.post("/api/connections/{cid}/test")
def test_connection(cid: int, db: Session = Depends(get_db)):
    c = _get(db, Connection, cid)
    try:
        if c.role == "source":
            return {"ok": True, "message": get_source(c).test()}
        return {"ok": True, "message": _sailthru(c).test()}
    except (SourceError, SailthruError) as e:
        return {"ok": False, "message": str(e)}


@app.get("/api/connections/{cid}/catalogs")
def catalogs(cid: int, db: Session = Depends(get_db)):
    return get_source(_get(db, Connection, cid)).catalogs()


@app.get("/api/connections/{cid}/tables")
def tables(cid: int, catalog: str | None = None, db: Session = Depends(get_db)):
    return get_source(_get(db, Connection, cid)).tables(catalog)


@app.get("/api/connections/{cid}/columns")
def columns(cid: int, table: str, db: Session = Depends(get_db)):
    return get_source(_get(db, Connection, cid)).columns(table)


@app.get("/api/connections/{cid}/lists")
def sailthru_lists(cid: int, db: Session = Depends(get_db)):
    c = _get(db, Connection, cid)
    if c.kind != "sailthru":
        raise HTTPException(400, "Not a Sailthru connection")
    return _sailthru(c).lists()


# ---------- models ----------
class ModelIn(BaseModel):
    name: str
    kind: str  # parent | related | event
    source_id: int
    table_name: str
    description: str = ""
    primary_key: str = ""
    primary_label: str = ""
    secondary_label: str = ""
    email_column: str = ""
    column_suggestions: bool = False
    parent_id: int | None = None
    parent_key: str = ""
    related_key: str = ""
    extra_keys: list[list[str]] = []
    cardinality: str = "has_many"  # has_many (1:many) | has_one (1:1) | many_to_one
    timestamp_column: str = ""
    event_type: str = ""


def _model(m: Model) -> dict:
    return {
        "id": m.id, "name": m.name, "kind": m.kind, "source_id": m.source_id, "table_name": m.table_name,
        "description": m.description or "", "primary_key": m.primary_key, "primary_label": m.primary_label or "",
        "secondary_label": m.secondary_label or "", "email_column": m.email_column,
        "column_suggestions": bool(m.column_suggestions), "parent_id": m.parent_id,
        "parent_key": m.parent_key, "related_key": m.related_key, "extra_keys": m.extra_keys or [],
        "cardinality": m.cardinality, "timestamp_column": m.timestamp_column or "", "event_type": m.event_type or "",
        "column_privacy": m.column_privacy or {},
    }


def _check_model(body: ModelIn, db: Session) -> None:
    if not body.name.strip():
        raise RuleError("Name is required")
    src = get_source(_get(db, Connection, body.source_id))
    cols = {c["name"] for c in src.columns(body.table_name)}
    if not cols:
        raise RuleError(f"Table '{body.table_name}' has no columns or does not exist")

    def need(label: str, col: str, available: set[str], required: bool = True):
        if not col:
            if required:
                raise RuleError(f"{label} is required")
        elif col not in available:
            raise RuleError(f"{label} '{col}' not found")

    need("Primary key", body.primary_key, cols, required=body.kind == "parent")
    for label, col in (("Primary label", body.primary_label), ("Secondary label", body.secondary_label),
                       ("Email column", body.email_column)):
        need(label, col, cols, required=False)
    if body.kind == "parent":
        body.parent_id = None
        return
    if body.kind not in ("related", "event"):
        raise RuleError("kind must be parent, related or event")
    if body.cardinality not in ("has_many", "has_one", "many_to_one"):
        raise RuleError("Invalid relationship type")
    parent = _get(db, Model, body.parent_id or 0)
    if parent.kind != "parent":
        raise RuleError("Related models and events must hang off a parent model")
    pcols = {c["name"] for c in get_source(_get(db, Connection, parent.source_id)).columns(parent.table_name)}
    need("Join key on the related table", body.related_key, cols)
    need(f"Join key on {parent.name}", body.parent_key, pcols)
    for pair in body.extra_keys:
        if len(pair) != 2:
            raise RuleError("Each extra join key needs a parent column and a related column")
        need(f"Join key on {parent.name}", pair[0], pcols)
        need("Join key on the related table", pair[1], cols)
    if body.kind == "event":
        need("Timestamp column", body.timestamp_column, cols)


def _row(body: ModelIn) -> dict:
    d = body.model_dump()
    d["column_suggestions"] = int(d["column_suggestions"])
    return d


@app.get("/api/models")
def list_models(db: Session = Depends(get_db)):
    return [_model(m) for m in db.query(Model).order_by(Model.id)]


@app.get("/api/models/{mid}/schema")
def model_schema(mid: int, db: Session = Depends(get_db)):
    """Columns of a parent model plus each related model's columns (drives the segment builder)."""
    m = _get(db, Model, mid)
    src = get_source(_get(db, Connection, m.source_id))
    out = {"model": _model(m), "columns": annotate(src.columns(m.table_name), m), "relations": []}
    for r in db.query(Model).filter_by(parent_id=mid).order_by(Model.id):
        rsrc = get_source(_get(db, Connection, r.source_id))
        out["relations"].append({**_model(r), "columns": annotate(rsrc.columns(r.table_name), r)})
    return out


@app.get("/api/models/{mid}/columns")
def model_columns(mid: int, db: Session = Depends(get_db)):
    m = _get(db, Model, mid)
    return annotate(get_source(_get(db, Connection, m.source_id)).columns(m.table_name), m)


class PrivacyIn(BaseModel):
    column_privacy: dict[str, str]


@app.put("/api/models/{mid}/privacy")
def set_privacy(mid: int, body: PrivacyIn, db: Session = Depends(get_db)):
    m = _get(db, Model, mid)
    cols = {c["name"] for c in get_source(_get(db, Connection, m.source_id)).columns(m.table_name)}
    for c, lv in body.column_privacy.items():
        if c not in cols:
            raise RuleError(f"Unknown column '{c}'")
        if lv not in LEVELS:
            raise RuleError(f"Unknown privacy level '{lv}'")
    m.column_privacy = {c: lv for c, lv in body.column_privacy.items() if lv != "unreviewed"}
    _values_cache.clear()
    db.commit()
    return _model(m)


_values_cache: dict[tuple[int, str], list[str]] = {}


@app.get("/api/models/{mid}/values")
def model_values(mid: int, column: str, db: Session = Depends(get_db)):
    """Distinct values for filter suggestions (only when the model has column suggestions enabled)."""
    m = _get(db, Model, mid)
    if not m.column_suggestions or column in masked_columns(m):
        return []
    key = (mid, column)
    if key not in _values_cache:
        src = get_source(_get(db, Connection, m.source_id))
        ctx = Ctx(src.dialect, {c["name"]: c["category"] for c in src.columns(m.table_name)})
        col = ctx.quote(column)
        sql = f"SELECT DISTINCT {col} FROM {quote_table(m.table_name, src.dialect)} AS p WHERE {col} IS NOT NULL LIMIT 101"
        vals = [str(r[0]) for r in src.run(sql, [])[1]]
        _values_cache[key] = sorted(vals) if len(vals) <= 100 else []  # >100 distinct: not a good filter dropdown
    return _values_cache[key]


@app.get("/api/models/{mid}/usage")
def model_usage(mid: int, db: Session = Depends(get_db)):
    m = _get(db, Model, mid)

    def uses(n, rid):
        if n.get("type") == "group":
            return any(uses(c, rid) for c in n.get("children", []))
        return n.get("related_id") == rid

    segs = db.query(Segment).all()
    hit = [s for s in segs if (s.model_id == mid if m.kind == "parent" else s.model_id == m.parent_id and uses(s.filter or {}, mid))]
    return [{"id": s.id, "name": s.name} for s in hit]


@app.get("/api/models/{mid}/validate")
def validate_model(mid: int, db: Session = Depends(get_db)):
    """Data-quality checks from Hightouch's guidance: PK uniqueness, cardinality, join key types."""
    m = _get(db, Model, mid)
    src = get_source(_get(db, Connection, m.source_id))
    cols = {c["name"]: c for c in src.columns(m.table_name)}
    ctx = Ctx(src.dialect, {k: v["category"] for k, v in cols.items()})
    t = quote_table(m.table_name, src.dialect)
    warnings: list[str] = []
    if m.primary_key:
        pk = ctx.quote(m.primary_key)
        total, non_null, distinct = src.run(f"SELECT COUNT(*), COUNT({pk}), COUNT(DISTINCT {pk}) FROM {t} AS p", [])[1][0]
        if total - non_null:
            warnings.append(f"{total - non_null:,} rows have a null primary key and will be ignored by syncs.")
        if non_null - distinct:
            warnings.append(f"{non_null - distinct:,} rows share a primary key with another row; audience counts and syncs may be wrong.")
    if m.kind != "parent":
        parent = _get(db, Model, m.parent_id or 0)
        pcols = {c["name"]: c for c in get_source(_get(db, Connection, parent.source_id)).columns(parent.table_name)}
        pairs = [(m.parent_key, m.related_key)] + [tuple(p) for p in (m.extra_keys or [])]
        for pk_, rk in pairs:
            if pk_ in pcols and rk in cols and pcols[pk_]["category"] != cols[rk]["category"]:
                warnings.append(f"Join key type mismatch: {parent.name}.{pk_} ({pcols[pk_]['type']}) vs {m.name}.{rk} ({cols[rk]['type']}).")
        if m.cardinality in ("has_one", "many_to_one"):
            keys = ", ".join(ctx.quote(rk) for _, rk in pairs)
            n = src.run(f"SELECT COUNT(*) FROM (SELECT {keys} FROM {t} AS p GROUP BY {keys} HAVING COUNT(*) > 1) d", [])[1][0][0]
            if n:
                label = "1:1" if m.cardinality == "has_one" else "many:1"
                warnings.append(f"Mismatched cardinality detected: {n:,} join key values appear in more than one row, but the relationship is {label}. This can duplicate parent rows.")
    return {"ok": not warnings, "warnings": warnings}


@app.post("/api/models")
def create_model(body: ModelIn, db: Session = Depends(get_db)):
    _check_model(body, db)
    m = Model(**_row(body))
    db.add(m)
    db.commit()
    return _model(m)


@app.put("/api/models/{mid}")
def update_model(mid: int, body: ModelIn, db: Session = Depends(get_db)):
    m = _get(db, Model, mid)
    _check_model(body, db)
    for k, v in _row(body).items():
        setattr(m, k, v)
    _values_cache.clear()
    db.commit()
    return _model(m)


@app.delete("/api/models/{mid}")
def delete_model(mid: int, db: Session = Depends(get_db)):
    m = _get(db, Model, mid)
    children = db.query(Model).filter_by(parent_id=mid).all()
    users = model_usage(mid, db)
    if users:
        raise HTTPException(409, "Used by segment(s): " + ", ".join(u["name"] for u in users))
    for c in children:
        db.delete(c)
    db.delete(m)
    db.commit()
    return {"ok": True}


@app.post("/api/connections/{cid}/preview-table")
def preview_table(cid: int, body: dict[str, Any], db: Session = Depends(get_db)):
    """Preview results for the table selector (limit 100 rows, optional row count)."""
    src = get_source(_get(db, Connection, cid))
    t = quote_table(str(body.get("table", "")), src.dialect)
    limit = body.get("limit")
    sql = f"SELECT * FROM {t}" + (f" LIMIT {min(int(limit), 1000)}" if limit else " LIMIT 1000")
    names, rows = src.run(sql, [])
    count = src.run(f"SELECT COUNT(*) FROM {t}", [])[1][0][0] if body.get("count", True) else None
    return {
        "columns": names, "count": count,
        "rows": [[None if v is None else (v if isinstance(v, (int, float, bool)) else str(v)) for v in r] for r in rows],
    }


# ---------- segments ----------
class SegmentIn(BaseModel):
    name: str
    description: str = ""
    model_id: int
    filter: dict[str, Any] = {}


class PreviewIn(BaseModel):
    model_id: int
    filter: dict[str, Any] = {}
    limit: int = 10


def _seg(s: Segment) -> dict:
    return {
        "id": s.id, "name": s.name, "description": s.description, "model_id": s.model_id,
        "filter": s.filter, "last_count": s.last_count, "updated_at": s.updated_at.isoformat(),
    }


def _parent(db: Session, model_id: int) -> Model:
    m = _get(db, Model, model_id)
    if m.kind != "parent":
        raise RuleError("Segments are built on parent models")
    return m


@app.post("/api/segments/preview")
def preview(body: PreviewIn, db: Session = Depends(get_db)):
    m = _parent(db, body.model_id)
    src = get_source(_get(db, Connection, m.source_id))
    ctx = model_ctx(db, m, src)
    csql, cparams = build_count(m.table_name, body.filter, ctx)
    count = src.run(csql, cparams)[1][0][0]
    limit = min(body.limit, 100)
    ssql, sparams = build_select(m.table_name, [], body.filter, ctx, limit=limit)
    names, rows = src.run(ssql, sparams)
    masked = [i for i, n in enumerate(names) if n in masked_columns(m)]
    return {
        "count": count,
        "columns": names,
        "labels": [x for x in (m.primary_label, m.secondary_label) if x],
        "rows": [
            [MASK if i in masked and v is not None else None if v is None else (v if isinstance(v, (int, float, bool)) else str(v))
             for i, v in enumerate(r)]
            for r in rows
        ],
    }


@app.get("/api/segments")
def list_segments(db: Session = Depends(get_db)):
    return [_seg(s) for s in db.query(Segment).order_by(Segment.id.desc())]


@app.get("/api/segments/{sid}")
def get_segment(sid: int, db: Session = Depends(get_db)):
    return _seg(_get(db, Segment, sid))


def _count(body: SegmentIn, db: Session) -> int:
    m = _parent(db, body.model_id)
    src = get_source(_get(db, Connection, m.source_id))
    sql, params = build_count(m.table_name, body.filter, model_ctx(db, m, src))
    return src.run(sql, params)[1][0][0]


@app.post("/api/segments")
def create_segment(body: SegmentIn, db: Session = Depends(get_db)):
    count = _count(body, db)
    s = Segment(**body.model_dump(), last_count=count)
    db.add(s)
    db.commit()
    return _seg(s)


@app.put("/api/segments/{sid}")
def update_segment(sid: int, body: SegmentIn, db: Session = Depends(get_db)):
    s = _get(db, Segment, sid)
    count = _count(body, db)
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    s.last_count, s.updated_at = count, datetime.utcnow()
    db.commit()
    return _seg(s)


@app.delete("/api/segments/{sid}")
def delete_segment(sid: int, db: Session = Depends(get_db)):
    s = _get(db, Segment, sid)
    if db.query(Sync).filter_by(segment_id=sid).count():
        raise HTTPException(409, "Segment is used by a sync")
    db.delete(s)
    db.commit()
    return {"ok": True}


# ---------- syncs ----------
class SyncIn(BaseModel):
    name: str
    segment_id: int
    destination_id: int
    action: str = "add_to_list"
    list_name: str = ""
    mode: str = "mirror"
    match_key: str = "email"
    match_column: str = ""
    mapping: list[dict[str, str]] = []
    schedule: dict[str, Any] = {"type": "manual"}
    schedule_enabled: bool = True
    alerts: dict[str, Any] = {}
    timeout_minutes: int = 30


def _run(r: SyncRun) -> dict:
    return {
        "id": r.id, "sync_id": r.sync_id, "status": r.status, "trigger": r.trigger,
        "started_at": r.started_at.isoformat(), "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "total": r.total, "matched": r.matched, "added": r.added, "removed": r.removed, "rejected": r.failed,
        "dry_run": bool(r.dry_run), "error": r.error or "", "flags": [f for f in (r.flags or "").splitlines() if f],
        "log": r.log,
    }


def _sync(s: Sync, db: Session) -> dict:
    last = db.query(SyncRun).filter_by(sync_id=s.id).order_by(SyncRun.id.desc()).first()
    nxt = next_run(s, last, datetime.utcnow())
    return {
        "id": s.id, "name": s.name, "segment_id": s.segment_id, "destination_id": s.destination_id,
        "action": s.action, "list_name": s.list_name, "mode": s.mode, "match_key": s.match_key,
        "match_column": s.match_column, "mapping": s.mapping, "schedule": s.schedule or {"type": "manual"},
        "schedule_enabled": bool(s.schedule_enabled), "alerts": alert_cfg(s), "timeout_minutes": s.timeout_minutes,
        "next_run_at": nxt.isoformat() if nxt else None, "health": health(s, last),
        "last_run": _run(last) if last else None,
    }


def _prepare_sync(body: SyncIn, db: Session) -> dict:
    seg = _get(db, Segment, body.segment_id)
    if _get(db, Connection, body.destination_id).kind != "sailthru":
        raise HTTPException(400, "Destination must be Sailthru")
    if body.action not in ACTIONS:
        raise RuleError("Unknown sync action")
    if body.match_key not in MATCH_KEYS:
        raise RuleError("Unknown match key")
    if body.mode not in ("upsert", "mirror"):
        raise RuleError("mode must be upsert or mirror")
    if not 1 <= body.timeout_minutes <= 240:
        raise RuleError("Timeout must be between 1 and 240 minutes")
    d = body.model_dump()
    try:
        check_config(d, _get(db, Model, seg.model_id))
        d["schedule"] = normalize_schedule(body.schedule)
    except SyncAbort as e:
        raise RuleError(str(e))
    except (ValueError, TypeError) as e:
        raise RuleError(f"Invalid schedule: {e}")
    cfg = {**DEFAULT_ALERTS, **body.alerts}
    for k in ("min_rows", "max_rows", "max_change_pct"):
        cfg[k] = None if cfg[k] in (None, "") else float(cfg[k]) if k == "max_change_pct" else int(cfg[k])
    d["alerts"] = cfg
    d["schedule_enabled"] = int(body.schedule_enabled)
    return d


@app.get("/api/syncs")
def list_syncs(db: Session = Depends(get_db)):
    return [_sync(s, db) for s in db.query(Sync).order_by(Sync.id.desc())]


@app.post("/api/syncs")
def create_sync(body: SyncIn, db: Session = Depends(get_db)):
    s = Sync(**_prepare_sync(body, db))
    db.add(s)
    db.commit()
    return _sync(s, db)


@app.put("/api/syncs/{sid}")
def update_sync(sid: int, body: SyncIn, db: Session = Depends(get_db)):
    s = _get(db, Sync, sid)
    for k, v in _prepare_sync(body, db).items():
        setattr(s, k, v)
    db.commit()
    return _sync(s, db)


@app.delete("/api/syncs/{sid}")
def delete_sync(sid: int, db: Session = Depends(get_db)):
    s = _get(db, Sync, sid)
    run_ids = [r.id for r in db.query(SyncRun).filter_by(sync_id=sid)]
    if run_ids:
        db.query(SyncRejection).filter(SyncRejection.run_id.in_(run_ids)).delete(synchronize_session=False)
    db.query(Alert).filter_by(sync_id=sid).delete()
    db.query(SyncRun).filter_by(sync_id=sid).delete()
    db.query(SyncMember).filter_by(sync_id=sid).delete()
    db.delete(s)
    db.commit()
    return {"ok": True}


@app.post("/api/syncs/{sid}/run")
def trigger(sid: int, bg: BackgroundTasks, db: Session = Depends(get_db)):
    _get(db, Sync, sid)
    if db.query(SyncRun).filter(SyncRun.sync_id == sid, SyncRun.status.in_(["queued", "running"])).count():
        raise HTTPException(409, "A run is already in progress")
    r = SyncRun(sync_id=sid, trigger="manual")
    db.add(r)
    db.commit()
    bg.add_task(run_sync, r.id)
    return _run(r)


@app.get("/api/syncs/{sid}/runs")
def runs(sid: int, db: Session = Depends(get_db)):
    return [_run(r) for r in db.query(SyncRun).filter_by(sync_id=sid).order_by(SyncRun.id.desc()).limit(50)]


@app.post("/api/runs/{rid}/cancel")
def cancel_run(rid: int, db: Session = Depends(get_db)):
    r = _get(db, SyncRun, rid)
    if r.status == "queued" and rid not in CANCELS:
        r.status, r.finished_at, r.error = "cancelled", datetime.utcnow(), "Cancelled before it started"
        db.commit()
    elif r.status in ("queued", "running") and rid in CANCELS:
        CANCELS[rid].set()
    else:
        raise HTTPException(409, "Run is not in progress")
    return {"ok": True}


@app.get("/api/runs/{rid}/rejected")
def rejected_rows(rid: int, db: Session = Depends(get_db)):
    _get(db, SyncRun, rid)
    rows = db.query(SyncRejection).filter_by(run_id=rid).order_by(SyncRejection.id).limit(1000)
    return [{"identifier": r.identifier, "reason": r.reason} for r in rows]


# ---------- alerts ----------
def _alert_row(a: Alert, db: Session) -> dict:
    sync = db.get(Sync, a.sync_id)
    return {
        "id": a.id, "sync_id": a.sync_id, "sync_name": sync.name if sync else "(deleted)", "run_id": a.run_id,
        "kind": a.kind, "severity": a.severity, "message": a.message, "created_at": a.created_at.isoformat(),
        "acknowledged": a.acknowledged_at is not None,
    }


@app.get("/api/alerts")
def list_alerts(open_only: bool = False, db: Session = Depends(get_db)):
    q = db.query(Alert)
    if open_only:
        q = q.filter(Alert.acknowledged_at.is_(None))
    return [_alert_row(a, db) for a in q.order_by(Alert.id.desc()).limit(200)]


@app.get("/api/alerts/count")
def alert_count(db: Session = Depends(get_db)):
    return {"open": db.query(Alert).filter(Alert.acknowledged_at.is_(None)).count()}


@app.post("/api/alerts/ack-all")
def ack_all(db: Session = Depends(get_db)):
    db.query(Alert).filter(Alert.acknowledged_at.is_(None)).update({"acknowledged_at": datetime.utcnow()})
    db.commit()
    return {"ok": True}


@app.post("/api/alerts/{aid}/ack")
def ack(aid: int, db: Session = Depends(get_db)):
    a = _get(db, Alert, aid)
    a.acknowledged_at = datetime.utcnow()
    db.commit()
    return {"ok": True}
