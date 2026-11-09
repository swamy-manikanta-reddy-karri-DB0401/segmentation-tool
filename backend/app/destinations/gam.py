"""Google Ad Manager 360: batch-upload audience segment membership.

Ad Manager imports segment membership from CSV files placed in the network's Cloud Storage
bucket (Ad Manager Help, "Batch upload identifiers to audience segments"):

    <identifier type>,list_id,delete,process_consent
    ppid-123,3153490,0,

* list_id is the audience segment ID (Inventory > Audience segments).
* delete: 1 removes the identifier from the segment, 0 adds/refreshes it.
* the process_consent header must be present (and last); the cell may be left blank.
* LF line endings; one file can target several segments.
* Limits: 500 files and 5 GB per 24 h, 1 GB per file. Processing takes up to 24 h, and Ad Manager
  writes a .success / .fail log per file to gdfp_cookieupload_result_<network code>.

Files are written with a Google Cloud service account (JSON key) that has Storage Object Admin
on the bucket. Each run writes at most one file for joins and one for leaves; if an upload fails
the rows are reported as failed so the next run retries them.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
import jwt

from .base import ConfigField, Destination, SyncType, TargetField, fail_all

SCOPE = "https://www.googleapis.com/auth/devstorage.read_write"
ADMANAGER_SCOPE = "https://www.googleapis.com/auth/admanager"
STORAGE = "https://storage.googleapis.com"
ADMANAGER = "https://admanager.googleapis.com/v1"

ID_TYPES = [
    {"value": "ppid", "label": "PPID (publisher provided ID, raw)"},
    {"value": "cookie_encrypted", "label": "Encrypted ID (cookie / PPID / device ID from Data Transfer)"},
    {"value": "cookie_adid", "label": "Android advertising ID (AdID)"},
    {"value": "cookie_idfa", "label": "Apple IDFA"},
    {"value": "cookie_rida", "label": "Roku ID (RIDA)"},
    {"value": "cookie_tvos", "label": "tvOS ID"},
]
_BAD_VALUE = re.compile(r"[,\r\n\"]")


def parse_service_account(raw: str) -> dict:
    try:
        info = json.loads(raw or "")
    except json.JSONDecodeError as e:
        raise ValueError("The service account key isn't valid JSON — paste the whole .json file") from e
    missing = [k for k in ("client_email", "private_key", "token_uri") if not info.get(k)]
    if info.get("type") != "service_account" or missing:
        raise ValueError("That JSON isn't a service account key (expected type service_account with client_email and private_key)")
    return info


class GoogleAdManager(Destination):
    type = "gam"
    label = "Google Ad Manager 360"
    description = ("Add and remove people in Ad Manager first-party audience segments by uploading identifier "
                   "files (PPID or device IDs) to your network's Cloud Storage bucket.")
    category = "Advertising"
    config_fields = [
        ConfigField("service_account_json", "Service account key (JSON)", type="textarea", secret=True,
                    help="Paste the whole key file of a Google Cloud service account that has Storage Object Admin on the bucket below."),
        ConfigField("bucket", "Cloud Storage bucket",
                    help="The Ad Manager audience upload bucket for your network — the name only, not a gs:// URL."),
        ConfigField("network_code", "Ad Manager network code", required=False,
                    help="Admin → Global settings. Used to label files and find the result logs."),
        ConfigField("folder", "Folder in the bucket", required=False, default="mediamint",
                    help="Files are written under <folder>/sync-<id>/."),
    ]
    batch_size = 200_000

    @classmethod
    def sync_types(cls) -> list[SyncType]:
        return [SyncType(
            name="segment", label="Audience segment membership",
            description="Each run uploads the people who joined (and, optionally, left) the audience since the last run.",
            modes=["add"],
            target_fields=[
                TargetField("identifier", "Identifier (PPID or device ID)", required=True),
                TargetField("list_id", "Segment ID (per row, optional)"),
            ],
            delete_behaviors={"do_nothing": "Leave them in the segment (they expire per the segment's membership duration)",
                              "remove": "Remove them from the segment (uploads delete = 1)"},
            options=[
                ConfigField("identifier_type", "Identifier type", type="select", default="ppid", options=ID_TYPES,
                            help="Must match the IDs in the mapped column. PPIDs and encrypted IDs only work in the network they came from."),
                ConfigField("list_id", "Audience segment ID", required=False,
                            help="Inventory → Audience segments. Leave empty and a segment named after the audience is created "
                                 "in Ad Manager on the first run. New segments take up to 24 h before they accept uploads."),
                ConfigField("membership_days", "Membership duration (days)", type="number", required=False, default=540,
                            help="Only for segments created here: days of inactivity before Ad Manager drops someone (1–540)."),
            ],
        )]

    def __init__(self, config, context=None):
        super().__init__(config, context)
        self.http = httpx.Client(timeout=120)
        self._tokens: dict[str, tuple[str, float]] = {}
        self._files = 0

    # ---- auth -----------------------------------------------------------------
    def _access_token(self, scope: str = SCOPE) -> str:
        hit = self._tokens.get(scope)
        if hit and hit[1] > time.time() + 60:
            return hit[0]
        info = parse_service_account(self.config.get("service_account_json"))
        now = int(time.time())
        assertion = jwt.encode({"iss": info["client_email"], "scope": scope, "aud": info["token_uri"],
                                "iat": now, "exp": now + 3600}, info["private_key"], algorithm="RS256",
                               headers={"kid": info.get("private_key_id")})
        r = self.http.post(info["token_uri"], data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                                    "assertion": assertion})
        if r.status_code >= 400:
            raise ValueError(f"Google rejected the service account key: {r.text[:200]}")
        d = r.json()
        self._tokens[scope] = (d["access_token"], time.time() + int(d.get("expires_in", 3600)))
        return d["access_token"]

    # ---- Ad Manager API: segments -------------------------------------------------
    @property
    def network_code(self) -> str:
        code = str(self.config.get("network_code") or "").strip()
        if not code.isdigit():
            raise ValueError("Set the Ad Manager network code on the destination to create segments")
        return code

    def create_segment(self, name: str, membership_days: int | str | None = None) -> dict:
        """Create a first-party segment with no rule, so its members come only from our uploads."""
        days = 540 if membership_days in (None, "") else int(membership_days)
        if not 1 <= days <= 540:
            raise ValueError("Membership duration must be between 1 and 540 days")
        name = (name or "").strip()[:255]
        if not name:
            raise ValueError("Give the segment a name")
        body = {"displayName": name, "description": "Created by MediaMint CDP; members are uploaded by its syncs.",
                "nonRuleBasedFirstPartyAudienceSegment": {"membershipExpirationDays": str(days)}}
        url = f"{ADMANAGER}/networks/{self.network_code}/audienceSegments"
        r = self.http.post(url, json=body, headers={"Authorization": f"Bearer {self._access_token(ADMANAGER_SCOPE)}"})
        self.record("POST", url, body, r.status_code, r.text)
        if r.status_code >= 300:
            try:
                msg = r.json()["error"]["message"]
            except Exception:  # noqa: BLE001
                msg = r.text[:300]
            raise ValueError(f"Ad Manager didn't create the segment: {msg}")
        d = r.json()
        return {"id": d["name"].rsplit("/", 1)[-1], "name": d.get("displayName", name), "status": d.get("status")}

    def prepare(self) -> dict:
        if str(self.options.get("list_id") or "").strip() or "list_id" in (self.context.get("mapped_targets") or []):
            return {}
        seg = self.create_segment(self.context.get("audience_name") or "MediaMint audience", self.options.get("membership_days"))
        self.options["list_id"] = seg["id"]
        return {"list_id": seg["id"]}

    @property
    def bucket(self) -> str:
        b = (self.config.get("bucket") or "").strip().removeprefix("gs://").strip("/")
        if not b:
            raise ValueError("Set the Cloud Storage bucket")
        return b

    # ---- interface ------------------------------------------------------------
    def test(self) -> str:
        email = parse_service_account(self.config.get("service_account_json"))["client_email"]
        token = self._access_token()
        r = self.http.get(f"{STORAGE}/storage/v1/b/{quote(self.bucket, safe='')}/o",
                          params={"maxResults": 1, "prefix": self._folder()}, headers={"Authorization": f"Bearer {token}"})
        if r.status_code in (401, 403):
            raise ValueError(f"{email} can't access bucket {self.bucket}. Grant it Storage Object Admin on that bucket.")
        if r.status_code == 404:
            raise ValueError(f"Bucket {self.bucket} doesn't exist — check the name with your Ad Manager account team.")
        if r.status_code >= 400:
            raise ValueError(f"Cloud Storage returned {r.status_code}: {r.text[:200]}")
        return f"Signed in as {email} and can write to gs://{self.bucket}/{self._folder()}"

    def upsert(self, rows):
        return self._upload(rows, delete=False)

    def remove(self, rows):
        return self._upload(rows, delete=True)

    def close(self):
        self.http.close()

    # ---- files ----------------------------------------------------------------
    def _folder(self) -> str:
        return re.sub(r"[^A-Za-z0-9_\-/]", "_", (self.config.get("folder") or "mediamint").strip("/")) or "mediamint"

    def build_file(self, rows: list[dict], delete: bool) -> tuple[str, dict[str, str], int]:
        """CSV text, per-row errors, number of data lines."""
        id_type = self.options.get("identifier_type") or "ppid"
        default_list = str(self.options.get("list_id") or "").strip()
        lines = [f"{id_type},list_id,delete,process_consent"]
        errors: dict[str, str] = {}
        for r in rows:
            ident = str(r["fields"].get("identifier") or "").strip()
            list_id = str(r["fields"].get("list_id") or default_list).strip()
            if not ident:
                errors[r["id"]] = "No identifier value"
            elif _BAD_VALUE.search(ident):
                errors[r["id"]] = "Identifier contains a comma, quote or line break"
            elif not list_id.isdigit():
                errors[r["id"]] = "No valid audience segment ID (set one in the sync options or map a Segment ID column)"
            else:
                lines.append(f"{ident},{list_id},{1 if delete else 0},")
        return "\n".join(lines) + "\n", errors, len(lines) - 1

    def _upload(self, rows: list[dict], delete: bool) -> dict[str, str]:
        if not rows:
            return {}
        body, errors, n = self.build_file(rows, delete)
        if not n:
            return errors
        self._files += 1
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        net = f"net{self.config['network_code']}-" if self.config.get("network_code") else ""
        name = (f"{self._folder()}/sync-{self.context.get('sync_id', 'test')}/"
                f"{net}run{self.context.get('run_id', 0)}-{stamp}-{'remove' if delete else 'add'}-{self._files}.csv")
        url = f"{STORAGE}/upload/storage/v1/b/{quote(self.bucket, safe='')}/o"
        try:
            r = self.http.post(url, params={"uploadType": "media", "name": name}, content=body.encode(),
                               headers={"Authorization": f"Bearer {self._access_token()}", "Content-Type": "text/csv"})
        except (httpx.HTTPError, ValueError) as e:
            return {**errors, **fail_all([x for x in rows if x["id"] not in errors], str(e))}
        preview = "\n".join(body.splitlines()[:6])
        self.record("POST", f"gs://{self.bucket}/{name}", f"{n} identifiers\n{preview}", r.status_code, r.text)
        if r.status_code >= 300:
            return {**errors, **fail_all([x for x in rows if x["id"] not in errors], f"Upload failed ({r.status_code}): {r.text[:200]}")}
        return errors
