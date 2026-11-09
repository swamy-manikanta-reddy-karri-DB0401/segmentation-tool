"""Sailthru (Marigold Engage by Sailthru).

Sync types mirror Hightouch's Sailthru destination: Users (Upsert / Update),
Custom events, Purchases and Returns (Insert).

API facts used here (Sailthru docs, products.zetaglobal.com/sailthru):
* Requests are form-encoded {api_key, format, json, sig}; sig = md5(secret + sorted
  parameter VALUES) — same algorithm as Sailthru's official Python client.
* POST /user creates or updates a user; `lists` {name: 1|0} adds/removes; a missing
  list is created automatically. GET /user looks a user up; DELETE /user deletes it.
* POST /job {"job": "update"} with a multipart `file` of one JSON object per line
  bulk-updates users. An `update` object applies to every user in the file — used
  with `delete_vars` to clear fields. Jobs are async; GET /job {job_id} reports
  pending / running / completed / error / incomplete.
* POST /event {id, key, event, vars}; POST /purchase {email | user_id+user_key, items, date, vars};
  POST /return {email, items}. Item prices are in cents.
* Rate limits: POST /user 300 req/s, other POSTs 40 req/s, DELETE 40 req/s; 429 + X-Rate-Limit-Reset.
"""
from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import httpx

from .base import ConfigField, Destination, Identifier, SyncType, TargetField, fail_all

API = "https://api.sailthru.com"
MAX_RETRIES = 5
JOB_POLL_SECONDS = 10
JOB_TIMEOUT_SECONDS = 4 * 3600


def _values(obj) -> list[str]:
    if isinstance(obj, dict):
        return [v for x in obj.values() for v in _values(x)]
    if isinstance(obj, list):
        return [v for x in obj for v in _values(x)]
    return [str(obj)]


def sign(secret: str, params: dict) -> str:
    return hashlib.md5((secret + "".join(sorted(_values(params)))).encode("utf-8")).hexdigest()


def _item_fields(prefix_required: list[tuple[str, str]], optional: list[tuple[str, str]]) -> list[TargetField]:
    return ([TargetField(f"item_{n}", f"Item {l}", required=True) for n, l in prefix_required]
            + [TargetField(f"item_{n}", f"Item {l}") for n, l in optional])


GROUP_OPTION = ConfigField(
    "group_by", "Combine rows into one order by", type="column", required=False,
    help="Optional. Rows sharing this value are sent as one order with several items. Leave empty to send one item per row.")
PRICE_OPTION = ConfigField(
    "price_unit", "Item prices in your data are in", type="select", default="cents",
    options=[{"value": "cents", "label": "Cents (as Sailthru expects)"}, {"value": "dollars", "label": "Dollars — multiply by 100"}])


