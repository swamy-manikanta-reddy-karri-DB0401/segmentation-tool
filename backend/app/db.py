"""App metadata store (SQLite). Customer data never lands here — only config,
segment definitions, sync settings and run logs."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('parent', 'related', 'event')),
    name TEXT NOT NULL,
    table_ref TEXT NOT NULL,
    primary_key TEXT,
    label_column TEXT,
    foreign_key TEXT,
    parent_key TEXT,
    timestamp_column TEXT,
    event_name_column TEXT,
    columns TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audiences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    definition TEXT NOT NULL,
    last_size INTEGER,
    size_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS destinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS syncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    audience_id INTEGER NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
    destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    config TEXT NOT NULL,
    schedule_minutes INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_id INTEGER NOT NULL REFERENCES syncs(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'manual',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    audience_rows INTEGER,
    added INTEGER DEFAULT 0,
    changed INTEGER DEFAULT 0,
    removed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    error TEXT,
    details TEXT NOT NULL DEFAULT '{}'
);
"""

JSON_COLUMNS = {"columns", "definition", "config", "details", "value", "schedule", "join_keys",
                "merge_columns", "column_settings", "splits"}

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA foreign_keys = ON")
        _conn.executescript(SCHEMA)
        _migrate(_conn)
    return _conn


EXTRA_TABLES = """
CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'oauth',
    client_id TEXT NOT NULL DEFAULT '',
    secret TEXT NOT NULL DEFAULT '',
    warehouse_id TEXT NOT NULL,
    state_schema TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS traits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS destination_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS priority_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""

ADDED_COLUMNS = {
    "models": {
        "parent_id": "INTEGER", "relationship": "TEXT", "join_keys": "TEXT NOT NULL DEFAULT '[]'",
        "secondary_label": "TEXT", "query_type": "TEXT NOT NULL DEFAULT 'table'", "sql": "TEXT",
        "merge_columns": "TEXT NOT NULL DEFAULT '[]'", "column_settings": "TEXT NOT NULL DEFAULT '{}'",
        "description": "TEXT NOT NULL DEFAULT ''", "connection_id": "INTEGER",
    },
    "audiences": {"parent_id": "INTEGER", "splits": "TEXT NOT NULL DEFAULT '{}'"},
}


def _migrate(c: sqlite3.Connection) -> None:
    c.executescript(EXTRA_TABLES)
    for table, columns in ADDED_COLUMNS.items():
        have = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
        for name, ddl in columns.items():
            if name not in have:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    # Backfill: single-parent workspaces from earlier versions.
    parent = c.execute("SELECT id FROM models WHERE kind = 'parent' ORDER BY id LIMIT 1").fetchone()
    if parent:
        c.execute("UPDATE models SET parent_id = ? WHERE kind != 'parent' AND parent_id IS NULL", (parent[0],))
        c.execute("UPDATE audiences SET parent_id = ? WHERE parent_id IS NULL", (parent[0],))
    for mid, fk, pk in c.execute("SELECT id, foreign_key, parent_key FROM models WHERE kind != 'parent' AND join_keys = '[]'").fetchall():
        if fk:
            parent_pk = c.execute("SELECT p.primary_key FROM models m JOIN models p ON p.id = m.parent_id WHERE m.id = ?", (mid,)).fetchone()
            c.execute("UPDATE models SET join_keys = ?, relationship = COALESCE(relationship, '1:many') WHERE id = ?",
                      (json.dumps([{"parent": pk or (parent_pk[0] if parent_pk else fk), "model": fk}]), mid))
    cols = {r[1] for r in c.execute("PRAGMA table_info(syncs)")}
    if "schedule" not in cols:
        c.execute("ALTER TABLE syncs ADD COLUMN schedule TEXT NOT NULL DEFAULT '{\"type\": \"manual\"}'")
        c.execute("ALTER TABLE syncs ADD COLUMN next_run_at TEXT")
        for sid, minutes in c.execute("SELECT id, schedule_minutes FROM syncs WHERE schedule_minutes > 0").fetchall():
            c.execute("UPDATE syncs SET schedule = ? WHERE id = ?",
                      (json.dumps({"type": "interval", "every": minutes, "unit": "minutes"}), sid))
    c.commit()


def _decode(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    for k in JSON_COLUMNS & d.keys():
        if isinstance(d[k], str):
            d[k] = json.loads(d[k])
    if "enabled" in d:
        d["enabled"] = bool(d["enabled"])
    return d


def _encode(values: dict) -> dict:
    return {k: json.dumps(v) if k in JSON_COLUMNS else v for k, v in values.items()}


def query(sql: str, args: tuple = ()) -> list[dict]:
    with _lock:
        return [_decode(r) for r in conn().execute(sql, args).fetchall()]


def one(sql: str, args: tuple = ()) -> dict | None:
    with _lock:
        return _decode(conn().execute(sql, args).fetchone())


def insert(table: str, values: dict) -> int:
    values = _encode(values)
    cols = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    with _lock:
        c = conn()
        cur = c.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(values.values()))
        c.commit()
        return cur.lastrowid


def update(table: str, id_: int, values: dict) -> None:
    if not values:
        return
    values = _encode(values)
    sets = ", ".join(f"{k} = ?" for k in values)
    with _lock:
        c = conn()
        c.execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*values.values(), id_))
        c.commit()


def delete(table: str, id_: int) -> None:
    with _lock:
        c = conn()
        c.execute(f"DELETE FROM {table} WHERE id = ?", (id_,))
        c.commit()


def get_setting(key: str, default: Any = None) -> Any:
    row = one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: Any) -> None:
    with _lock:
        c = conn()
        c.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )
        c.commit()
