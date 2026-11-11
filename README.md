# MediaMint CDP

A warehouse-native customer data platform on Databricks: business users build audiences
visually and activate them to destinations. Customer data stays in Databricks — the app
stores only configuration, segment definitions and run logs.

## Run it

```powershell
./start.ps1            # builds the UI once, then serves UI + API at http://localhost:8100
```

Demo data lives in Databricks at `mediamint_cdp.audience_data` (`user_profile`, `user_engagement`).
Reload it from the spreadsheet with
`cd backend; python scripts/load_excel.py <path/to/Schema.xlsx> mediamint_cdp.audience_data`.

The app is organised as a pipeline: **Sources** (Databricks connection and datasets) → **1 Schema**
(parent / related / event models) → **2 Modeling** (traits, customer profiles) → **3 Segmentation**
(audiences, priority lists) → **4 Activation** (destinations, syncs, destination rules).
Syncs wait (and are not scheduled) until their destination has credentials.

Development (hot reload): `cd backend; python -m uvicorn app.main:app --port 8100 --reload`
and in another terminal `cd frontend; npm run dev` → http://localhost:5173 (proxies `/api`).

Configuration lives in `.env` (see `.env.example`): workspace host, token, SQL warehouse ID,
and `CDP_STATE_SCHEMA` — a schema the token can write to, used for sync snapshots.

## Sign-in and access

* **Deployed as a Databricks App:** people are identified by Databricks (the Apps proxy). Nothing below applies.
* **Locally (and any non-Databricks run):** people sign in with **email and password**. The first start creates an
  admin, `admin@local.dev` / `admin12345` unless `CDP_ADMIN_EMAIL` / `CDP_ADMIN_PASSWORD` are set. Change it under
  **My access**. Sessions last 12 hours (`CDP_SESSION_HOURS`). Passwords are stored as salted scrypt hashes.
  `CDP_LOCAL_AUTH=0` switches sign-in off (open dev mode with the "Preview as" persona picker).
* **Admins** have full access to every brand and manage everything under **Access**: add users (email, name,
  password, admin or not), switch accounts off, reset passwords, create **custom roles** (any mix of the brand
  permissions) and grant roles per brand.
* **A person can hold several roles**, on one brand or many; what they can do is everything their roles allow,
  combined. Everyone sees their own roles and every permission they have under **My access**.
* **Granting access from the Databricks directory:** when granting a role, the "who" field is a searchable
  dropdown of the workspace's users (name or email) and groups, read through the app's Databricks connection.
  If the directory can't be read the dialog says why and you can still type an email or group name.
* **Brand switcher** (sidebar, under the Databricks status): people with roles on several brands pick the brand
  they're working in. The whole app then shows only that brand's data and only the permissions their role on
  that brand allows (a role on another brand doesn't carry over). Admins and brand-wide roles also get "All
  brands". The choice is sent as the `X-Active-Brand` header and checked server-side, so it can't be used to
  reach a brand the person has no role on. **My access** shows what every role allows on every brand.
* Custom roles carry brand permissions only. Sources, the data model, users, roles and brands stay with admins.

## How it works

| Part | Where | What it does |
|---|---|---|
| Schema setup | `backend/app/catalog.py`, *Data setup* page | Customer table + related tables + event tables, picked from Unity Catalog. Struct columns are flattened (`metadata.device`). |
| Segment compiler | `backend/app/compiler.py` | JSON condition tree → parameterized Databricks SQL. All values are query parameters; identifiers are validated against introspected columns. |
| Audience insights | `backend/app/audiences.py` | Live size, breakdown and preview straight from the SQL warehouse. |
| Sync engine | `backend/app/sync_engine.py` | Materializes the audience, diffs it against the last snapshot **inside Databricks**, pushes only adds / changes / removals, and keeps failed rows queued for retry. |
| Destinations | `backend/app/destinations/` | Each destination declares sync types (modes, record-matching identifiers, options, delete behaviors). Sailthru: Users (Upsert/Update, Bulk or Real-time, Do nothing/Clear/Delete), Custom events, Purchases, Returns. Also Webhook, CSV export, HubSpot (beta), Meta Custom Audience (beta). Add one by subclassing `Destination` and registering it in `__init__.py`. |
| Scheduler | `backend/app/scheduler.py` | Manual, interval, custom recurrence and cron schedules (UTC); interrupted runs are marked failed on restart. |

### Filters (aligned with Hightouch's audience-filter reference)

- **Properties**: string `equals` (several values) / `does not equal` / `contains` / `starts with` / `ends with` and their negations, `exists`, `exists and is not empty`, `does not exist`; numbers incl. `between`; booleans; timestamps `equals`, `before`, `after`, `within` / `not within` (previous or next N units, rolling or calendar), `between`, `anniversary`. Paste or drop a CSV list of values.
- **Relations**: count / sum / average / min / max / distinct count of related records, with nested AND/OR filters and a time window.
- **Events**: did / did not perform, frequency (at least / at most / exactly), time window, property filters, and **Then did perform / Then did not perform** within a time window.
- **Audiences**: are / are not included in another audience. Groups nest with AND / OR.
- **Null values**: workspace setting for whether nulls match negative operators.
- **Calculate size** shows the total and the count after each top-level filter.

### Schema, traits and governance

- **Schema**: multiple parent models; table or SQL-query models; relationships 1:many / 1:1 / many:1 with
  one or more join keys; merged columns (from 1:1 / many:1 models); primary & secondary labels; per-column
  display name, visibility, privacy level (unreviewed / approved / redacted / sync-only / sync-blocked /
  blocked), value suggestions and case sensitivity.
- **Traits** (`Traits` page or inline in an audience): Aggregation, Count, Occurrence (first / last / most /
  least frequent), List, SQL Aggregation, SQL Formula — usable in filters, breakdowns and sync mappings.
- **Insights**: per-filter counts, breakdowns by property / trait / related or event rows (total rows vs
  unique customers), audience overlap, destination preview after rules.
- **Governance**: destination rules (filters applied at sync time), priority lists (each person syncs only
  to their highest-priority audience), A/B splits, audience snapshots (enter / exit history in
  `<CDP_STATE_SCHEMA>.audience_membership`).
- **Syncs**: advanced field mapper (column, static value, variable, Liquid template with `sha256`, `md5`,
  `cast`, `regex_replace`, `to_unix`, `validate_email`, …; per-field null handling), sync templates,
  Slack-compatible alert webhooks, run debugger (sample of requests / responses per run).

The *Analysis date* setting moves "now" for relative time windows, which helps with historical
or sample datasets. Leave it empty for live data.

## Tests

```powershell
cd backend; python -m pytest -q
```

## Not yet production-ready

- No login or roles yet. Run it locally or behind your SSO proxy.
- Destination secrets are stored in local SQLite. Move them to a vault or Databricks secrets.
- HubSpot and Meta connectors are written against their public APIs but haven't been tested with live accounts.
- Use a service principal token instead of a personal access token.
