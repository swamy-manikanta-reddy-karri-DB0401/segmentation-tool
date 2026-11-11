"""Brevo (formerly Sendinblue).

Sync types mirror Hightouch's Brevo destination: Contacts (Upsert / Update / Insert) and
Contact lists (Upsert, people who leave are removed from the list by default).

API facts used here (developers.brevo.com):
* Base https://api.brevo.com/v3, auth header `api-key`. GET /account returns {email, companyName, plan}.
* POST /contacts {email, attributes, updateEnabled} creates a contact (201 {id}); with updateEnabled it
  also updates an existing one. Attribute names are capitalised and must already exist in the account.
* PUT /contacts/{identifier}?identifierType=email_id|contact_id|phone_id {attributes} updates (204, 404 if
  missing). DELETE /contacts/{identifier}?identifierType=... deletes (204, 404 if missing).
* POST /contacts/import {jsonBody: [{email, attributes}], listIds, updateExistingContacts} imports in the
  background (202 {processId}); listIds is required, 10 MB max body. Unknown attributes are ignored.
  GET /processes/{id} → status queued | in_process | processing | completed | failed | cancelled.
* POST /contacts/lists/{id}/contacts/remove {emails} → {contacts: {success, failure}}.
* GET /contacts/lists, GET /contacts/folders (limit/offset), POST /contacts/lists {name, folderId}.
* Rate limit for /v3/contacts/*: 10 requests/second and 36,000/hour on general plans; 429 when exceeded.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import httpx

from .base import ConfigField, Identifier, SyncType, TargetField, Destination, fail_all

API = "https://api.brevo.com/v3"
MAX_RETRIES = 5
LIST_CHUNK = 150  # contacts per list add/remove call
PROCESS_POLL_SECONDS = 5
PROCESS_TIMEOUT_SECONDS = 3600
MISSING_EMAIL = "Missing email"
ID_TYPES = {"email": "email_id", "sms": "phone_id", "contact_id": "contact_id"}

ATTRIBUTES = [TargetField("FIRSTNAME", "First name"), TargetField("LASTNAME", "Last name"),
              TargetField("SMS", "SMS (phone with country code)")]


class _Throttle:
    """Spaces requests to stay under Brevo's per-second limit across worker threads."""

    def __init__(self, per_second: float):
        self.gap = 1.0 / max(per_second, 0.1)
        self.next = 0.0
        self.lock = threading.Lock()

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            slot = max(now, self.next)
            self.next = slot + self.gap
        time.sleep(max(0.0, slot - now))


