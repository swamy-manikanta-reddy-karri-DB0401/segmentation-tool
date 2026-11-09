"""Load the User Profile / User Engagement sheets of an Excel workbook into Databricks.

    python scripts/load_excel.py <path/to/Schema.xlsx> <catalog.schema>

Column types are inferred from the data: text -> STRING, true/false -> BOOLEAN,
dates -> TIMESTAMP, numbers -> BIGINT when every value is whole, else DOUBLE.
User Engagement gets a generated `event_id` (spine_id + event_date) so each row has a
unique key, which event syncs need.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.catalog import quote_ident  # noqa: E402
from app.databricks import client  # noqa: E402

SHEETS = {"User Profile": "user_profile", "User Engagement": "user_engagement"}


def read(ws) -> tuple[list[str], list[list]]:
    rows = [list(r) for r in ws.iter_rows(values_only=True) if any(v is not None for v in r)]
    header = [h for h in rows[0] if h is not None]
    data = [(r + [None] * len(header))[: len(header)] for r in rows[1:]]
    return header, data


def infer(values: list) -> str:
    vals = [v for v in values if v is not None and v != ""]
    if not vals:
        return "STRING"
    if all(isinstance(v, bool) for v in vals):
        return "BOOLEAN"
    if all(isinstance(v, datetime) for v in vals):
        return "TIMESTAMP"
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
        return "BIGINT" if all(float(v).is_integer() for v in vals) else "DOUBLE"
    return "STRING"


def literal(v, sql_type: str) -> str:
    if v is None or v == "":
        return "NULL"
    if sql_type == "BOOLEAN":
        return "TRUE" if v else "FALSE"
    if sql_type == "TIMESTAMP":
        return f"TIMESTAMP'{v:%Y-%m-%d %H:%M:%S}'"
    if sql_type == "BIGINT":
        return str(int(v))
    if sql_type == "DOUBLE":
        return repr(float(v))
    text = str(v).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{text}'"


def load(path: str, target: str) -> None:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    dbx = client()
    for sheet, table in SHEETS.items():
        header, data = read(wb[sheet])
        if table == "user_engagement":
            i, j = header.index("spine_id"), header.index("event_date")
            header = ["event_id", *header]
            data = [[f"{r[i]}-{r[j]:%Y%m%d%H%M%S}", *r] for r in data]
        types = [infer([r[k] for r in data]) for k in range(len(header))]
        full = f"{target}.{quote_ident(table)}"
        cols = ", ".join(f"{quote_ident(h)} {t}" for h, t in zip(header, types))
        dbx.execute(f"CREATE OR REPLACE TABLE {full} ({cols}) COMMENT 'Loaded from {Path(path).name} / {sheet}'")
        for start in range(0, len(data), 200):
            values = ",\n".join("(" + ", ".join(literal(v, t) for v, t in zip(r, types)) + ")" for r in data[start:start + 200])
            dbx.execute(f"INSERT INTO {full} VALUES {values}")
        count = dbx.execute(f"SELECT COUNT(*) FROM {full}").rows[0][0]
        print(f"{full}: {count} rows; " + ", ".join(f"{h}:{t}" for h, t in zip(header, types)))


if __name__ == "__main__":
    load(sys.argv[1], sys.argv[2])
