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

Settings follow Hightouch's Google Ad Manager 360 destination (docs.hightouch.com/destinations/gam360):
GCP credentials, project ID and bucket name (+ network code for automatic segment creation); per sync
Insert or All mode, a column mapped to an identifier type, List ID from a column or a static value, or
"Automatically create the audience segment" (segment name, membership days 1-540), a filename template
with timestamp variables and an offset, and "Skip empty files" in Insert mode.

Files are written with a Google Cloud service account (JSON key) that has Storage Object Admin on the
bucket. Hightouch creates segments through a Google sign-in; here the same service account calls the
Ad Manager API, so it must also be an API user in the network (Admin → Global settings → API access).
New segments only accept uploads after ~24 h, so uploads wait 25 h after creation; rows held back
meanwhile are retried on later runs. If an upload fails the rows are reported as failed so the next
run retries them.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
import jwt

from .base import ConfigField, Destination, SyncType, TargetField, fail_all

SCOPE = "https://www.googleapis.com/auth/devstorage.read_write"
ADMANAGER_SCOPE = "https://www.googleapis.com/auth/admanager"
STORAGE = "https://storage.googleapis.com"
ADMANAGER = "https://admanager.googleapis.com/v1"

ID_TYPES = [
    ("ppid", "PPID (publisher provided ID, raw)"),
    ("cookie_encrypted", "Encrypted ID (cookie / PPID / device ID from Data Transfer)"),
    ("cookie_adid", "Android advertising ID (AdID)"),
    ("cookie_idfa", "Apple IDFA"),
    ("cookie_rida", "Roku ID (RIDA)"),
    ("cookie_tvos", "tvOS ID"),
]
_BAD_VALUE = re.compile(r"[,\r\n\"]")
DEFAULT_FILENAME = "mediamint/sync-{sync.id}/{YYYY}{MM}{DD}T{HH}{mm}{ss}Z-run{sync.run.id}.csv"
_VARS = re.compile(r"\{\s*(YYYY|YY|MM|DD|HH|mm|ss|ms|X|x|model\.id|model\.name|sync\.id|sync\.run\.id)\s*\}")


def parse_service_account(raw: str) -> dict:
    try:
        info = json.loads(raw or "")
    except json.JSONDecodeError as e:
        raise ValueError("The service account key isn't valid JSON — paste the whole .json file") from e
    missing = [k for k in ("client_email", "private_key", "token_uri") if not info.get(k)]
    if info.get("type") != "service_account" or missing:
        raise ValueError("That JSON isn't a service account key (expected type service_account with client_email and private_key)")
    return info


def _flag(value) -> bool:
    return str(value or "").lower() == "true"


