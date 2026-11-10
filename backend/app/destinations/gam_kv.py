"""Google Ad Manager key-value targeting.

Works on any Ad Manager network (no Audience Solutions / Ad Manager 360 needed). Each synced audience
becomes one value of a custom targeting key (default `mm_aud`). Membership is kept in the app's store
(see targeting.py); the website looks visitors up via GET /api/targeting and passes the values to
Ad Manager with the ad request, e.g. googletag.pubads().setTargeting('mm_aud', ['engaged_non_subs']).
Line items then target mm_aud = engaged_non_subs.

With a service account (optional), the app creates the key and the value in Ad Manager on the first
run, so ad ops can pick them from a list instead of typing them.
"""
from __future__ import annotations

from .. import targeting
from .base import ConfigField, SyncType, TargetField
from .gam import ADMANAGER, ADMANAGER_SCOPE, GoogleAdManager


class GamKeyValues(GoogleAdManager):
    type = "gam_kv"
    label = "Google Ad Manager — key-value targeting"
    description = ("Target ads on your site by audience with Google Ad Manager key-values (e.g. mm_aud=engaged_non_subs). "
                   "Works on every Ad Manager network — your site looks visitors up and passes the values with the ad request.")
    category = "Advertising"
    config_fields = [
        ConfigField("key", "Targeting key", default="mm_aud",
                    help="The Ad Manager key that carries audience names. Up to 10 characters: letters, numbers, _ or -."),
        ConfigField("network_code", "Ad Manager network code", required=False,
                    help="Admin → Global settings. Needed only if the app should create the key and values in Ad Manager for you."),
        ConfigField("service_account_json", "Service account key (JSON)", type="textarea", secret=True, required=False,
                    help="Optional. A Google Cloud service account added as an Ad Manager API user — lets the app create the key and values."),
    ]
    batch_size = 5000

    @classmethod
    def sync_types(cls) -> list[SyncType]:
        return [SyncType(
            name="membership", label="Audience membership",
            description="Keeps the list of visitors in this audience up to date so your site can pass it to Ad Manager.",
            modes=["add"],
            target_fields=[TargetField("user_id", "Visitor ID your website knows (login ID or PPID)", required=True)],
            delete_behaviors={"remove": "Remove them — they stop getting this audience's ads",
                              "do_nothing": "Keep them in the audience"},
            default_delete="remove",
            options=[ConfigField("value", "Targeting value", required=False,
                                 help="The value for this audience, e.g. engaged_non_subs. Leave empty to use the audience name. "
                                      "Up to 40 characters: lowercase letters, numbers, _ or -.")],
        )]

    # ---- names -------------------------------------------------------------------------------
    @property
    def key(self) -> str:
        return targeting.validate_key(self.config.get("key") or "mm_aud")

    @property
    def value(self) -> str:
        v = (self.options.get("value") or "").strip()
        return targeting.validate_value(v) if v else targeting.slug(self.context.get("audience_name") or "audience")

    def _ids(self, rows: list[dict]) -> tuple[list[str], dict[str, str]]:
        ids, errors = [], {}
        for r in rows:
            uid = str(r["fields"].get("user_id") or "").strip()
            if uid:
                ids.append(uid)
            else:
                errors[r["id"]] = "No visitor ID value"
        return ids, errors

    # ---- interface ---------------------------------------------------------------------------
    def test(self) -> str:
        key = self.key
        if not self.config.get("service_account_json"):
            return f"Ready. Your site can look visitors up and send {key}=<audience> to Ad Manager. (No service account: create the key in Ad Manager yourself.)"
        r = self.http.get(f"{ADMANAGER}/networks/{self.network_code}/customTargetingKeys", params={"pageSize": 1000},
                          headers={"Authorization": f"Bearer {self._access_token(ADMANAGER_SCOPE)}"})
        if r.status_code >= 300:
            raise ValueError(f"Ad Manager refused the service account ({r.status_code}): {r.text[:200]}")
        exists = any(k.get("adTagName") == key for k in r.json().get("customTargetingKeys", []))
        return f"Connected to network {self.network_code}. Key “{key}” {'already exists' if exists else 'will be created on the first sync'}."

    def prepare(self) -> dict:
        """Create the key and this audience's value in Ad Manager (if a service account is set). Never fails the run."""
        if not (self.config.get("service_account_json") and self.config.get("network_code")):
            return {}
        try:
            self._ensure_value(self._ensure_key())
        except Exception as e:  # noqa: BLE001 — membership still works with a manually created key
            self.record("POST", f"{ADMANAGER}/networks/{self.config.get('network_code')}/customTargeting…", "setup", None, f"Skipped: {e}")
        return {}

    def upsert(self, rows):
        ids, errors = self._ids(rows)
        targeting.add(self.key, self.value, int(self.context.get("sync_id") or 0), ids)
        return errors

    def remove(self, rows):
        ids, errors = self._ids(rows)
        targeting.remove(self.key, self.value, ids)
        return errors

    # ---- Ad Manager objects --------------------------------------------------------------------
    def _api(self, method: str, path: str, **kw):
        url = f"{ADMANAGER}/networks/{self.network_code}/{path}"
        r = self.http.request(method, url, headers={"Authorization": f"Bearer {self._access_token(ADMANAGER_SCOPE)}"}, **kw)
        self.record(method, url, kw.get("json") or kw.get("params"), r.status_code, r.text)
        if r.status_code >= 300:
            raise ValueError(f"Ad Manager answered {r.status_code}: {r.text[:200]}")
        return r.json()

    def _ensure_key(self) -> str:
        keys = self._api("GET", "customTargetingKeys", params={"pageSize": 1000}).get("customTargetingKeys", [])
        found = next((k for k in keys if k.get("adTagName") == self.key), None)
        if found:
            return found["name"]
        return self._api("POST", "customTargetingKeys", json={"adTagName": self.key, "displayName": "MediaMint CDP audiences",
                                                              "type": "PREDEFINED", "reportableType": "OFF"})["name"]

    def _ensure_value(self, key_name: str) -> None:
        values = self._api("GET", "customTargetingValues", params={"pageSize": 1000}).get("customTargetingValues", [])
        if any(v.get("customTargetingKey") == key_name and v.get("adTagName") == self.value for v in values):
            return
        self._api("POST", "customTargetingValues", json={"customTargetingKey": key_name, "adTagName": self.value,
                                                        "displayName": self.context.get("audience_name") or self.value, "matchType": "EXACT"})
