"""Source connectors. `databricks` is the real one; `demo` is a seeded SQLite
warehouse so the prototype is usable without Databricks credentials."""
import random
import sqlite3
from datetime import date, timedelta
from typing import Any

from .db import DATA_DIR
from .rules import categorize


class SourceError(Exception):
    pass


class DemoConnector:
    dialect = "sqlite"
    path = DATA_DIR / "demo_warehouse.db"

    def __init__(self, config: dict):
        self._seed()

    @classmethod
    def _seed(cls):
        if cls.path.exists():
            return
        rnd = random.Random(7)
        con = sqlite3.connect(cls.path)
        con.execute(
            """CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
            country TEXT, plan TEXT, age INTEGER, phone TEXT, is_subscribed BOOLEAN,
            lifetime_value REAL, signup_date DATE, last_login TIMESTAMP)"""
        )
        firsts = ["Ava", "Liam", "Noah", "Mia", "Zoe", "Ethan", "Ivy", "Leo", "Nina", "Omar", "Priya", "Sam"]
        lasts = ["Smith", "Jones", "Patel", "Garcia", "Kim", "Brown", "Lee", "Khan", "Rossi", "Nguyen"]
        countries = ["US", "GB", "IN", "DE", "FR", "CA", "AU"]
        plans = ["free", "pro", "enterprise"]
        domains = ["gmail.com", "yahoo.com", "acme.io", "example.org", "outlook.com"]
        rows = []
        for i in range(1, 501):
            f, l = rnd.choice(firsts), rnd.choice(lasts)
            email = f"{f}.{l}{i}@{rnd.choice(domains)}".lower() if rnd.random() > 0.04 else None
            signup = date.today() - timedelta(days=rnd.randint(0, 900))
            last = signup + timedelta(days=rnd.randint(0, max((date.today() - signup).days, 0)))
            rows.append((
                i, email, f, l, rnd.choice(countries), rnd.choice(plans), rnd.randint(18, 70),
                rnd.choice([None, "", f"+1555{rnd.randint(1000000, 9999999)}"]),
                rnd.random() > 0.35, round(rnd.random() * 2000, 2), signup.isoformat(),
                f"{last.isoformat()} 12:00:00",
            ))
        con.executemany("INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        con.execute(
            "CREATE TABLE orders (order_id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT, "
            "total REAL, status TEXT, ordered_at DATE)"
        )
        orders = []
        for i in range(1, 801):
            u = rnd.choice(rows)
            orders.append((
                i, u[0], u[1], round(rnd.random() * 300, 2), rnd.choice(["paid", "refunded", "pending"]),
                (date.today() - timedelta(days=rnd.randint(0, 400))).isoformat(),
            ))
        con.executemany("INSERT INTO orders VALUES (?,?,?,?,?,?)", orders)
        con.commit()
        con.close()

    def _con(self):
        return sqlite3.connect(self.path)

    def test(self):
        self.tables()
        return "Demo warehouse (SQLite) OK"

    def catalogs(self) -> list[str]:
        return ["demo"]

    def tables(self, catalog: str | None = None) -> list[str]:
        with self._con() as c:
            return [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")]

    def columns(self, table: str) -> list[dict]:
        name = table.split(".")[-1].replace('"', "")
        with self._con() as c:
            rows = c.execute(f'PRAGMA table_info("{name}")').fetchall()
        if not rows:
            raise SourceError(f"Table '{table}' not found")
        return [{"name": r[1], "type": r[2], "category": categorize(r[2]), "comment": ""} for r in rows]

    def run(self, sql: str, params: list) -> tuple[list[str], list[tuple[Any, ...]]]:
        with self._con() as c:
            cur = c.execute(sql, params)
            return [d[0] for d in cur.description], cur.fetchall()


class DatabricksConnector:
    dialect = "databricks"

    def __init__(self, config: dict):
        if config.get("from_env"):  # credentials come from backend/.env, never stored in the DB
            import os
            host = os.environ.get("DATABRICKS_HOST", "").replace("https://", "").rstrip("/")
            state = os.environ.get("CDP_STATE_SCHEMA", "")
            config = {
                "server_hostname": host,
                "http_path": f"/sql/1.0/warehouses/{os.environ.get('DATABRICKS_WAREHOUSE_ID', '')}",
                "access_token": os.environ.get("DATABRICKS_TOKEN", ""),
                "catalog": state.split(".")[0] if state else "",
                "schema": "",
            }
        self.cfg = config

    def _connect(self):
        try:
            from databricks import sql
        except ImportError as e:
            raise SourceError("databricks-sql-connector is not installed") from e
        try:
            return sql.connect(
                server_hostname=self.cfg["server_hostname"],
                http_path=self.cfg["http_path"],
                access_token=self.cfg["access_token"],
                catalog=self.cfg.get("catalog") or None,
                schema=self.cfg.get("schema") or None,
            )
        except Exception as e:
            raise SourceError(f"Databricks connection failed: {e}") from e

    def run(self, sql: str, params: list | None = None):
        with self._connect() as con, con.cursor() as cur:
            try:
                cur.execute(sql, params or None)
                rows = cur.fetchall()
            except Exception as e:
                raise SourceError(f"Databricks query failed: {e}") from e
            return [d[0] for d in cur.description], [tuple(r) for r in rows]

    def test(self):
        self.run("SELECT 1")
        return "Connected to Databricks SQL warehouse"

    def catalogs(self) -> list[str]:
        return sorted(r[0] for r in self.run("SHOW CATALOGS")[1])

    def tables(self, catalog: str | None = None) -> list[str]:
        cat, sch = catalog or self.cfg.get("catalog"), self.cfg.get("schema")
        if not cat or not cat.replace("_", "").isalnum():
            return []
        where = "table_schema <> 'information_schema'" + (f" AND table_schema = '{sch}'" if sch and not catalog else "")
        _, rows = self.run(f"SELECT table_schema, table_name FROM `{cat}`.information_schema.tables WHERE {where} ORDER BY 1, 2")
        return [f"{cat}.{r[0]}.{r[1]}" for r in rows]

    def columns(self, table: str) -> list[dict]:
        parts = table.split(".")
        if not all(p.replace("_", "").isalnum() for p in parts):
            raise SourceError("Invalid table name")
        _, rows = self.run("DESCRIBE TABLE " + ".".join(f"`{p}`" for p in parts))
        out = []
        for r in rows:
            if not r[0] or r[0].startswith("#"):
                break  # partition / metadata section
            out.append({"name": r[0], "type": r[1], "category": categorize(r[1]), "comment": (r[2] or "") if len(r) > 2 else ""})
        return out


def get_source(conn) -> DemoConnector | DatabricksConnector:
    if conn.kind == "demo":
        return DemoConnector(conn.config)
    if conn.kind == "databricks":
        return DatabricksConnector(conn.config)
    raise SourceError(f"'{conn.kind}' is not a source")
