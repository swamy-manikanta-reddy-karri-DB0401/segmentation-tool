"""FreeWheel Data Suite: deliver audience segments to FreeWheel's Audience Manager as files in S3.

Settings mirror Hightouch's "FreeWheel Data Suite" destination (docs.hightouch.com/destinations/
freewheel-data-suite): environment, client network ID, data provider name and, under Advanced, a bucket
override; per sync a new or existing segment, its attributes (name, description, CPM price, TTL), the
taxonomy settings, one or more ID types each mapped to a column, and a full resync interval.

Hightouch delivers with its own AWS role that FreeWheel already trusts. MediaMint isn't a registered
FreeWheel partner, so the destination also takes AWS credentials that the bucket owner has allowed to
write, and a bucket override is required (FreeWheel's default ingestion buckets only accept partners).

FreeWheel's ingestion spec is only shared during partner onboarding, so the file layout below comes from
the public docs and must be checked against that spec before going live:

* Membership: CSV with no header, an identifier then its segment ID, one file per ID type per run
  (Adobe Experience Platform's FreeWheel destination; Hightouch: "one membership file per ID type").
* Taxonomy: CSV with a header. Adobe documents  Segment ID,Segment Name,TTL ; the other columns carry
  Hightouch's segment settings, whose column names FreeWheel's spec defines (see TAXONOMY_COLUMNS).
* Paths are Hive-style partitions, e.g. .../delivery_date=YYYY-MM-DD/, and file names have no spaces
  (FreeWheel Publisher API, segment ingestion status).

Removals aren't sent: the public docs don't show how a removal is written, so people who leave the
audience drop out of the segment when its TTL runs out (a full resync re-delivers everyone still in it).

Test connection only reads (who the credentials belong to, and a listing of the folder).
"""
from __future__ import annotations

import ipaddress
import json
import re
from datetime import datetime, timezone

from .base import ConfigField, Destination, SyncType, TargetField, fail_all

# Hightouch's ID types, in its order. `file` is the token used in our file names.
ID_TYPES = [
    ("aaid", "AAID (Android)"),
    ("idfa", "IDFA (Apple)"),
    ("ctv", "CTV device ID"),  # Roku, Fire TV, Samsung Tizen, Apple TV… all go here
    ("ipv4", "IPv4 address"),
    ("ipv6", "IPv6 address"),
    ("fw_cookie", "FreeWheel cookie"),
    ("experian_luid", "Experian ID (LUID)"),
    ("liveramp_idl", "LiveRamp ID (IDL)"),
    ("tapad_hhid", "Tapad household ID"),
]
# First three are Adobe's documented header; the rest follow Hightouch's segment settings.
TAXONOMY_COLUMNS = ["Segment ID", "Segment Name", "TTL", "Description", "CPM", "Data Provider",
                    "Use Restrictions", "Custom", "SPI Indicator", "Federated", "Geo", "Network ID"]
GEO = [{"value": "zip", "label": "Zip code"}, {"value": "postal", "label": "Postal code"}, {"value": "country", "label": "Country"}]
DEFAULT_PARTNER_PREFIX = "audience_partner=mediamint"
_BAD_VALUE = re.compile(r"[,\s\"]")


def split_location(value: str) -> tuple[str, str]:
    """Bucket override -> (bucket or access point ARN, folder). Accepts a bucket name, s3://bucket/folder or an ARN."""
    v = (value or "").strip()
    if not v:
        raise ValueError("Set the bucket override: FreeWheel's default ingestion buckets only accept registered partners")
    if v.startswith("arn:"):
        return v, DEFAULT_PARTNER_PREFIX
    bucket, _, prefix = v.removeprefix("s3://").strip("/").partition("/")
    return bucket, prefix.strip("/") or DEFAULT_PARTNER_PREFIX


def _safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_\-.=]", "_", text)


def _values(raw) -> list[str]:
    """A cell -> identifiers. Array columns expand to one identifier each."""
    if raw is None:
        return []
    if isinstance(raw, str) and raw.strip().startswith("["):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            pass
    items = raw if isinstance(raw, (list, tuple)) else [raw]
    return [s for s in (str(x).strip() for x in items if x is not None) if s]


