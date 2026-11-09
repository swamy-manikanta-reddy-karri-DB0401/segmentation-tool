from __future__ import annotations

import httpx

from .base import ConfigField, Destination, TargetField, fail_all

API = "https://api.hubapi.com"


class HubSpot(Destination):
    type = "hubspot"
    label = "HubSpot"
    description = "Upsert contacts (matched on email) and optionally keep a static list in sync."
    category = "CRM"
    beta = True
    config_fields = [
        ConfigField("token", "Private app access token", type="password",
                    help="Needs crm.objects.contacts.write and crm.lists.write scopes."),
        ConfigField("list_id", "Static list ID", required=False,
                    help="Optional. Members are added/removed as the audience changes."),
    ]
    target_fields = [
        TargetField("email", "Email", required=True),
        TargetField("firstname", "First name"),
        TargetField("lastname", "Last name"),
        TargetField("phone", "Phone"),
        TargetField("company", "Company"),
        TargetField("country", "Country"),
        TargetField("city", "City"),
    ]

    def __init__(self, config, context=None):
        super().__init__(config, context)
        self.http = httpx.Client(base_url=API, timeout=30, headers={"Authorization": f"Bearer {config.get('token', '')}"})

    def test(self) -> str:
        r = self.http.get("/crm/v3/objects/contacts", params={"limit": 1})
        r.raise_for_status()
        return "Connected to HubSpot"

    def _list(self, action: str, ids: list[str]) -> str | None:
        list_id = self.config.get("list_id")
        if not list_id or not ids:
            return None
        r = self.http.put(f"/crm/v3/lists/{list_id}/memberships/{action}", json=ids)
        return None if r.status_code < 300 else f"List update failed: HTTP {r.status_code} {r.text[:200]}"

    def upsert(self, rows):
        failures, valid = {}, []
        for row in rows:
            if not row["fields"].get("email"):
                failures[row["id"]] = "Missing email"
            else:
                valid.append(row)
        if not valid:
            return failures
        inputs = [{"idProperty": "email", "id": r["fields"]["email"],
                   "properties": {k: v for k, v in r["fields"].items() if v is not None}} for r in valid]
        r = self.http.post("/crm/v3/objects/contacts/batch/upsert", json={"inputs": inputs})
        if r.status_code >= 300:
            failures.update(fail_all(valid, f"HTTP {r.status_code}: {r.text[:200]}"))
            return failures
        ids = [res["id"] for res in r.json().get("results", [])]
        err = self._list("add", ids)
        if err:
            failures.update(fail_all(valid, err))
        return failures

    def remove(self, rows):
        if not self.config.get("list_id"):
            return {}  # nothing to remove from; contacts are never deleted
        emails = [r["fields"].get("email") for r in rows if r["fields"].get("email")]
        r = self.http.post("/crm/v3/objects/contacts/batch/read",
                           json={"idProperty": "email", "inputs": [{"id": e} for e in emails]})
        if r.status_code >= 300:
            return fail_all(rows, f"HTTP {r.status_code}: {r.text[:200]}")
        err = self._list("remove", [res["id"] for res in r.json().get("results", [])])
        return fail_all(rows, err) if err else {}

    def close(self):
        self.http.close()
