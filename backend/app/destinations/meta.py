from __future__ import annotations

import hashlib
import json
import re

import httpx

from .base import ConfigField, Destination, TargetField, fail_all

# Meta identifier keys and how each value is normalized before SHA-256 hashing.
SCHEMA = {
    "email": ("EMAIL_SHA256", lambda v: v.strip().lower()),
    "phone": ("PHONE_SHA256", lambda v: re.sub(r"\D", "", v)),
    "first_name": ("FN_SHA256", lambda v: re.sub(r"[^a-z]", "", v.lower())),
    "last_name": ("LN_SHA256", lambda v: re.sub(r"[^a-z]", "", v.lower())),
    "country": ("COUNTRY_SHA256", lambda v: v.strip().lower()[:2]),
}


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class MetaCustomAudience(Destination):
    type = "meta_custom_audience"
    label = "Meta Custom Audience"
    description = "Add / remove people in a Facebook & Instagram Custom Audience. Identifiers are SHA-256 hashed before upload."
    category = "Advertising"
    beta = True
    config_fields = [
        ConfigField("access_token", "System user access token", type="password",
                    help="Needs ads_management permission on the ad account."),
        ConfigField("audience_id", "Custom Audience ID"),
        ConfigField("api_version", "Graph API version", required=False, default="v23.0"),
    ]
    target_fields = [
        TargetField("email", "Email", required=True),
        TargetField("phone", "Phone"),
        TargetField("first_name", "First name"),
        TargetField("last_name", "Last name"),
        TargetField("country", "Country code"),
    ]
    batch_size = 10000

    def __init__(self, config, context=None):
        super().__init__(config, context)
        version = config.get("api_version") or "v23.0"
        self.url = f"https://graph.facebook.com/{version}/{config.get('audience_id')}/users"
        self.http = httpx.Client(timeout=60)

    def test(self) -> str:
        version = self.config.get("api_version") or "v23.0"
        r = self.http.get(f"https://graph.facebook.com/{version}/{self.config.get('audience_id')}",
                          params={"fields": "name", "access_token": self.config.get("access_token")})
        r.raise_for_status()
        return f"Connected to audience '{r.json().get('name')}'"

    def _payload(self, rows):
        keys = [k for k in SCHEMA if any(r["fields"].get(k) for r in rows)]
        data = [[_hash(SCHEMA[k][1](str(r["fields"][k]))) if r["fields"].get(k) else "" for k in keys] for r in rows]
        return {"schema": [SCHEMA[k][0] for k in keys], "data": data}

    def _send(self, method: str, rows):
        if not rows:
            return {}
        params = {"access_token": self.config.get("access_token"), "payload": json.dumps(self._payload(rows))}
        r = self.http.request(method, self.url, data=params)
        return fail_all(rows, f"HTTP {r.status_code}: {r.text[:200]}") if r.status_code >= 300 else {}

    def upsert(self, rows):
        return self._send("POST", rows)

    def remove(self, rows):
        return self._send("DELETE", rows)

    def close(self):
        self.http.close()