def _valid(value: str, id_type: str) -> str | None:
    if _BAD_VALUE.search(value):
        return "contains a comma, space or quote"
    if id_type in ("ipv4", "ipv6"):
        try:
            if ipaddress.ip_address(value).version != (4 if id_type == "ipv4" else 6):
                raise ValueError
        except ValueError:
            return f"isn't a valid {'IPv4' if id_type == 'ipv4' else 'IPv6'} address"
    return None


class FreeWheel(Destination):
    type = "freewheel"
    label = "FreeWheel Data Suite"
    description = ("Create segments in FreeWheel's Audience Manager and keep their membership in sync with your "
                   "audiences, for CTV and video ad targeting.")
    category = "Advertising"
    config_fields = [
        ConfigField("environment", "Environment", type="select", default="staging",
                    options=[{"value": "staging", "label": "Staging"}, {"value": "production", "label": "Production"}],
                    help="FreeWheel recommends validating your first syncs on Staging before switching to Production."),
        ConfigField("network_id", "Client network ID",
                    help="Your FreeWheel network ID for first-party data, or -1 to make segments available to all networks as "
                         "third-party data. Staging and Production use different IDs, so update this when you switch."),
        ConfigField("data_provider_name", "Data provider name", required=False,
                    help="Recorded as the data provider on segments this destination creates, typically your company name."),
        ConfigField("aws_access_key_id", "AWS access key ID",
                    help="An AWS key the bucket owner has allowed to write, get and list in the bucket override folder."),
        ConfigField("aws_secret_access_key", "AWS secret access key", type="password"),
        ConfigField("bucket_override", "Bucket override", advanced=True,
                    help="Where FreeWheel ingests your files: a bucket name, s3://bucket/folder, or an S3 Access Point ARN. "
                         "Without a folder, files go under audience_partner=mediamint/. Confirm the location with FreeWheel."),
        ConfigField("taxonomy_location", "Taxonomy location", required=False, advanced=True,
                    help="s3://bucket/folder for segment descriptions (name, TTL, CPM…). Leave empty if FreeWheel registers "
                         "your segments another way."),
        ConfigField("role_arn", "Role to assume", required=False, advanced=True,
                    help="If write access was granted to an IAM role instead of the key itself, the role's ARN."),
    ]
    batch_size = 500_000

    @classmethod
    def sync_types(cls) -> list[SyncType]:
        new = {"segment": "new"}
        return [SyncType(
            name="audience", label="Audiences",
            description="Each run delivers the people who joined the audience, one membership file per ID type.",
            modes=["all"],
            target_fields=[TargetField(name, label) for name, label in ID_TYPES],  # map one or more; all CTV device IDs go to ctv
            delete_behaviors={"do_nothing": "They drop out of the segment when its TTL runs out"},
            options=[
                ConfigField("segment", "Segment", type="select", default="new",
                            options=[{"value": "new", "label": "Create a new segment"},
                                     {"value": "existing", "label": "Sync to an existing segment"}],
                            help="New: gets the ID mediamint-sync-<sync ID> and is registered with FreeWheel on every run. "
                                 "Existing: only membership is delivered to a segment FreeWheel already has."),
                ConfigField("segment_id", "Segment ID", show_if={"segment": "existing"},
                            help="The FreeWheel segment ID. Its name, pricing and TTL aren't changed."),
                ConfigField("segment_name", "Segment name", required=False, show_if=new,
                            help="Blank uses the audience name. Supports {model.id}, {model.name} and {sync.id}, and > for "
                                 "hierarchy, e.g. Provider > Category > Segment."),
                ConfigField("segment_description", "Segment description", required=False, show_if=new,
                            help="Describe the segment in business terms."),
                ConfigField("cpm_price", "CPM price", type="number", required=False, show_if=new,
                            help="What advertisers pay to use the segment. Leave blank for first-party segments only you use."),
                ConfigField("ttl_days", "Time to live (TTL) in days", type="number", required=False, show_if=new,
                            help="Days members stay in the segment after ingestion (0–90). Blank uses FreeWheel's default."),
                ConfigField("use_restrictions", "Use restrictions", required=False, advanced=True, show_if=new,
                            help="Any value hides the segment in FreeWheel's UI. Leave unset unless FreeWheel instructs otherwise."),
                ConfigField("custom", "Custom", type="toggle", required=False, advanced=True, show_if=new,
                            help="Marks the segment as custom (first-party) rather than syndicated."),
                ConfigField("spi", "SPI indicator", type="toggle", required=False, advanced=True, show_if=new,
                            help="Flags sensitive personal information. FreeWheel doesn't allow removing it once set."),
                ConfigField("federated", "Federated", type="toggle", required=False, advanced=True, show_if=new,
                            help="Marks the segment as federated."),
                ConfigField("geo", "Geo", type="select", required=False, advanced=True, show_if=new, options=GEO,
                            help="Only for geo segments: how FreeWheel reads the external ID."),
                ConfigField("full_resync_days", "Full resync interval (days)", type="number", required=False, advanced=True,
                            help="Every N days, re-deliver the whole audience instead of only the changes. Blank = never."),
            ],
        )]

    def __init__(self, config, context=None):
        super().__init__(config, context)
        self._s3 = None
        self._files = 0
        self._stamp = datetime.now(timezone.utc)

    # ---- AWS -------------------------------------------------------------------
    def _session(self):
        import boto3

        key, secret = (self.config.get("aws_access_key_id") or "").strip(), self.config.get("aws_secret_access_key") or ""
        if not key or not secret:
            raise ValueError("Enter the AWS access key ID and secret access key")
        session = boto3.Session(aws_access_key_id=key, aws_secret_access_key=secret, region_name="us-east-1")
        role = (self.config.get("role_arn") or "").strip()
        if role:
            creds = session.client("sts").assume_role(RoleArn=role, RoleSessionName="mediamint-cdp")["Credentials"]
            session = boto3.Session(aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"],
                                    aws_session_token=creds["SessionToken"], region_name="us-east-1")
        return session

    @property
    def s3(self):
        if self._s3 is None:
            self._s3 = self._session().client("s3")
        return self._s3

    # ---- segment -----------------------------------------------------------------
    @property
    def existing(self) -> bool:
        return (self.options.get("segment") or "new") == "existing"

    @property
    def segment_id(self) -> str:
        if self.existing:
            sid = str(self.options.get("segment_id") or "").strip()
            if not sid:
                raise ValueError("Enter the FreeWheel segment ID, or choose Create a new segment")
            return sid
        return f"mediamint-sync-{self.context.get('sync_id', 'test')}"

    def segment_name(self) -> str:
        template = (self.options.get("segment_name") or "").strip()
        if not template:
            return self.context.get("audience_name") or self.segment_id
        values = {"model.id": self.context.get("model_id", ""), "model.name": self.context.get("model_name", ""),
                  "sync.id": self.context.get("sync_id", "")}
        return re.sub(r"\{\s*(model\.id|model\.name|sync\.id)\s*\}", lambda m: str(values[m.group(1)]), template)

    def _number(self, name: str, label: str, low: float, high: float | None = None) -> str:
        raw = self.options.get(name)
        if raw in (None, ""):
            return ""
        n = float(raw)
        if n < low or (high is not None and n > high):
            raise ValueError(f"{label} must be {'between ' + str(int(low)) + ' and ' + str(int(high)) if high is not None else 'at least ' + str(int(low))}")
        return str(int(n)) if n.is_integer() else str(n)

    def build_taxonomy(self) -> str:
        o = self.options
        flag = lambda k: "Y" if str(o.get(k) or "").lower() in ("true", "1", "y", "yes") else "N"  # noqa: E731
        row = [self.segment_id, self.segment_name(), self._number("ttl_days", "TTL", 0, 90),
               o.get("segment_description") or "", self._number("cpm_price", "CPM price", 0),
               self.config.get("data_provider_name") or "", o.get("use_restrictions") or "",
               flag("custom"), flag("spi"), flag("federated"), o.get("geo") or "", str(self.config.get("network_id") or "")]
        cell = lambda v: f'"{v}"' if any(c in str(v) for c in ',"\n') else str(v)  # noqa: E731
        return ",".join(TAXONOMY_COLUMNS) + "\n" + ",".join(cell(str(v).replace('"', '""')) for v in row) + "\n"

    def prepare(self) -> dict:
        self.segment_id  # existing segment chosen without an ID: stop before anything is written
        if self.existing:
            return {}
        taxonomy = self.build_taxonomy()  # validates TTL / CPM before anything is written
        where = (self.config.get("taxonomy_location") or "").strip()
        if where:
            bucket, prefix = split_location(where)
            self._put(bucket, self._key(prefix, "taxonomy"), taxonomy, "segment registration")
        return {}

    # ---- interface -----------------------------------------------------------------
    def test(self) -> str:
        from botocore.exceptions import BotoCoreError, ClientError

        bucket, prefix = split_location(self.config.get("bucket_override"))
        try:
            who = self._session().client("sts").get_caller_identity()["Arn"]
            listed = self.s3.list_objects_v2(Bucket=bucket, Prefix=f"{prefix}/", MaxKeys=5)
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("AccessDenied", "AllAccessDisabled", "403"):
                raise ValueError(f"These AWS credentials can't list s3://{bucket}/{prefix}. Ask the bucket owner to allow "
                                 "write, get and list on that folder.") from e
            if code == "NoSuchBucket":
                raise ValueError(f"Bucket {bucket} doesn't exist; check the location FreeWheel gave you.") from e
            if code in ("InvalidClientTokenId", "SignatureDoesNotMatch", "InvalidAccessKeyId"):
                raise ValueError("AWS didn't accept the access key / secret.") from e
            raise ValueError(f"AWS returned {code}: {e}") from e
        except BotoCoreError as e:
            raise ValueError(f"Couldn't reach AWS: {e}") from e
        msg = f"Signed in as {who}. Can read s3://{bucket}/{prefix} ({listed.get('KeyCount', 0)} files seen). Nothing was uploaded."
        if (self.config.get("environment") or "staging") == "staging" and re.search(r"(^|[-_.])pro?d([-_.]|$)", bucket):
            msg += " Note: the environment is Staging but the bucket name looks like production."
        return msg

    def upsert(self, rows):
        if not rows:
            return {}
        bucket, prefix = split_location(self.config.get("bucket_override"))
        mapped = [t for t, _ in ID_TYPES if t in (self.context.get("mapped_targets") or [])] or \
                 [t for t, _ in ID_TYPES if any(t in r["fields"] for r in rows)]
        problems: dict[str, str] = {}
        failed: dict[str, str] = {}
        sent: set[str] = set()
        for id_type in mapped:  # one membership file per ID type
            lines, row_ids = self.build_lines(rows, id_type, problems)
            if not lines:
                continue
            try:
                self._put(bucket, self._key(prefix, id_type), "\n".join(lines) + "\n", f"{len(lines)} {id_type} identifiers")
                sent |= row_ids
            except Exception as e:  # noqa: BLE001 — the whole file failed; those rows are retried next run
                for rid in row_ids:
                    failed.setdefault(rid, f"Upload of the {id_type} file failed: {e}")
        # A person counts as delivered when at least one of their IDs was; otherwise report why not.
        return {r["id"]: failed.get(r["id"]) or problems.get(r["id"], "No identifier value in any mapped ID type")
                for r in rows if r["id"] in failed or r["id"] not in sent}

    def build_lines(self, rows: list[dict], id_type: str, errors: dict[str, str]) -> tuple[list[str], set[str]]:
        """Lines `identifier,segment id` for one ID type, and the rows they came from. Bad values are noted in `errors`."""
        seg = self.segment_id
        lines: list[str] = []
        ids: set[str] = set()
        for r in rows:
            for v in _values(r["fields"].get(id_type)):
                problem = _valid(v, id_type)
                if problem:
                    errors.setdefault(r["id"], f"{id_type} value {problem}")
                else:
                    lines.append(f"{v},{seg}")
                    ids.add(r["id"])
        return lines, ids

    def close(self):
        self._s3 = None

    # ---- files -------------------------------------------------------------------
    def _key(self, prefix: str, kind: str) -> str:
        self._files += 1
        net = str(self.config.get("network_id") or "").strip()
        name = _safe(f"{kind}_net{net}_sync{self.context.get('sync_id', 'test')}_run{self.context.get('run_id', 0)}"
                     f"_{self._stamp:%Y%m%d%H%M%S}_{self._files}.csv")
        return f"{prefix}/delivery_date={self._stamp:%Y-%m-%d}/{name}"

    def _put(self, bucket: str, key: str, body: str, what: str) -> None:
        r = self.s3.put_object(Bucket=bucket, Key=key, Body=body.encode(), ContentType="text/csv")
        preview = "\n".join(body.splitlines()[:6])
        self.record("PUT", f"s3://{bucket}/{key}", f"{what}\n{preview}",
                    r.get("ResponseMetadata", {}).get("HTTPStatusCode"), {"ETag": r.get("ETag")})