class GoogleAdManager(Destination):
    type = "gam"
    label = "Google Ad Manager 360"
    description = ("Add people to Ad Manager first-party audience segments by uploading identifier files "
                   "(PPID or device IDs) to your Cloud Storage bucket.")
    category = "Advertising"
    config_fields = [
        ConfigField("service_account_json", "GCP credentials", type="textarea", secret=True,
                    help="Paste the whole JSON key of a Google Cloud service account. It uploads the identifier files and, "
                         "for automatic segment creation, must also be an API user in your Ad Manager network."),
        ConfigField("project_id", "GCP Project ID", help="The Google Cloud project the bucket belongs to."),
        ConfigField("bucket", "GCS Bucket Name",
                    help="The bucket name only, not a URL. Grant the service account Storage Object Admin on it: "
                         "gcloud storage buckets add-iam-policy-binding gs://BUCKET --member=serviceAccount:EMAIL "
                         "--role=roles/storage.objectAdmin"),
        ConfigField("network_code", "Ad Manager Network Code", required=False,
                    help="Required for automatic segment creation. Ad Manager → Admin → Global settings."),
    ]
    batch_size = 200_000

    @classmethod
    def sync_types(cls) -> list[SyncType]:
        auto = {"auto_create": "true"}
        return [SyncType(
            name="segment", label="Any data set",
            description="Uploads a CSV of identifiers and segment IDs to the bucket; Ad Manager adds them to the segment.",
            modes=["insert", "all"],
            resend_all_modes=["all"],
            target_fields=[TargetField(v, label) for v, label in ID_TYPES] + [TargetField("list_id", "List ID (segment ID)")],
            delete_behaviors={"do_nothing": "Leave them in the segment (they expire per the segment's membership duration)",
                              "remove": "Remove them from the segment (uploads delete = 1)"},
            options=[
                ConfigField("auto_create", "Automatically create the audience segment in Google Ad Manager", type="toggle",
                            required=False,
                            help="On: the first run creates a first-party segment with no rule, so its members come only from "
                                 "your uploads. Off: map List ID in Fields to send, to a column (a segment per row) or a static value."),
                ConfigField("segment_name", "Segment name", required=False, show_if=auto,
                            help="Defaults to the audience name. Can't be changed from here after the first run."),
                ConfigField("membership_days", "How long should users remain in the segment?", type="number", required=False,
                            default=540, show_if=auto, help="Days, 1–540, counted from each upload."),
                ConfigField("filename", "Filename", required=False, default=DEFAULT_FILENAME,
                            help="Folder and file name in the bucket. Variables (UTC): {YYYY} {YY} {MM} {DD} {HH} {mm} {ss} {ms} "
                                 "{X} {x}, and {model.id} {model.name} {sync.id} {sync.run.id}. An existing file is overwritten."),
                ConfigField("filename_offset", "Set filename offset", type="number", required=False,
                            help="Seconds added to the run time in the filename variables, e.g. -86400 for yesterday's date."),
                ConfigField("skip_empty", "Skip empty files", type="toggle", required=False, modes=["insert"],
                            help="Don't upload a file when nothing changed since the last sync."),
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
            raise ValueError("Network code required: set the Ad Manager Network Code on the destination to create segments")
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

    @property
    def auto_create(self) -> bool:
        return _flag(self.options.get("auto_create"))

    def id_type(self, rows: list[dict] | None = None) -> str:
        """The mapped identifier type (exactly one); older syncs mapped `identifier` + an identifier_type option."""
        mapped = self.context.get("mapped_targets") or [k for r in (rows or [])[:1] for k in r["fields"]]
        types = [v for v, _ in ID_TYPES if v in mapped]
        if len(types) > 1:
            raise ValueError("Map one identifier type per sync (" + ", ".join(types) + " are all mapped)")
        return types[0] if types else (self.options.get("identifier_type") or "ppid")

    def prepare(self) -> dict:
        self.id_type()
        if str(self.options.get("list_id") or "").strip():
            return {}  # a static List ID, or the segment created on an earlier run
        if not self.auto_create:
            if "list_id" not in (self.context.get("mapped_targets") or []):
                raise ValueError("List ID is required when automatic segment creation is off: map List ID in Fields to send")
            return {}
        seg = self.create_segment(self.options.get("segment_name") or self.context.get("audience_name") or "MediaMint audience",
                                  self.options.get("membership_days"))
        created = {"list_id": seg["id"], "segment_created_at": datetime.now(timezone.utc).isoformat()}
        self.options.update(created)
        return created

    def _waiting_for_segment(self) -> str | None:
        """Ad Manager accepts uploads ~24 h after a segment is created; wait 25 h."""
        at = self.options.get("segment_created_at")
        if not at:
            return None
        ready = datetime.fromisoformat(at) + timedelta(hours=25)
        if datetime.now(timezone.utc) >= ready:
            return None
        return f"Segment created recently; this completes on a run after {ready:%Y-%m-%d %H:%M} UTC"

    @property
    def bucket(self) -> str:
        b = (self.config.get("bucket") or "").strip().removeprefix("gs://").strip("/")
        if not b:
            raise ValueError("Set the GCS bucket name")
        return b

    # ---- interface ------------------------------------------------------------
    def test(self) -> str:
        email = parse_service_account(self.config.get("service_account_json"))["client_email"]
        token = self._access_token()
        r = self.http.get(f"{STORAGE}/storage/v1/b/{quote(self.bucket, safe='')}/o",
                          params={"maxResults": 1}, headers={"Authorization": f"Bearer {token}"})
        if r.status_code in (401, 403):
            raise ValueError(f"{email} can't access bucket {self.bucket}. Grant it Storage Object Admin: gcloud storage buckets "
                             f"add-iam-policy-binding gs://{self.bucket} --member=serviceAccount:{email} --role=roles/storage.objectAdmin")
        if r.status_code == 404:
            raise ValueError(f"Bucket {self.bucket} doesn't exist — check the name with your Ad Manager account team.")
        if r.status_code >= 400:
            raise ValueError(f"Cloud Storage returned {r.status_code}: {r.text[:200]}")
        return f"Signed in as {email} and can access gs://{self.bucket}. Nothing was uploaded."

    def upsert(self, rows):
        return self._upload(rows, delete=False)

    def remove(self, rows):
        return self._upload(rows, delete=True)

    def finish(self) -> None:
        """No file written this run: upload a header-only file, unless Skip empty files is on (Insert mode)."""
        if self._files or self._waiting_for_segment():
            return
        if self.mode == "insert" and _flag(self.options.get("skip_empty")):
            return
        self._write(f"{self.id_type()},list_id,delete,process_consent\n", 0, "")

    def close(self):
        self.http.close()

    # ---- files ----------------------------------------------------------------
    def filename(self, suffix: str = "") -> str:
        """Render the filename template; later files in the same run get -2, -3… so they don't overwrite each other."""
        t = datetime.now(timezone.utc) + timedelta(seconds=float(self.options.get("filename_offset") or 0))
        values = {"YYYY": f"{t:%Y}", "YY": f"{t:%y}", "MM": f"{t:%m}", "DD": f"{t:%d}", "HH": f"{t:%H}", "mm": f"{t:%M}",
                  "ss": f"{t:%S}", "ms": f"{t.microsecond // 1000:03d}", "X": str(int(t.timestamp())),
                  "x": str(int(t.timestamp() * 1000)), "model.id": str(self.context.get("model_id", "")),
                  "model.name": str(self.context.get("model_name", "")), "sync.id": str(self.context.get("sync_id", "test")),
                  "sync.run.id": str(self.context.get("run_id", 0))}
        name = _VARS.sub(lambda m: values[m.group(1)], (self.options.get("filename") or DEFAULT_FILENAME).strip().lstrip("/"))
        stem, dot, ext = name.rpartition(".")
        if not dot or "/" in ext:
            stem, ext = name, "csv"
        tail = (f"-{suffix}" if suffix else "") + (f"-{self._files + 1}" if self._files else "")
        return f"{stem}{tail}.{ext}"

    def build_file(self, rows: list[dict], delete: bool) -> tuple[str, dict[str, str], int]:
        """CSV text, per-row errors, number of data lines."""
        id_type = self.id_type(rows)
        default_list = str(self.options.get("list_id") or "").strip()
        lines = [f"{id_type},list_id,delete,process_consent"]
        errors: dict[str, str] = {}
        for r in rows:
            ident = str(r["fields"].get(id_type) or r["fields"].get("identifier") or "").strip()
            list_id = str(r["fields"].get("list_id") or default_list).strip()
            if not ident:
                errors[r["id"]] = "No identifier value"
            elif _BAD_VALUE.search(ident):
                errors[r["id"]] = "Identifier contains a comma, quote or line break"
            elif not list_id.isdigit():
                errors[r["id"]] = "No valid audience segment ID (map List ID or turn on automatic segment creation)"
            else:
                lines.append(f"{ident},{list_id},{1 if delete else 0},")
        return "\n".join(lines) + "\n", errors, len(lines) - 1

    def _upload(self, rows: list[dict], delete: bool) -> dict[str, str]:
        if not rows:
            return {}
        waiting = self._waiting_for_segment()
        if waiting:
            return fail_all(rows, waiting)
        body, errors, n = self.build_file(rows, delete)
        if not n:
            return errors
        try:
            r = self._write(body, n, "remove" if delete else "")
        except (httpx.HTTPError, ValueError) as e:
            return {**errors, **fail_all([x for x in rows if x["id"] not in errors], str(e))}
        if r.status_code >= 300:
            return {**errors, **fail_all([x for x in rows if x["id"] not in errors], f"Upload failed ({r.status_code}): {r.text[:200]}")}
        return errors

    def _write(self, body: str, n: int, suffix: str) -> httpx.Response:
        name = self.filename(suffix)
        self._files += 1
        url = f"{STORAGE}/upload/storage/v1/b/{quote(self.bucket, safe='')}/o"
        r = self.http.post(url, params={"uploadType": "media", "name": name}, content=body.encode(),
                           headers={"Authorization": f"Bearer {self._access_token()}", "Content-Type": "text/csv"})
        preview = "\n".join(body.splitlines()[:6])
        self.record("POST", f"gs://{self.bucket}/{name}", f"{n} identifiers\n{preview}", r.status_code, r.text)
        return r