class Sailthru(Destination):
    type = "sailthru"
    label = "Sailthru"
    description = "Sync users, custom events, purchases and returns to Sailthru (Marigold Engage)."
    category = "Email & messaging"
    config_fields = [
        ConfigField("api_key", "API Key", help="Find it in Sailthru under Settings → API & Postbacks."),
        ConfigField("secret", "API Secret", type="password"),
    ]

    @classmethod
    def sync_types(cls) -> list[SyncType]:
        return [
            SyncType(
                name="users", label="Users", description="Sync data from any source to Sailthru users.",
                modes=["upsert", "update"],
                identifiers=[Identifier("email", "Email"), Identifier("sid", "Sailthru ID", modes=["update"])],
                custom_fields=True,
                delete_behaviors={
                    "do_nothing": "Keep the user in Sailthru with all its synced fields",
                    "clear": "Clear all the mapped fields, but keep the user in Sailthru",
                    "delete": "Delete the synced users from Sailthru",
                },
                options=[
                    ConfigField("list_name", "List name", required=False,
                                help="Users are added to this list. If it doesn't exist yet, Sailthru creates it."),
                    ConfigField("send_method", "How should users be sent to Sailthru?", type="select", default="bulk",
                                modes=["upsert"], options=[
                                    {"value": "bulk", "label": "Bulk — upload in bulk jobs (best for large audiences)"},
                                    {"value": "realtime", "label": "Real-time — one User API call per user (starts Lifecycle Optimizer “List Joined” flows)"},
                                ]),
                    ConfigField("rows_per_batch", "Rows per batch", type="number", required=False, default=100000,
                                modes=["upsert"], help="Bulk only. Lower it if wide user records fail."),
                    ConfigField("concurrency", "Parallel requests", type="number", required=False, default=8,
                                help="Real-time, Update and Delete only. The User API allows ~300 requests/second per account, shared with your other integrations."),
                ],
            ),
            SyncType(
                name="custom_events", label="Custom events", description="Sync data from any source to Sailthru custom events.",
                modes=["insert"], source="events",
                identifiers=[Identifier("email", "Email"), Identifier("sid", "Sailthru ID")],
                target_fields=[TargetField("event", "Event name")], custom_fields=True,
                options=[ConfigField("event_name", "Event name", required=False,
                                     help="Used when no column is mapped to “Event name”. Reserved names (send, cancel, open, click, purchase, daily) are rejected by Sailthru.")],
            ),
            SyncType(
                name="purchases", label="Purchases", description="Sync data from any source to Sailthru purchase events.",
                modes=["insert"], source="events",
                identifiers=[Identifier("email", "Email")],
                target_fields=[TargetField("date", "Purchase date")] + _item_fields(
                    [("qty", "quantity"), ("title", "title"), ("price", "price"), ("id", "ID / SKU"), ("url", "URL")], []),
                custom_fields=True, options=[GROUP_OPTION, PRICE_OPTION],
            ),
            SyncType(
                name="returns", label="Returns", description="Sync data from any source to Sailthru return events.",
                modes=["insert"], source="events",
                identifiers=[Identifier("email", "Email")],
                target_fields=_item_fields([("qty", "quantity"), ("price", "price"), ("url", "URL")],
                                           [("id", "ID / SKU"), ("order_id", "original order ID")]),
                options=[GROUP_OPTION, PRICE_OPTION],
            ),
        ]

    def __init__(self, config, context=None):
        super().__init__(config, context)
        self.http = httpx.Client(base_url=API, timeout=60)
        self.workers = max(1, min(int(self.options.get("concurrency") or 8), 32))

    @property
    def key(self) -> str:
        return self.match_field or "email"

    @property
    def bulk(self) -> bool:
        return self.sync_type == "users" and self.mode == "upsert" and self.options.get("send_method", "bulk") == "bulk"

    def batch_size_for_run(self) -> int:
        if self.bulk:
            return max(1, int(self.options.get("rows_per_batch") or 100000))
        return 500

    # ---- transport ---------------------------------------------------------
    def _params(self, payload: dict) -> dict:
        params = {"api_key": self.config.get("api_key", ""), "format": "json",
                  "json": json.dumps(payload, separators=(",", ":"), default=str)}
        params["sig"] = sign(self.config.get("secret", ""), params)
        return params

    def _call(self, method: str, endpoint: str, payload: dict, files: dict | None = None) -> httpx.Response:
        for attempt in range(MAX_RETRIES + 1):
            params = self._params(payload)
            if method == "POST":
                r = self.http.post(f"/{endpoint}", data=params, files=files)
            else:
                r = self.http.request(method, f"/{endpoint}", params=params)
            if r.status_code != 429 and r.status_code < 500 or attempt == MAX_RETRIES:
                self.record(method, f"{API}/{endpoint}", payload if not files else {**payload, "file": "<bulk upload>"},
                            r.status_code, r.text)
                return r
            reset = r.headers.get("X-Rate-Limit-Reset")
            wait = max(1.0, float(reset) - time.time()) if r.status_code == 429 and reset else 2 ** attempt
            time.sleep(min(wait, 60))
        return r

    @staticmethod
    def _error(r: httpx.Response) -> str:
        try:
            body = r.json()
            return f"Sailthru error {body.get('error')}: {body.get('errormsg')}"
        except ValueError:
            return f"HTTP {r.status_code}: {r.text[:200]}"

    def _parallel(self, fn, rows: list[dict]) -> dict[str, str]:
        with ThreadPoolExecutor(self.workers) as pool:
            results = pool.map(fn, rows)
        return {pk: err for pk, err in results if err}

    def test(self) -> str:
        r = self._call("GET", "list", {})
        if r.status_code == 200:
            return "Connected to Sailthru."
        raise RuntimeError(self._error(r))

    # ---- users -------------------------------------------------------------
    def _user_payload(self, row: dict, in_list: int | None = 1) -> dict:
        payload = {"id": row["match"], "key": self.key}
        vars_ = {k: v for k, v in row["fields"].items()}
        if vars_:
            payload["vars"] = vars_
        if self.options.get("list_name") and in_list is not None:
            payload["lists"] = {self.options["list_name"]: in_list}
        return payload

    def _post_user(self, row: dict) -> tuple[str, str | None]:
        if not row["match"]:
            return row["id"], f"Missing {self.key}"
        if self.mode == "update":
            look = self._call("GET", "user", {"id": row["match"], "key": self.key, "fields": {"keys": 1}})
            if look.status_code != 200:
                err = self._error(look)
                return row["id"], (f"User not found — update mode only updates existing users ({err})"
                                   if "not found" in err.lower() else err)
        r = self._call("POST", "user", self._user_payload(row))
        return row["id"], None if r.status_code == 200 else self._error(r)

    def _run_job(self, lines: list[dict], update: dict | None = None) -> str | None:
        """Submit a bulk update job and wait for it. Returns an error message or None."""
        body = "\n".join(json.dumps(line, separators=(",", ":"), default=str) for line in lines).encode("utf-8")
        payload = {"job": "update"}
        if update:
            payload["update"] = update
        r = self._call("POST", "job", payload, files={"file": ("users.json", body, "text/plain")})
        if r.status_code != 200:
            return self._error(r)
        job_id = r.json().get("job_id")
        deadline = time.time() + JOB_TIMEOUT_SECONDS
        while time.time() < deadline:
            time.sleep(JOB_POLL_SECONDS)
            s = self._call("GET", "job", {"job_id": job_id})
            if s.status_code != 200:
                return self._error(s)
            status = s.json().get("status")
            if status == "completed":
                return None
            if status in ("error", "incomplete"):
                return f"Sailthru bulk job {job_id} finished with status '{status}'"
        return f"Sailthru bulk job {job_id} did not finish within {JOB_TIMEOUT_SECONDS // 3600} hours"

    def _users_upsert(self, rows):
        valid = [r for r in rows if r["match"]]
        failures = {r["id"]: f"Missing {self.key}" for r in rows if not r["match"]}
        if not self.bulk:
            failures.update(self._parallel(self._post_user, valid))
            return failures
        lines = []
        for r in valid:
            line = {"id": r["match"]}
            if r["fields"]:
                line["vars"] = r["fields"]
            if self.options.get("list_name"):
                line["lists"] = {self.options["list_name"]: 1}
            lines.append(line)
        err = self._run_job(lines) if lines else None
        if err:
            failures.update(fail_all(valid, err))
        return failures

    def _delete_user(self, row):
        if not row["match"]:
            return row["id"], f"Missing {self.key}"
        r = self._call("DELETE", "user", {"id": row["match"], "key": self.key})
        return row["id"], None if r.status_code == 200 else self._error(r)

    # ---- events / purchases / returns ----------------------------------------
    def _event(self, row):
        name = row["fields"].get("event") or self.options.get("event_name")
        if not row["match"]:
            return row["id"], f"Missing {self.key}"
        if not name:
            return row["id"], "Missing event name"
        payload = {"id": row["match"], "key": self.key, "event": name}
        vars_ = {k: v for k, v in row["fields"].items() if k != "event"}
        if vars_:
            payload["vars"] = vars_
        r = self._call("POST", "event", payload)
        return row["id"], None if r.status_code == 200 else self._error(r)

    def _price(self, value):
        if value is None:
            return None
        v = float(value)
        return int(round(v * 100)) if self.options.get("price_unit") == "dollars" else int(round(v))

    def _orders(self, rows: list[dict]) -> "OrderedDict[str, list[dict]]":
        group_by = self.options.get("group_by")
        orders: OrderedDict[str, list[dict]] = OrderedDict()
        for r in rows:
            key = str(r.get("group") if group_by else r["id"])
            orders.setdefault(key, []).append(r)
        return orders

    def _item(self, row: dict, names: list[str]) -> dict:
        item = {}
        for n in names:
            v = row["fields"].get(f"item_{n}")
            if v is not None:
                item[n] = self._price(v) if n == "price" else (int(v) if n == "qty" else v)
        return item

    def _send_order(self, endpoint: str, lines: list[dict]) -> dict[str, str]:
        first = lines[0]
        if not first["match"]:
            return fail_all(lines, "Missing email")
        try:
            if endpoint == "purchase":
                items = [self._item(r, ["qty", "title", "price", "id", "url"]) for r in lines]
                payload = {"email": first["match"], "items": items}
                if first["fields"].get("date"):
                    payload["date"] = first["fields"]["date"]
                extra = {k: v for k, v in first["fields"].items() if k != "date" and not k.startswith("item_")}
                if extra:
                    payload["vars"] = extra
            else:
                payload = {"email": first["match"],
                           "items": [self._item(r, ["qty", "price", "url", "id", "order_id"]) for r in lines]}
        except (TypeError, ValueError) as e:
            return fail_all(lines, f"Invalid item value: {e}")
        r = self._call("POST", endpoint, payload)
        return {} if r.status_code == 200 else fail_all(lines, self._error(r))

    # ---- interface ---------------------------------------------------------
    def upsert(self, rows):
        if self.sync_type == "users":
            return self._users_upsert(rows) if self.mode == "upsert" else self._parallel(self._post_user, rows)
        if self.sync_type == "custom_events":
            return self._parallel(self._event, rows)
        endpoint = "purchase" if self.sync_type == "purchases" else "return"
        failures: dict[str, str] = {}
        orders = list(self._orders(rows).values())
        with ThreadPoolExecutor(min(self.workers, 4)) as pool:  # non-user POSTs are limited to 40 req/s
            for result in pool.map(lambda lines: self._send_order(endpoint, lines), orders):
                failures.update(result)
        return failures

    def remove(self, rows):  # delete behavior "delete"
        return self._parallel(self._delete_user, rows)

    def clear(self, rows):
        if self.key != "email":
            return fail_all(rows, "Clear needs Email matching (Sailthru bulk jobs identify users by email)")
        fields = sorted({k for r in rows for k in r["fields"]})
        valid = [r for r in rows if r["match"]]
        failures = {r["id"]: "Missing email" for r in rows if not r["match"]}
        if fields and valid:
            err = self._run_job([{"id": r["match"]} for r in valid], {"delete_vars": fields})
            if err:
                failures.update(fail_all(valid, err))
        return failures

    def close(self):
        self.http.close()
