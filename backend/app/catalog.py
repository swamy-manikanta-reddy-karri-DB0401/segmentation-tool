"""Unity Catalog introspection: catalogs, schemas, tables, columns, values."""
from __future__ import annotations

import re
import time

from . import connection
from .databricks import client

IDENT_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

_cache: dict[tuple, tuple[float, object]] = {}
CACHE_TTL = 600


def clear_cache() -> None:
    _cache.clear()


def _cached(key: tuple, fn):
    key = (connection.current_id(), *key)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


def quote_ident(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def quote_table(table_ref: str) -> str:
    parts = table_ref.split(".")
    if len(parts) != 3 or not all(IDENT_RE.match(p) for p in parts):
        raise ValueError(f"Invalid table reference: {table_ref!r} (expected catalog.schema.table)")
    return ".".join(quote_ident(p) for p in parts)


def quote_column(path: str, alias: str | None = None) -> str:
    """`metadata.device` -> `metadata`.`device` (struct field access)."""
    q = ".".join(quote_ident(p) for p in path.split("."))
    return f"{alias}.{q}" if alias else q


def semantic_type(data_type: str) -> str:
    t = data_type.lower()
    if t.startswith(("string", "varchar", "char")):
        return "string"
    if t.startswith(("bigint", "int", "smallint", "tinyint", "long", "short", "byte", "double", "float", "decimal")):
        return "number"
    if t.startswith("boolean"):
        return "boolean"
    if t.startswith("timestamp"):
        return "timestamp"
    if t == "date":
        return "date"
    return "other"


def _split_top_level(s: str) -> list[str]:
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch in "<(":
            depth += 1
        elif ch in ">)":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur:
        parts.append(cur)
    return parts


def _flatten(name: str, data_type: str, comment: str | None) -> list[dict]:
    if data_type.lower().startswith("struct<") and data_type.endswith(">"):
        out = []
        for field in _split_top_level(data_type[7:-1]):
            fname, _, ftype = field.partition(":")
            out.extend(_flatten(f"{name}.{fname.strip()}", ftype.strip(), None))
        return out
    return [{"name": name, "data_type": data_type, "type": semantic_type(data_type), "description": comment or ""}]


def list_catalogs() -> list[str]:
    return _cached(("catalogs",), lambda: [r[0] for r in client().execute("SHOW CATALOGS").rows])


def list_schemas(catalog: str) -> list[str]:
    if not IDENT_RE.match(catalog):
        raise ValueError("Invalid catalog")
    return _cached(
        ("schemas", catalog),
        lambda: [r[0] for r in client().execute(f"SHOW SCHEMAS IN {quote_ident(catalog)}").rows if r[0] != "information_schema"],
    )


def list_tables(catalog: str, schema: str) -> list[str]:
    if not (IDENT_RE.match(catalog) and IDENT_RE.match(schema)):
        raise ValueError("Invalid catalog/schema")
    def load():
        res = client().execute(f"SHOW TABLES IN {quote_ident(catalog)}.{quote_ident(schema)}")
        idx = res.column_names.index("tableName")
        return sorted(r[idx] for r in res.rows)

    return _cached(("tables", catalog, schema), load)


def describe(table_ref: str, refresh: bool = False) -> list[dict]:
    key = ("describe", table_ref)
    if refresh:
        _cache.pop((connection.current_id(), *key), None)

    def load():
        cols = []
        for name, data_type, comment in client().execute(f"DESCRIBE TABLE {quote_table(table_ref)}").rows:
            if not name or name.startswith("#"):
                break  # partition / metadata section
            cols.extend(_flatten(name, data_type, comment))
        return cols

    return _cached(key, load)


def column_values(table_ref: str, column: str, search: str = "", limit: int = 50) -> list[dict]:
    cols = {c["name"] for c in describe(table_ref)}
    if column not in cols:
        raise ValueError(f"Unknown column {column}")
    col = quote_column(column)
    params = []
    where = f"WHERE {col} IS NOT NULL"
    if search:
        where += f" AND lower(CAST({col} AS STRING)) LIKE :q"
        params.append({"name": "q", "value": f"%{search.lower()}%", "type": "STRING"})
    sql = (
        f"SELECT CAST({col} AS STRING) AS value, COUNT(*) AS n FROM {quote_table(table_ref)} "
        f"{where} GROUP BY 1 ORDER BY n DESC LIMIT {int(limit)}"
    )
    return _cached(
        ("values", table_ref, column, search),
        lambda: [{"value": v, "count": n} for v, n in client().execute(sql, params).rows],
    )


def describe_sql(sql: str) -> list[dict]:
    """Columns of a SQL query model (admin-authored SELECT)."""
    sql = sql.strip().rstrip(";")
    if not re.match(r"^\s*(select|with)\b", sql, re.I):
        raise ValueError("SQL models must start with SELECT or WITH")
    cols = []
    for name, data_type, comment, *_ in client().execute(f"DESCRIBE QUERY {sql}").rows:
        if not name or name.startswith("#"):
            break
        cols.extend(_flatten(name, data_type, comment))
    return cols


def values_for(src: str, columns: list[dict], column: str, search: str = "", limit: int = 50) -> list[dict]:
    """Distinct values (with counts) of a column of any model source (table or SQL)."""
    if column not in {c["name"] for c in columns}:
        raise ValueError(f"Unknown column {column}")
    col = quote_column(column)
    params = []
    where = f"WHERE {col} IS NOT NULL"
    if search:
        where += f" AND lower(CAST({col} AS STRING)) LIKE :q"
        params.append({"name": "q", "value": f"%{search.lower()}%", "type": "STRING"})
    sql = f"SELECT CAST({col} AS STRING) AS value, COUNT(*) AS n FROM {src} {where} GROUP BY 1 ORDER BY n DESC LIMIT {int(limit)}"
    return _cached(("values", src, column, search),
                   lambda: [{"value": v, "count": n} for v, n in client().execute(sql, params).rows])
