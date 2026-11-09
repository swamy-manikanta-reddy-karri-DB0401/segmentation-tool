# Segmentation Tool (prototype)

Hightouch-style audiences: **Databricks → segment rules → Sailthru list**.

## Run
Backend (FastAPI, port 8100):
    cd backend
    python -m venv .venv && .venv\Scripts\pip install -r requirements.txt
    .venv\Scripts\python -m uvicorn app.main:app --port 8100 --reload
Frontend (Next.js, port 3100):
    cd frontend && npm install && npm run dev

`backend/.env` (git-ignored) holds `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`, `CDP_STATE_SCHEMA`.
A "Databricks (from .env)" source is auto-created and reads those vars at runtime (token is never stored in SQLite).
A seeded SQLite "Demo warehouse" source is also created so you can try everything without Databricks.

## Flow
1. Connections: add Sailthru (api_key/secret; keep **dry-run** on until ready).
2. Segments: pick source + table + email column, build conditions, Preview (count, SQL, rows), Save.
3. Syncs: segment → Sailthru list, map columns to Sailthru vars, mode `mirror` (add + remove) or `upsert`. Run, view history.

## Rules (operators)
equals, does not equal, contains, does not contain, starts with, does not start with, ends with, does not end with,
exists, exists and is not empty, does not exist, plus number (>, >=, <, <=), boolean (is true/false) and
date (before, after, within / not within last N days). Multiple values on a text operator are OR'd
(AND'd for negatives). Nested AND/OR groups. Compiled to parameterised SQL in `backend/app/rules.py`.

## Not yet done
Auth, scheduling, Sailthru Job API for bulk, event/related-table conditions, `CDP_STATE_SCHEMA` snapshots in Databricks
(diffs currently stored in SQLite `sync_members`), secret encryption for non-env connections.
