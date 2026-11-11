"""The Databricks workspace's people and groups, so access can be granted by picking from a list.

Reads the workspace SCIM directory with the app's Databricks connection (the one set up on the Sources page).
A failed lookup returns an error message instead of raising, so the screen can fall back to typing an email.
"""
from __future__ import annotations

import threading
import time

import httpx

from . import connection

_SCIM = "/api/2.0/preview/scim/v2"
_cache: dict[tuple, tuple[float, list[dict]]] = {}
_lock = threading.Lock()
TTL = 60


def _get(path: str, params: dict) -> dict:
    """GET on the workspace the app's Databricks connection points at, signed in the way that connection is
    (personal token or service principal)."""
    c = connection.get(connection.default_id())  # ValueError if no connection has been added yet
    r = httpx.get(c["host"] + path, params=params, headers={"Authorization": f"Bearer {connection.bearer(c)}"}, timeout=20)
    r.raise_for_status()
    return r.json()


def _q(text: str) -> str:
    return text.replace("\\", " ").replace('"', " ").strip()


def search(kind: str, q: str = "", limit: int = 50) -> dict:
    """{"items": [...], "error": ""}: users as {email, name}, groups as {name}; matching `q`, at most `limit`."""
    q, limit = _q(q or ""), max(1, min(int(limit), 200))
    key = (kind, q.lower(), limit)
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return {"items": hit[1], "error": ""}
    try:
        if kind == "users":
            params = {"count": limit, "attributes": "userName,displayName,active"}
            if q:
                params["filter"] = f'userName co "{q}" or displayName co "{q}"'
            rows = _get(f"{_SCIM}/Users", params).get("Resources", [])
            items = sorted(({"email": (u.get("userName") or "").lower(), "name": u.get("displayName") or ""}
                            for u in rows if u.get("userName") and u.get("active", True)),
                           key=lambda x: (x["name"] or x["email"]).lower())
        else:
            params = {"count": limit, "attributes": "displayName"}
            if q:
                params["filter"] = f'displayName co "{q}"'
            rows = _get(f"{_SCIM}/Groups", params).get("Resources", [])
            items = sorted(({"name": g["displayName"]} for g in rows if g.get("displayName")), key=lambda x: x["name"].lower())
    except Exception as e:  # noqa: BLE001 — the screen shows this and lets the admin type instead
        status = getattr(getattr(e, "response", None), "status_code", None)
        msg = f"Databricks answered {status}" if status else f"{type(e).__name__}: {str(e)[:160]}"
        return {"items": [], "error": f"Couldn't load Databricks {kind}. {msg}"}
    with _lock:
        _cache[key] = (time.time() + TTL, items)
    return {"items": items, "error": ""}
