from __future__ import annotations

import httpx

from .base import ConfigField, Destination, fail_all


def parse_headers(raw: str | None) -> dict:
    headers = {}
    for line in (raw or "").splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip()] = v.strip()
    return headers


class Webhook(Destination):
    type = "webhook"
    label = "Webhook (HTTP)"
    description = "POST audience changes as JSON batches to any HTTPS endpoint."
    category = "Developer"
    config_fields = [
        ConfigField("url", "Endpoint URL", help="Tip: use the built-in Test Inbox to try it out."),
        ConfigField("headers", "Extra headers", type="textarea", required=False,
                    help="One per line, e.g. Authorization: Bearer abc123"),
        ConfigField("batch_size", "Rows per request", type="number", required=False, default=100),
    ]

    def __init__(self, config, context=None):
        super().__init__(config, context)
        self.batch_size = int(config.get("batch_size") or 100)
        self.http = httpx.Client(timeout=30, headers=parse_headers(config.get("headers")))

    def _post(self, action: str, rows: list[dict]) -> dict[str, str]:
        body = {
            "action": action,
            "sync_id": self.context.get("sync_id"),
            "audience": self.context.get("audience_name"),
            "rows": [{"id": r["id"], "fields": r["fields"]} for r in rows],
        }
        try:
            r = self.http.post(self.config["url"], json=body)
            self.record("POST", self.config["url"], body, r.status_code, r.text)
            if r.status_code >= 300:
                return fail_all(rows, f"HTTP {r.status_code}: {r.text[:200]}")
        except httpx.HTTPError as e:
            return fail_all(rows, str(e))
        return {}

    def test(self) -> str:
        r = self.http.post(self.config["url"], json={"action": "test", "rows": []})
        r.raise_for_status()
        return f"Endpoint answered HTTP {r.status_code}"

    def upsert(self, rows):
        return self._post("upsert", rows)

    def remove(self, rows):
        return self._post("remove", rows)

    def close(self):
        self.http.close()
