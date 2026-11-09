"""Databricks source connections, managed from the Sources page.

A workspace can hold several connections (e.g. one per service principal or per Databricks workspace).
Each parent model belongs to one connection; its related/event models, traits, audiences and syncs use
the same connection because their joins run inside one warehouse.

Queries pick their connection from a context variable that request handlers and sync runs set
(``use``/``use_parent``/``use_model``); when nothing is set the default connection is used.
"""
from __future__ import annotations

import re
import threading
import time
from contextvars import ContextVar

import httpx

from . import config, db

AUTH_TYPES = {"oauth": "Service principal (OAuth)", "pat": "Personal access token"}
FIELDS = ("name", "host", "auth_type", "client_id", "secret", "warehouse_id", "state_schema")
SECRET_FIELDS = {"secret"}
SCHEMA_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$")

_current: ContextVar[int | None] = ContextVar("connection_id", default=None)


# ---- storage -----------------------------------------------------------------------

def seed() -> None:
    """First run: turn the .env (or the single connection saved by an earlier version) into a connection row."""
    if db.one("SELECT id FROM connections LIMIT 1"):
        return
    legacy = db.get_setting("source_connection") or {}
    host = legacy.get("host") or config.DATABRICKS_HOST
    token = legacy.get("token") or config.DATABRICKS_TOKEN
    if not (host and token):
        return
    cid = db.insert("connections", {
        "name": "Databricks (personal token)", "host": host, "auth_type": "pat", "client_id": "", "secret": token,
        "warehouse_id": legacy.get("warehouse_id") or config.DATABRICKS_WAREHOUSE_ID,
        "state_schema": legacy.get("state_schema") or config.CDP_STATE_SCHEMA, "created_at": db.now()})
    db.conn().execute("UPDATE models SET connection_id = ? WHERE kind = 'parent' AND connection_id IS NULL", (cid,))
    db.conn().commit()


def all_connections() -> list[dict]:
    return db.query("SELECT * FROM connections ORDER BY id")


def get(cid: int | None = None) -> dict:
    cid = cid or current_id()
    c = db.one("SELECT * FROM connections WHERE id = ?", (cid,)) if cid else None
    if not c:
        raise ValueError("No Databricks connection yet. Add one on the Sources page.")
    return c


def default_id() -> int | None:
    """The connection used when nothing more specific applies: the first parent model's, else the oldest."""
    row = db.one("SELECT connection_id AS id FROM models WHERE kind = 'parent' AND connection_id IS NOT NULL ORDER BY id LIMIT 1") \
        or db.one("SELECT id FROM connections ORDER BY id LIMIT 1")
    return row["id"] if row else None


def for_parent(parent_id: int | None) -> int | None:
    if parent_id:
        row = db.one("SELECT connection_id FROM models WHERE id = ?", (parent_id,))
        if row and row["connection_id"]:
            return row["connection_id"]
    return default_id()


def for_model(model_id: int) -> int | None:
    m = db.one("SELECT kind, parent_id FROM models WHERE id = ?", (model_id,))
    if not m:
        return default_id()
    return for_parent(model_id if m["kind"] == "parent" else m["parent_id"])


# ---- which connection the current request / run uses ------------------------------

def use(cid: int | None) -> None:
    if cid and not db.one("SELECT id FROM connections WHERE id = ?", (cid,)):
        raise ValueError(f"Connection {cid} not found")
    _current.set(cid)


def use_parent(parent_id: int | None) -> None:
    _current.set(for_parent(parent_id))


def use_model(model_id: int) -> None:
    _current.set(for_model(model_id))


def current_id() -> int | None:
    return _current.get() or default_id()


def host(cid: int | None = None) -> str:
    try:
        return get(cid)["host"]
    except ValueError:
        return ""


def state_schema(cid: int | None = None) -> str:
    return get(cid)["state_schema"]


# ---- auth ----------------------------------------------------------------------

_tokens: dict[tuple, tuple[str, float]] = {}
_token_lock = threading.Lock()


