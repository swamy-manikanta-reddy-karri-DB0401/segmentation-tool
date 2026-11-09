"""Thin client for the Databricks SQL Statement Execution API.

Uses plain HTTPS (no ODBC/JDBC driver). Queries are always parameterized:
callers pass `params` as a list of {"name", "value", "type"} dicts and refer
to them as `:name` in the SQL text.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Iterator

import httpx

from . import connection

INT_TYPES = {"LONG", "INT", "SHORT", "BYTE"}
FLOAT_TYPES = {"DOUBLE", "FLOAT", "DECIMAL"}


class DatabricksError(Exception):
    pass


@dataclass
class Result:
    columns: list[dict]
    rows: list[list[Any]]

    @property
    def column_names(self) -> list[str]:
        return [c["name"] for c in self.columns]

    def dicts(self) -> list[dict]:
        names = self.column_names
        return [dict(zip(names, r)) for r in self.rows]


def _convert(value: str | None, type_name: str) -> Any:
    if value is None:
        return None
    if type_name in INT_TYPES:
        return int(value)
    if type_name in FLOAT_TYPES:
        return float(value)
    if type_name == "BOOLEAN":
        return value.lower() == "true"
    return value


class _Bearer(httpx.Auth):
    """Adds a fresh bearer token to every request (OAuth tokens expire after an hour)."""

    def __init__(self, conn: dict):
        self.conn = conn

    def auth_flow(self, request):
        request.headers["Authorization"] = f"Bearer {connection.bearer(self.conn)}"
        yield request


class DatabricksClient:
    def __init__(self, conn: dict | None = None):
        conn = conn or connection.get()
        self.connection_id = conn.get("id")
        self.host = conn["host"].rstrip("/")
        self.warehouse_id = conn["warehouse_id"]
        self._http = httpx.Client(base_url=self.host, auth=_Bearer(conn), timeout=httpx.Timeout(120.0, connect=15.0))
        # Presigned external links must be fetched WITHOUT the auth header.
        self._plain = httpx.Client(timeout=httpx.Timeout(300.0, connect=15.0))

    # ---- warehouse -------------------------------------------------------
    def warehouse_info(self) -> dict:
        r = self._http.get(f"/api/2.0/sql/warehouses/{self.warehouse_id}")
        self._raise(r)
        d = r.json()
        return {"id": d["id"], "name": d["name"], "state": d["state"], "size": d.get("cluster_size")}

    # ---- statements ------------------------------------------------------
    def _submit(self, sql: str, params: list[dict] | None, disposition: str) -> dict:
        body = {
            "warehouse_id": self.warehouse_id,
            "statement": sql,
            "wait_timeout": "30s",
            "on_wait_timeout": "CONTINUE",
            "disposition": disposition,
            "format": "JSON_ARRAY",
        }
        if params:
            body["parameters"] = params
        r = self._http.post("/api/2.0/sql/statements", json=body)
        self._raise(r)
        d = r.json()
        deadline = time.time() + 900
        while d["status"]["state"] in ("PENDING", "RUNNING"):
            if time.time() > deadline:
                self._http.post(f"/api/2.0/sql/statements/{d['statement_id']}/cancel")
                raise DatabricksError("Query timed out after 15 minutes")
            time.sleep(1.5)
            r = self._http.get(f"/api/2.0/sql/statements/{d['statement_id']}")
            self._raise(r)
            d = r.json()
        if d["status"]["state"] != "SUCCEEDED":
            err = d["status"].get("error", {})
            raise DatabricksError(err.get("message") or d["status"]["state"])
        return d

    def _columns(self, d: dict) -> list[dict]:
        schema = d.get("manifest", {}).get("schema", {})
        return schema.get("columns", []) or []

    def execute(self, sql: str, params: list[dict] | None = None) -> Result:
        """Run a statement and return all rows (INLINE; fine up to ~25 MB)."""
        d = self._submit(sql, params, "INLINE")
        cols = self._columns(d)
        return Result(cols, list(self._iter_inline(d, cols)))

    def iter_rows(self, sql: str, params: list[dict] | None = None) -> tuple[list[dict], Iterator[list[Any]]]:
        """Run a statement whose result may be large; stream rows chunk by chunk."""
        d = self._submit(sql, params, "EXTERNAL_LINKS")
        cols = self._columns(d)
        return cols, self._iter_external(d, cols)

    def _typed(self, rows: list[list], cols: list[dict]) -> Iterator[list[Any]]:
        types = [c.get("type_name", "STRING") for c in cols]
        for row in rows:
            yield [_convert(v, t) for v, t in zip(row, types)]

    def _iter_inline(self, d: dict, cols: list[dict]) -> Iterator[list[Any]]:
        result = d.get("result") or {}
        while True:
            yield from self._typed(result.get("data_array") or [], cols)
            link = result.get("next_chunk_internal_link")
            if not link:
                return
            r = self._http.get(link)
            self._raise(r)
            result = r.json()

    def _iter_external(self, d: dict, cols: list[dict]) -> Iterator[list[Any]]:
        result = d.get("result") or {}
        while True:
            links = result.get("external_links") or []
            if not links:
                return
            next_link = None
            for link in links:
                r = self._plain.get(link["external_link"])
                r.raise_for_status()
                yield from self._typed(r.json(), cols)
                next_link = link.get("next_chunk_internal_link")
            if not next_link:
                return
            r = self._http.get(next_link)
            self._raise(r)
            result = r.json()

    def close(self) -> None:
        self._http.close()
        self._plain.close()

    @staticmethod
    def _raise(r: httpx.Response) -> None:
        if r.status_code >= 400:
            try:
                msg = r.json().get("message", r.text)
            except Exception:
                msg = r.text
            raise DatabricksError(f"HTTP {r.status_code}: {msg}")


_clients: dict[int, DatabricksClient] = {}


def client(connection_id: int | None = None) -> DatabricksClient:
    """Client for a connection (default: the one the current request or sync run is using)."""
    cid = connection_id or connection.current_id()
    if not cid:
        raise DatabricksError("No Databricks connection yet. Add one on the Sources page.")
    if cid not in _clients:
        _clients[cid] = DatabricksClient(connection.get(cid))
    return _clients[cid]


def reset_client(connection_id: int | None = None) -> None:
    """Drop cached clients so the next call picks up edited connection settings."""
    for cid in [connection_id] if connection_id else list(_clients):
        old = _clients.pop(cid, None)
        if old:
            old.close()
