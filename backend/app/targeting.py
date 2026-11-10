"""Audience membership for on-site ad targeting (Google Ad Manager key-values).

Syncs to a "key-value targeting" destination keep `targeting_members` up to date — one row per
(key, value, visitor id) — so a website (server side) can ask "which audiences is this visitor in?"
in milliseconds and pass the answer to Ad Manager as key-values, e.g. mm_aud=engaged_non_subs.
The table lives in the app's metadata store (Lakebase when deployed), not in Databricks SQL, because
it is read on every page view.
"""
from __future__ import annotations

import re

from . import db

VALUE_RE = re.compile(r"^[a-z0-9_\-]{1,40}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_\-]{1,10}$")
MAX_LOOKUP = 100


def slug(text: str, limit: int = 40) -> str:
    """An Ad Manager-safe value name from an audience name: lowercase, a–z 0–9 _ -, ≤ 40 chars."""
    s = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    return (s or "audience")[:limit].rstrip("_")


def validate_key(key: str) -> str:
    key = (key or "").strip()
    if not KEY_RE.match(key):
        raise ValueError("The targeting key must be 1–10 characters: letters, numbers, _ or -")
    return key


def validate_value(value: str) -> str:
    value = (value or "").strip()
    if not VALUE_RE.match(value):
        raise ValueError("The targeting value must be 1–40 characters: lowercase letters, numbers, _ or -")
    return value


def add(key: str, value: str, sync_id: int, user_ids: list[str]) -> None:
    now = db.now()
    db.executemany("INSERT INTO targeting_members (key, audience_value, user_id, sync_id, updated_at) VALUES (?, ?, ?, ?, ?) "
                   "ON CONFLICT(key, audience_value, user_id) DO UPDATE SET sync_id = excluded.sync_id, updated_at = excluded.updated_at",
                   [(key, value, uid, sync_id, now) for uid in user_ids])


def remove(key: str, value: str, user_ids: list[str]) -> None:
    db.executemany("DELETE FROM targeting_members WHERE key = ? AND audience_value = ? AND user_id = ?", [(key, value, uid) for uid in user_ids])


def clear_sync(sync_id: int) -> None:
    db.execute("DELETE FROM targeting_members WHERE sync_id = ?", (sync_id,))


def lookup(user_ids: list[str]) -> dict[str, dict[str, list[str]]]:
    ids = [u for u in dict.fromkeys(str(u).strip() for u in user_ids) if u][:MAX_LOOKUP]
    out: dict[str, dict[str, list[str]]] = {u: {} for u in ids}
    if not ids:
        return out
    marks = ", ".join("?" for _ in ids)
    for r in db.query(f"SELECT user_id, key, audience_value FROM targeting_members WHERE user_id IN ({marks}) ORDER BY key, audience_value", tuple(ids)):
        out[r["user_id"]].setdefault(r["key"], []).append(r["audience_value"])
    return out


def stats(key: str | None = None) -> list[dict]:
    sql = "SELECT key, audience_value AS audience, COUNT(*) AS members, MAX(updated_at) AS updated_at FROM targeting_members"
    rows = db.query(sql + (" WHERE key = ?" if key else "") + " GROUP BY key, audience_value ORDER BY key, audience_value", (key,) if key else ())
    return rows


# ---- who may call the lookup API ------------------------------------------------------------

def clients() -> list[str]:
    return [c.lower() for c in (db.get_setting("targeting_clients") or [])]


def set_clients(values: list[str]) -> list[str]:
    cleaned = sorted({v.strip().lower() for v in values if v and v.strip()})
    db.set_setting("targeting_clients", cleaned)
    return cleaned