def bearer(c: dict) -> str:
    """Access token for a connection. OAuth tokens (1 hour) are cached and refreshed a minute early."""
    if c["auth_type"] == "pat":
        return c["secret"]
    key = (c["host"], c["client_id"], c["secret"])
    with _token_lock:
        hit = _tokens.get(key)
        if hit and hit[1] > time.time() + 60:
            return hit[0]
        try:
            r = httpx.post(f"{c['host']}/oidc/v1/token", auth=(c["client_id"], c["secret"]),
                           data={"grant_type": "client_credentials", "scope": "all-apis"}, timeout=30)
        except httpx.HTTPError as e:
            raise ValueError(f"Could not reach {c['host']}: {e}") from e
        if r.status_code >= 400:
            try:
                msg = r.json().get("error_description") or r.json().get("error") or r.text
            except Exception:  # noqa: BLE001
                msg = r.text
            raise ValueError(f"Service principal sign-in failed: {msg[:200]}")
        d = r.json()
        _tokens[key] = (d["access_token"], time.time() + int(d.get("expires_in", 3600)))
        return d["access_token"]


# ---- validation, test, warehouses ----------------------------------------------------

def _host(h: str) -> str:
    h = (h or "").strip().rstrip("/")
    return h if not h or h.startswith("http") else "https://" + h


def normalize(values: dict, partial: bool = False) -> dict:
    out = {k: str(values.get(k) or "").strip() for k in FIELDS}
    out["host"] = _host(out["host"])
    out["auth_type"] = out["auth_type"] or "oauth"
    if out["auth_type"] not in AUTH_TYPES:
        raise ValueError("Authentication must be a service principal (oauth) or a personal access token (pat)")
    if out["auth_type"] == "pat":
        out["client_id"] = ""
    if partial:
        return out
    if not out["name"]:
        raise ValueError("Give the connection a name")
    if not out["host"]:
        raise ValueError("Enter the workspace URL, e.g. https://adb-123.4.azuredatabricks.net")
    if out["auth_type"] == "oauth" and not out["client_id"]:
        raise ValueError("Enter the service principal's application (client) ID")
    if not out["secret"]:
        raise ValueError("Enter the OAuth secret" if out["auth_type"] == "oauth" else "Enter an access token")
    if not out["warehouse_id"]:
        raise ValueError("Choose a SQL warehouse")
    if not SCHEMA_RE.match(out["state_schema"]):
        raise ValueError("Sync state schema must look like catalog.schema")
    return out


def list_warehouses(values: dict) -> list[dict]:
    c = normalize(values, partial=True)
    if not c["host"] or not c["secret"]:
        raise ValueError("Enter the workspace URL and credentials first")
    try:
        r = httpx.get(f"{c['host']}/api/2.0/sql/warehouses", headers={"Authorization": f"Bearer {bearer(c)}"}, timeout=20)
    except httpx.HTTPError as e:
        raise ValueError(f"Could not reach {c['host']}: {e}") from e
    if r.status_code in (401, 403):
        raise ValueError("Databricks rejected these credentials")
    if r.status_code >= 400:
        raise ValueError(f"Databricks returned {r.status_code}: {r.text[:200]}")
    return [{"id": w["id"], "name": w["name"], "state": w.get("state"), "size": w.get("cluster_size"),
             "serverless": bool(w.get("enable_serverless_compute"))} for w in r.json().get("warehouses", [])]


def test(values: dict) -> dict:
    """Sign in, run SELECT 1 on the warehouse and check the sync state schema."""
    from .databricks import DatabricksClient, DatabricksError
    try:
        c = normalize(values)
        dbx = DatabricksClient(c)
    except ValueError as e:
        return {"ok": False, "message": str(e)}
    try:
        wh = dbx.warehouse_info()
        who = dbx.execute("SELECT current_user()").rows[0][0]
        cat, sch = c["state_schema"].split(".")
        found = dbx.execute(f"SHOW SCHEMAS IN `{cat}` LIKE '{sch}'").rows
        note = "" if found else f" The schema {c['state_schema']} doesn't exist yet; it is created on the first sync."
        return {"ok": True, "message": f"Connected to {wh['name']} ({wh['state'].lower()}) as {who}.{note}",
                "warehouse": wh, "principal": who}
    except (DatabricksError, ValueError) as e:
        return {"ok": False, "message": str(e)}
    except httpx.HTTPError as e:
        return {"ok": False, "message": f"Could not reach {c['host']}: {e}"}
    finally:
        dbx.close()
