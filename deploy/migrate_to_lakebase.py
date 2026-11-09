"""Copy the local SQLite metadata store (data/cdp.sqlite3) into the app's Lakebase schema.

Run once, after the app has started on Lakebase (it creates the schema and tables, owned by its service
principal, and grants PG_GRANT_TO access). Rows keep their IDs; rows that already exist are skipped, so
the script can be re-run safely.

    python deploy/migrate_to_lakebase.py
"""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

import psycopg
from databricks.sdk import WorkspaceClient
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
load_dotenv(ROOT / ".env")

ENDPOINT = os.environ.get("CDP_LAKEBASE_ENDPOINT", "projects/mediamint-cdp/branches/production/endpoints/primary")
HOST = os.environ.get("CDP_PGHOST", "ep-restless-mouse-e7ifptx8.database.centralindia.azuredatabricks.net")
SCHEMA = os.environ.get("PGSCHEMA", "cdp")
# parents before children (foreign keys)
TABLES = ["settings", "connections", "brands", "models", "traits", "audiences", "destinations", "destination_rules",
          "priority_lists", "sync_templates", "syncs", "sync_runs", "role_bindings", "audit_log"]


def main() -> None:
    # Make sure the local store has the latest columns and a brand for existing data.
    os.environ.pop("LAKEBASE_ENDPOINT", None)
    from app import access, db
    db.conn()
    access.seed()

    src = sqlite3.connect(ROOT / "data" / "cdp.sqlite3")
    src.row_factory = sqlite3.Row
    w = WorkspaceClient(host=os.environ["DATABRICKS_HOST"], token=os.environ["DATABRICKS_TOKEN"])
    user = w.current_user.me().user_name
    token = w.postgres.generate_database_credential(endpoint=ENDPOINT).token
    with psycopg.connect(f"host={HOST} dbname=databricks_postgres user={user} sslmode=require", password=token,
                         autocommit=True, options=f"-c search_path={SCHEMA}") as pg:
        for table in TABLES:
            pg_cols = [r[0] for r in pg.execute("SELECT column_name FROM information_schema.columns "
                                                "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
                                                (SCHEMA, table)).fetchall()]
            if not pg_cols:
                sys.exit(f"Table {SCHEMA}.{table} doesn't exist yet — start the app once so it creates its tables")
            rows = src.execute(f"SELECT * FROM {table}").fetchall()
            if table == "role_bindings":  # local preview personas stay local
                rows = [r for r in rows if not r["principal"].endswith("@demo.test")]
            cols = [c for c in rows[0].keys() if c in pg_cols] if rows else []
            key = "key" if table == "settings" else "id"
            added = 0
            for r in rows:
                cur = pg.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) "
                                 f"ON CONFLICT ({key}) DO NOTHING", [r[c] for c in cols])
                added += cur.rowcount
            if key == "id":
                pg.execute(f"SELECT setval(pg_get_serial_sequence(%s, 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM {table}), 1))",
                           (f"{SCHEMA}.{table}",))
            print(f"{table:18} {len(rows):4} rows in SQLite, {added:4} copied")


if __name__ == "__main__":
    main()