class Brevo(Destination):
    type = "brevo"
    label = "Brevo"
    description = "Sync contacts and contact lists to Brevo (formerly Sendinblue)."
    category = "Email & messaging"
    config_fields = [
        ConfigField("api_key", "API key", type="password",
                    help="In Brevo: Settings (bottom left) → SMTP & API → API Keys & MCP → Generate API key. "
                         "With Restricted access, allow read/write on contacts. Use an API key, not an SMTP key."),
        ConfigField("requests_per_second", "Requests per second", type="number", required=False, default=10,
                    help="Brevo allows 10/s on most plans (20/s Professional, 60/s Enterprise), shared with your other tools."),
    ]

    @classmethod
    def sync_types(cls) -> list[SyncType]:
        return [
            SyncType(
                name="contacts", label="Contacts", description="Create and update Brevo contacts.",
                modes=["upsert", "update", "insert"],
                identifiers=[Identifier("email", "Email"), Identifier("sms", "SMS (phone with country code)", modes=["update"]),
                             Identifier("contact_id", "Brevo contact ID", modes=["update"])],
                target_fields=ATTRIBUTES, custom_fields=True,
                delete_behaviors={
                    "do_nothing": "Keep the contact in Brevo with its synced attributes",
                    "clear": "Clear the mapped attributes, but keep the contact",
                    "delete": "Delete the contact from Brevo",
                },
            ),
            SyncType(
                name="lists", label="Contact lists",
                description="Keep a Brevo list in step with the audience. Contacts are created or updated as they join.",
                modes=["upsert"], identifiers=[Identifier("email", "Email")],
                target_fields=ATTRIBUTES, custom_fields=True,
                delete_behaviors={"remove": "Remove them from the list (the contact stays in Brevo)",
                                  "do_nothing": "Leave them in the list"},
                default_delete="remove",
                options=[
                    ConfigField("list_id", "Brevo list ID", required=False,
                                help="Contacts → Lists, the number in the ID column. Leave empty to use the list name below."),
                    ConfigField("list_name", "List name", required=False,
                                help="Used when no list ID is given: an existing list with this name, or a new one created on the first run."),
                    ConfigField("folder_id", "Folder ID for a new list", required=False,
                                help="Brevo puts every list in a folder. Leave empty to use your first folder."),
                ],
            ),
        ]

    def __init__(self, config, context=None):
        super().__init__(config, context)
        self.http = httpx.Client(base_url=API, timeout=60, headers={"api-key": config.get("api_key", ""), "accept": "application/json"})
        self.throttle = _Throttle(float(config.get("requests_per_second") or 10))
        self.workers = 4

    @property
    def key(self) -> str:
        return self.match_field or "email"

    def batch_size_for_run(self) -> int:
        return 5000 if self.sync_type == "lists" else 500

    # ---- transport ---------------------------------------------------------
    def _call(self, method: str, path: str, **kw) -> httpx.Response:
        for attempt in range(MAX_RETRIES + 1):
            self.throttle.wait()
            r = self.http.request(method, path, **kw)
            if r.status_code != 429 and r.status_code < 500 or attempt == MAX_RETRIES:
                self.record(method, f"{API}{path}", kw.get("json", kw.get("params", "")), r.status_code, r.text)
                return r
            time.sleep(min(2 ** attempt, 30))
        return r

    @staticmethod
    def _error(r: httpx.Response) -> str:
        try:
            body = r.json()
            return f"Brevo {body.get('code') or r.status_code}: {body.get('message') or r.text[:200]}"
        except ValueError:
            return f"HTTP {r.status_code}: {r.text[:200]}"

    def _parallel(self, fn, rows: list[dict]) -> dict[str, str]:
        with ThreadPoolExecutor(self.workers) as pool:
            return {pk: err for pk, err in pool.map(fn, rows) if err}

    def test(self) -> str:
        r = self._call("GET", "/account")
        if r.status_code == 200:
            body = r.json()
            return f"Connected to Brevo as {body.get('email')} ({body.get('companyName')})."
        if r.status_code == 401:
            raise RuntimeError("Brevo rejected the API key. Check it under SMTP & API → API keys.")
        raise RuntimeError(self._error(r))

    # ---- helpers -----------------------------------------------------------
    @staticmethod
    def _attributes(row: dict) -> dict:
        return {k.upper(): v for k, v in row["fields"].items() if v is not None}

    def _ident(self, row: dict) -> str:
        return quote(str(row["match"]).strip(), safe="")

    def _id_type(self) -> str:
        return ID_TYPES.get(self.key, "email_id")

    # ---- contacts ----------------------------------------------------------
    def _create(self, row: dict, update: bool) -> tuple[str, str | None]:
        if not row["match"]:
            return row["id"], MISSING_EMAIL
        body = {"email": str(row["match"]).strip(), "attributes": self._attributes(row)}
        if update:
            body["updateEnabled"] = True
        r = self._call("POST", "/contacts", json=body)
        if r.status_code in (200, 201, 204):
            return row["id"], None
        err = self._error(r)
        if not update and "duplicate" in err.lower():
            return row["id"], f"Contact already exists — insert mode only creates new contacts ({err})"
        return row["id"], err

    def _update(self, row: dict, attributes: dict | None = None) -> tuple[str, str | None]:
        if not row["match"]:
            return row["id"], f"Missing {self.key}"
        r = self._call("PUT", f"/contacts/{self._ident(row)}", params={"identifierType": self._id_type()},
                       json={"attributes": self._attributes(row) if attributes is None else attributes})
        if r.status_code in (200, 204):
            return row["id"], None
        if r.status_code == 404:
            return row["id"], "Contact not found — update mode only updates existing contacts"
        return row["id"], self._error(r)

    def _delete(self, row: dict) -> tuple[str, str | None]:
        if not row["match"]:
            return row["id"], f"Missing {self.key}"
        r = self._call("DELETE", f"/contacts/{self._ident(row)}", params={"identifierType": self._id_type()})
        return row["id"], None if r.status_code in (200, 204, 404) else self._error(r)  # 404: already gone

    # ---- lists -------------------------------------------------------------
    def _pages(self, path: str, key: str):
        offset = 0
        while True:
            r = self._call("GET", path, params={"limit": 50, "offset": offset})
            if r.status_code != 200:
                raise RuntimeError(self._error(r))
            items = r.json().get(key) or []
            yield from items
            if len(items) < 50:
                return
            offset += 50

    def prepare(self) -> dict:
        """Lists: resolve the list name to an ID (creating the list if needed) and save it on the sync."""
        if self.sync_type != "lists" or str(self.options.get("list_id") or "").strip():
            return {}
        name = str(self.options.get("list_name") or "").strip()
        if not name:
            raise ValueError("Enter a Brevo list ID or a list name")
        found = next((l for l in self._pages("/contacts/lists", "lists") if l.get("name", "").strip().lower() == name.lower()), None)
        if found:
            list_id = found["id"]
        else:
            folder = str(self.options.get("folder_id") or "").strip()
            if not folder:
                first = next(self._pages("/contacts/folders", "folders"), None)
                if not first:
                    raise ValueError("Your Brevo account has no contact folder. Create one under Contacts → Lists, or enter a folder ID")
                folder = first["id"]
            r = self._call("POST", "/contacts/lists", json={"name": name, "folderId": int(folder)})
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Couldn't create the Brevo list “{name}”: {self._error(r)}")
            list_id = r.json()["id"]
        self.options["list_id"] = list_id
        return {"list_id": list_id}

    @property
    def list_id(self) -> int:
        raw = str(self.options.get("list_id") or "").strip()
        if not raw.isdigit():
            raise ValueError("The Brevo list ID must be a number (Contacts → Lists, ID column)")
        return int(raw)

    def _import(self, rows: list[dict]) -> dict[str, str]:
        valid = [r for r in rows if r["match"]]
        failures = {r["id"]: MISSING_EMAIL for r in rows if not r["match"]}
        if not valid:
            return failures
        body = {"jsonBody": [{"email": str(r["match"]).strip(), "attributes": self._attributes(r)} for r in valid],
                "listIds": [self.list_id], "updateExistingContacts": True, "emptyContactsAttributes": False}
        r = self._call("POST", "/contacts/import", json=body)
        if r.status_code not in (200, 201, 202):
            failures.update(fail_all(valid, self._error(r)))
            return failures
        err = self._wait(r.json().get("processId"))
        if err:
            failures.update(fail_all(valid, err))
        return failures

    def _wait(self, process_id) -> str | None:
        if not process_id:
            return None
        deadline = time.time() + PROCESS_TIMEOUT_SECONDS
        while time.time() < deadline:
            time.sleep(PROCESS_POLL_SECONDS)
            s = self._call("GET", f"/processes/{process_id}")
            if s.status_code != 200:
                return self._error(s)
            status = s.json().get("status")
            if status == "completed":
                return None
            if status in ("failed", "cancelled"):
                return f"Brevo import {process_id} finished with status '{status}'"
        return f"Brevo import {process_id} didn't finish within an hour"

    def _unlink(self, rows: list[dict]) -> dict[str, str]:
        failures = {r["id"]: MISSING_EMAIL for r in rows if not r["match"]}
        valid = [r for r in rows if r["match"]]
        for i in range(0, len(valid), LIST_CHUNK):
            chunk = valid[i:i + LIST_CHUNK]
            emails = sorted({str(r["match"]).strip().lower() for r in chunk})
            r = self._call("POST", f"/contacts/lists/{self.list_id}/contacts/remove", json={"emails": emails})
            # Emails Brevo reports under "failure" weren't in the list, so there is nothing left to remove.
            if r.status_code not in (200, 201):
                failures.update(fail_all(chunk, self._error(r)))
        return failures

    # ---- interface ---------------------------------------------------------
    def upsert(self, rows):
        if self.sync_type == "lists":
            return self._import(rows)
        if self.mode == "update":
            return self._parallel(self._update, rows)
        return self._parallel(lambda r: self._create(r, update=self.mode == "upsert"), rows)

    def remove(self, rows):
        if self.sync_type == "lists":
            return self._unlink(rows)
        return self._parallel(self._delete, rows)

    def clear(self, rows):
        return self._parallel(lambda r: self._update(r, {k.upper(): "" for k in r["fields"]}), rows)

    def close(self):
        self.http.close()
