"""App metadata store. Customer data never lands here — only config, segment definitions,
sync settings, access control and run logs.

Two backends with one interface (query / one / insert / update / delete / execute):
* Lakebase Postgres when ``LAKEBASE_ENDPOINT`` and ``PGHOST`` are set (Databricks Apps deployment).
  Connections sign in with short-lived Databricks OAuth tokens, minted per new pooled connection.
* SQLite (data/cdp.sqlite3) otherwise — local development and tests.

SQL is written once with ``?`` placeholders and SQLite-style DDL; it is translated for Postgres.
"""
from __future__ import annotations

import atexit
import json
import os
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
CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS role_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
    principal TEXT NOT NULL,
    role TEXT NOT NULL,
    brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    destination_ids TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    permissions TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    channel TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    severity TEXT NOT NULL DEFAULT 'all',
    destination_ids TEXT NOT NULL DEFAULT '[]',
    brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK (scope IN ('destination', 'sync')),
    scope_id INTEGER NOT NULL,
    triggers TEXT NOT NULL DEFAULT '{}',
    recipient_ids TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (scope, scope_id)
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_id INTEGER NOT NULL REFERENCES syncs(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'healthy',
    message TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    opened_at TEXT,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    muted_until TEXT,
    last_run_id INTEGER,
    UNIQUE (sync_id, trigger)
);
CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
    sync_id INTEGER NOT NULL REFERENCES syncs(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    old_status TEXT NOT NULL,
    new_status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0,
    deliveries TEXT NOT NULL DEFAULT '[]',
    run_id INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id INTEGER,
    brand_id INTEGER,
    details TEXT NOT NULL DEFAULT '{}'
);
"""

ADDED_COLUMNS = {
    "models": {
        "parent_id": "INTEGER", "relationship": "TEXT", "join_keys": "TEXT NOT NULL DEFAULT '[]'",
        "secondary_label": "TEXT", "query_type": "TEXT NOT NULL DEFAULT 'table'", "sql": "TEXT",
        "merge_columns": "TEXT NOT NULL DEFAULT '[]'", "column_settings": "TEXT NOT NULL DEFAULT '{}'",
        "description": "TEXT NOT NULL DEFAULT ''", "connection_id": "INTEGER", "brand_id": "INTEGER",
    },
    "audiences": {"parent_id": "INTEGER", "splits": "TEXT NOT NULL DEFAULT '{}'", "created_by": "TEXT NOT NULL DEFAULT ''"},
    "destinations": {"brand_id": "INTEGER"},
    "syncs": {
        "schedule": "TEXT NOT NULL DEFAULT '{\"type\": \"manual\"}'", "next_run_at": "TEXT",
        # maker-checker: a sync only runs once approved
        "approval_status": "TEXT NOT NULL DEFAULT 'approved'", "created_by": "TEXT NOT NULL DEFAULT ''",
        "submitted_by": "TEXT NOT NULL DEFAULT ''", "approved_by": "TEXT NOT NULL DEFAULT ''",
        "approved_at": "TEXT", "review_note": "TEXT NOT NULL DEFAULT ''",
    },
}

JSON_COLUMNS = {"columns", "definition", "config", "details", "value", "schedule", "join_keys",
                "merge_columns", "column_settings", "splits", "destination_ids", "triggers", "recipient_ids", "deliveries", "permissions"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---- backends ---------------------------------------------------------------------

class _SQLite:
    kind = "sqlite"

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.c = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        self.c.row_factory = sqlite3.Row
        self.c.execute("PRAGMA foreign_keys = ON")

    def run(self, sql: str, args: tuple = (), fetch: str | None = None, returning: bool = False):
        with self.lock:
            cur = self.c.execute(sql, args)
            out = (cur.fetchall() if fetch == "all" else cur.fetchone() if fetch == "one" else
                   cur.lastrowid if returning else None)
            if not fetch:
                self.c.commit()
            return [dict(r) for r in out] if fetch == "all" else (dict(out) if fetch == "one" and out else out)

    def script(self, sql: str) -> None:
        with self.lock:
            self.c.executescript(sql)

    def many(self, sql: str, rows: list[tuple]) -> None:
        with self.lock:
            self.c.executemany(sql, rows)
            self.c.commit()

    def columns(self, table: str) -> set[str]:
        with self.lock:
            return {r[1] for r in self.c.execute(f"PRAGMA table_info({table})")}


class _Postgres:
    kind = "postgres"

    def __init__(self) -> None:
        import psycopg
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool
        from databricks.sdk import WorkspaceClient

        endpoint = os.environ["LAKEBASE_ENDPOINT"]
        ws = WorkspaceClient()
        # In a Databricks App the Postgres role is the app's service principal (its client ID).
        user = os.environ.get("PGUSER") or os.environ.get("DATABRICKS_CLIENT_ID") or ws.current_user.me().user_name

        class OAuthConnection(psycopg.Connection):
            @classmethod
            def connect(cls, conninfo: str = "", **kwargs):
                # A fresh Lakebase OAuth token (valid 1 h) for every new pooled connection.
                kwargs["password"] = ws.postgres.generate_database_credential(endpoint=endpoint).token
                return super().connect(conninfo, **kwargs)

        conninfo = (f"dbname={os.environ.get('PGDATABASE', 'databricks_postgres')} user={user} "
                    f"host={os.environ['PGHOST']} port={os.environ.get('PGPORT', '5432')} "
                    f"sslmode={os.environ.get('PGSSLMODE', 'require')}")
        self.schema = os.environ.get("PGSCHEMA", "cdp")
        self.pool = ConnectionPool(conninfo, connection_class=OAuthConnection, min_size=1, max_size=8, open=True,
                                   max_lifetime=45 * 60,  # recycle before the 1 h token expires
                                   kwargs={"autocommit": True, "row_factory": dict_row,
                                           "options": f"-c search_path={self.schema}"})
        with self.pool.connection() as c:
            c.execute(f'CREATE SCHEMA IF NOT EXISTS "{self.schema}"')
        atexit.register(self.pool.close)

    def grant(self) -> None:
        """Optional: let named Postgres roles (PG_GRANT_TO, comma separated) read and write the app's tables,
        e.g. a DBA, or a person migrating data in."""
        for role in filter(None, (r.strip() for r in os.environ.get("PG_GRANT_TO", "").split(","))):
            q = '"' + role.replace('"', '') + '"'
            with self.pool.connection() as c:
                c.execute(f'GRANT USAGE ON SCHEMA "{self.schema}" TO {q}')
                c.execute(f'GRANT ALL ON ALL TABLES IN SCHEMA "{self.schema}" TO {q}')
                c.execute(f'GRANT ALL ON ALL SEQUENCES IN SCHEMA "{self.schema}" TO {q}')

    @staticmethod
    def _sql(sql: str, has_args: bool) -> str:
        if has_args:
            sql = sql.replace("%", "%%").replace("?", "%s")
        return sql

    def run(self, sql: str, args: tuple = (), fetch: str | None = None, returning: bool = False):
        if returning:
            sql += " RETURNING id"
        with self.pool.connection() as c:
            cur = c.execute(self._sql(sql, bool(args)), args or None)
            if fetch == "all":
                return cur.fetchall()
            if fetch == "one" or returning:
                row = cur.fetchone()
                return row["id"] if returning else row
            return None

    def many(self, sql: str, rows: list[tuple]) -> None:
        with self.pool.connection() as c, c.cursor() as cur:
            cur.executemany(self._sql(sql, True), rows)

    def script(self, sql: str) -> None:
        sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
        with self.pool.connection() as c:
            for stmt in filter(str.strip, sql.split(";")):
                c.execute(stmt)

    def columns(self, table: str) -> set[str]:
        rows = self.run("SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
                        (self.schema, table), fetch="all")
        return {r["column_name"] for r in rows}


_backend: _SQLite | _Postgres | None = None
_init_lock = threading.Lock()


def backend():
    global _backend
    if _backend is None:
        with _init_lock:
            if _backend is None:
                b = _Postgres() if os.environ.get("LAKEBASE_ENDPOINT") and os.environ.get("PGHOST") else _SQLite()
                b.script(SCHEMA)
                _migrate(b)
                if isinstance(b, _Postgres):
                    b.grant()
                _backend = b
    return _backend


def kind() -> str:
    return backend().kind


def conn():
    """Initialise the store (kept for callers that used to open the SQLite connection)."""
    return backend()


def _migrate(b) -> None:
    for table, columns in ADDED_COLUMNS.items():
        have = b.columns(table)
        for name, ddl in columns.items():
            if name not in have:
                b.run(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    # Backfill: single-parent workspaces from earlier versions.
    parent = b.run("SELECT id FROM models WHERE kind = 'parent' ORDER BY id LIMIT 1", fetch="one")
    if parent:
        b.run("UPDATE models SET parent_id = ? WHERE kind != 'parent' AND parent_id IS NULL", (parent["id"],))
        b.run("UPDATE audiences SET parent_id = ? WHERE parent_id IS NULL", (parent["id"],))
    for m in b.run("SELECT id, foreign_key, parent_key FROM models WHERE kind != 'parent' AND join_keys = '[]'", fetch="all"):
        if m["foreign_key"]:
            parent_pk = b.run("SELECT p.primary_key FROM models m JOIN models p ON p.id = m.parent_id WHERE m.id = ?",
                              (m["id"],), fetch="one")
            b.run("UPDATE models SET join_keys = ?, relationship = COALESCE(relationship, '1:many') WHERE id = ?",
                  (json.dumps([{"parent": m["parent_key"] or (parent_pk["primary_key"] if parent_pk else m["foreign_key"]),
                                "model": m["foreign_key"]}]), m["id"]))
    for s in b.run("SELECT id, schedule_minutes FROM syncs WHERE schedule_minutes > 0 AND schedule = ?",
                   ('{"type": "manual"}',), fetch="all"):
        b.run("UPDATE syncs SET schedule = ? WHERE id = ?",
              (json.dumps({"type": "interval", "every": s["schedule_minutes"], "unit": "minutes"}), s["id"]))


# ---- row helpers --------------------------------------------------------------------

def _decode(row: dict | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    for k in JSON_COLUMNS & d.keys():
        if isinstance(d[k], str):
            d[k] = json.loads(d[k])
    if "enabled" in d:
        d["enabled"] = bool(d["enabled"])
    return d


def _value(k: str, v):
    if k in JSON_COLUMNS:
        return json.dumps(v)
    return int(v) if isinstance(v, bool) else v  # Postgres won't store a boolean in an INTEGER column


def _encode(values: dict) -> dict:
    return {k: _value(k, v) for k, v in values.items()}


def _args(args: tuple) -> tuple:
    return tuple(int(a) if isinstance(a, bool) else a for a in args)


def query(sql: str, args: tuple = ()) -> list[dict]:
    return [_decode(r) for r in backend().run(sql, _args(args), fetch="all")]


def one(sql: str, args: tuple = ()) -> dict | None:
    return _decode(backend().run(sql, _args(args), fetch="one"))


def execute(sql: str, args: tuple = ()) -> None:
    backend().run(sql, _args(args))


def executemany(sql: str, rows: list[tuple]) -> None:
    """Run one statement for many parameter rows in a single round trip (bulk upserts/deletes)."""
    if rows:
        backend().many(sql, [_args(r) for r in rows])


def insert(table: str, values: dict) -> int:
    values = _encode(values)
    cols = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    return backend().run(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(values.values()), returning=True)


def update(table: str, id_: int, values: dict) -> None:
    if not values:
        return
    values = _encode(values)
    sets = ", ".join(f"{k} = ?" for k in values)
    backend().run(f"UPDATE {table} SET {sets} WHERE id = ?", (*values.values(), id_))


def delete(table: str, id_: int) -> None:
    backend().run(f"DELETE FROM {table} WHERE id = ?", (id_,))


def get_setting(key: str, default: Any = None) -> Any:
    row = one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: Any) -> None:
    backend().run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                  (key, json.dumps(value)))

