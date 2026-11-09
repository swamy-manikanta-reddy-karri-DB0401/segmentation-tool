"""Minimal Sailthru API client (https://getstarted.sailthru.com/developers/api-basics/)."""
import hashlib
import json

import httpx

BASE = "https://api.sailthru.com"
MATCH_KEYS = {"email": "Email", "sid": "Sailthru profile ID (sid)", "extid": "External ID (extid)"}
ACTIONS = {
    "add_to_list": "Add users to a list (and set vars)",
    "update_profile": "Create / update user profiles (set vars)",
    "set_vars": "Set custom vars on existing profiles only",
}


class SailthruError(Exception):
    pass


class Sailthru:
    def __init__(self, api_key: str, api_secret: str, dry_run: bool = True):
        self.key, self.secret, self.dry_run = api_key, api_secret, dry_run
        self.http = httpx.Client(timeout=30)

    def _sig(self, params: dict) -> str:
        # md5(secret + sorted concatenation of all param values)
        values = sorted(str(v) for v in params.values())
        return hashlib.md5((self.secret + "".join(values)).encode()).hexdigest()

    def _params(self, payload: dict) -> dict:
        p = {"api_key": self.key, "format": "json", "json": json.dumps(payload, default=str)}
        p["sig"] = self._sig(p)
        return p

    def _call(self, method: str, action: str, payload: dict):
        p = self._params(payload)
        if method == "GET":
            r = self.http.get(f"{BASE}/{action}", params=p)
        else:
            r = self.http.post(f"{BASE}/{action}", data=p)
        try:
            body = r.json()
        except Exception:
            raise SailthruError(f"HTTP {r.status_code}: {r.text[:200]}")
        if r.status_code >= 400 or (isinstance(body, dict) and body.get("error")):
            msg = body.get("errormsg") if isinstance(body, dict) else None
            raise SailthruError(msg or r.text[:200])
        return body

    def test(self) -> str:
        self.lists()
        return "Authenticated with Sailthru"

    def lists(self) -> list[dict]:
        return self._call("GET", "list", {}).get("lists", [])

    def profile_exists(self, identifier: str, key: str) -> bool:
        if self.dry_run:
            return True
        try:
            self._call("GET", "user", {"id": identifier, "key": key, "fields": {"keys": 1}})
            return True
        except SailthruError as e:
            if "not found" in str(e).lower() or "does not exist" in str(e).lower():
                return False
            raise

    def push(self, action: str, identifier: str, key: str, variables: dict, list_name: str, subscribed: bool = True) -> dict:
        """Apply one sync action for one identifier. Raises SailthruError if the destination rejects it."""
        payload: dict = {"id": identifier, "key": key}
        if key == "email":
            payload["keysconflict"] = "merge"
        if action == "set_vars" and not self.profile_exists(identifier, key):
            raise SailthruError("Profile not found in Sailthru (set-vars only updates existing profiles)")
        if action == "add_to_list":
            payload["lists"] = {list_name: 1 if subscribed else 0}
        if subscribed and variables:  # removing someone from a list must not overwrite their profile data
            payload["vars"] = variables
        if self.dry_run:
            return {"dry_run": True, "payload": payload}
        return self._call("POST", "user", payload)
