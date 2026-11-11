import json

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.destinations.gam import GoogleAdManager, parse_service_account

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
SA = json.dumps({"type": "service_account", "client_email": "uploader@proj.iam.gserviceaccount.com",
                 "private_key": PEM, "private_key_id": "k1", "token_uri": "https://oauth2.googleapis.com/token"})


def row(i, ident, list_id=None):
    f = {"ppid": ident}
    if list_id:
        f["list_id"] = list_id
    return {"id": str(i), "match": None, "fields": f}


def dest(handler, **options):
    d = GoogleAdManager({"service_account_json": SA, "project_id": "proj", "bucket": "gs://gam-bucket/", "network_code": "1234"},
                        {"sync_id": 7, "run_id": 3, "mode": "insert", "mapped_targets": ["ppid"],
                         "options": {"list_id": "555", "filename": "mm/sync-{sync.id}/run{sync.run.id}.csv", **options}})
    d.http = httpx.Client(transport=httpx.MockTransport(handler))
    return d


def test_file_format_matches_ad_manager_spec():
    d = dest(lambda r: httpx.Response(200))
    body, errors, n = d.build_file([row(1, "abc"), row(2, "def", "777")], delete=False)
    assert body == "ppid,list_id,delete,process_consent\nabc,555,0,\ndef,777,0,\n"
    assert "\r" not in body and not errors and n == 2


def test_removals_use_delete_flag_and_bad_rows_are_rejected():
    d = dest(lambda r: httpx.Response(200))
    d.context["mapped_targets"] = ["cookie_adid"]
    rows = [{"id": str(i), "match": None, "fields": {"cookie_adid": v}} for i, v in ((1, "x1"), (2, ""), (3, "a,b"))]
    body, errors, n = d.build_file(rows, delete=True)
    assert body.splitlines() == ["cookie_adid,list_id,delete,process_consent", "x1,555,1,"]
    assert set(errors) == {"2", "3"} and n == 1


def test_missing_segment_id_is_a_row_error():
    d = dest(lambda r: httpx.Response(200), list_id="")
    _, errors, n = d.build_file([row(1, "abc")], delete=False)
    assert n == 0 and "segment ID" in errors["1"]


def test_upload_signs_in_with_service_account_and_writes_object():
    seen = {}

    def handler(req):
        if req.url.host == "oauth2.googleapis.com":
            claims = jwt.decode(dict(httpx.QueryParams(req.content.decode()))["assertion"], KEY.public_key(),
                                algorithms=["RS256"], audience="https://oauth2.googleapis.com/token")
            seen["claims"] = claims
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        seen["upload"] = req
        return httpx.Response(200, json={"name": "ok"})

    d = dest(handler)
    assert d.upsert([row(1, "abc")]) == {}
    assert seen["claims"]["iss"] == "uploader@proj.iam.gserviceaccount.com"
    assert "devstorage.read_write" in seen["claims"]["scope"]
    up = seen["upload"]
    assert up.url.path == "/upload/storage/v1/b/gam-bucket/o"
    assert up.headers["authorization"] == "Bearer tok"
    name = up.url.params["name"]
    assert name == "mm/sync-7/run3.csv"
    assert up.content.decode().startswith("ppid,list_id,delete,process_consent\n")


def test_failed_upload_fails_rows_so_they_are_retried():
    def handler(req):
        if req.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "tok"})
        return httpx.Response(403, text="forbidden")

    errors = dest(handler).remove([row(1, "a"), row(2, "b")])
    assert set(errors) == {"1", "2"} and "403" in errors["1"]


def test_connection_test_explains_missing_bucket_permission():
    def handler(req):
        if req.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "tok"})
        return httpx.Response(403, text="denied")

    with pytest.raises(ValueError, match="Storage Object Admin"):
        dest(handler).test()


@pytest.mark.parametrize("raw", ["not json", json.dumps({"type": "authorized_user"}), json.dumps({"type": "service_account"})])
def test_rejects_non_service_account_json(raw):
    with pytest.raises(ValueError):
        parse_service_account(raw)


def segment_handler(seen):
    def handler(req):
        if req.url.host == "oauth2.googleapis.com":
            seen["scope"] = jwt.decode(dict(httpx.QueryParams(req.content.decode()))["assertion"],
                                       options={"verify_signature": False})["scope"]
            return httpx.Response(200, json={"access_token": "tok"})
        seen["req"] = req
        return httpx.Response(200, json={"name": "networks/1234/audienceSegments/98765", "displayName": "Fans", "status": "ACTIVE"})
    return handler


def test_create_segment_calls_ad_manager_api():
    seen = {}
    seg = dest(segment_handler(seen)).create_segment("Fans", 30)
    assert seg == {"id": "98765", "name": "Fans", "status": "ACTIVE"}
    assert seen["scope"] == "https://www.googleapis.com/auth/admanager"
    req = seen["req"]
    assert str(req.url) == "https://admanager.googleapis.com/v1/networks/1234/audienceSegments"
    assert json.loads(req.content) == {"displayName": "Fans", "description": "Created by MediaMint CDP; members are uploaded by its syncs.",
                                       "nonRuleBasedFirstPartyAudienceSegment": {"membershipExpirationDays": "30"}}


@pytest.mark.parametrize("days", [0, 541])
def test_membership_days_range(days):
    with pytest.raises(ValueError, match="540"):
        dest(lambda r: httpx.Response(200)).create_segment("Fans", days)


def test_prepare_creates_segment_only_when_auto_create_is_on():
    seen = {}
    d = dest(segment_handler(seen), list_id="", auto_create="true", segment_name="Engaged fans", membership_days=30)
    created = d.prepare()
    assert created["list_id"] == "98765" and "segment_created_at" in created
    body = json.loads(seen["req"].content)
    assert body["displayName"] == "Engaged fans" and body["nonRuleBasedFirstPartyAudienceSegment"] == {"membershipExpirationDays": "30"}
    assert dest(lambda r: httpx.Response(500), auto_create="true").prepare() == {}  # list_id 555 already set: no API call


def test_list_id_required_when_auto_create_is_off():
    with pytest.raises(ValueError, match="List ID is required"):
        dest(lambda r: httpx.Response(500), list_id="").prepare()
    mapped = dest(lambda r: httpx.Response(500), list_id="")
    mapped.context["mapped_targets"] = ["ppid", "list_id"]
    assert mapped.prepare() == {}


def test_only_one_identifier_type_may_be_mapped():
    d = dest(lambda r: httpx.Response(500))
    d.context["mapped_targets"] = ["ppid", "cookie_adid"]
    with pytest.raises(ValueError, match="one identifier type"):
        d.prepare()


def test_uploads_wait_25_hours_after_segment_creation():
    from datetime import datetime, timedelta, timezone
    recent = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    d = dest(lambda r: httpx.Response(500), segment_created_at=recent)
    errors = d.upsert([row(1, "abc")])
    assert "Segment created recently" in errors["1"]
    old = (datetime.now(timezone.utc) - timedelta(hours=26)).isoformat()
    assert dest(lambda r: httpx.Response(500), segment_created_at=old)._waiting_for_segment() is None


def test_filename_template_variables_and_offset():
    d = dest(lambda r: httpx.Response(200), filename="/up/{YYYY}-{MM}-{DD}-{model.id}-{sync.id}-{sync.run.id}", filename_offset="-86400")
    d.context["model_id"] = 42
    from datetime import datetime, timedelta, timezone
    y = datetime.now(timezone.utc) - timedelta(days=1)
    assert d.filename() == f"up/{y:%Y-%m-%d}-42-7-3.csv"
    d._files = 1
    assert d.filename("remove") == f"up/{y:%Y-%m-%d}-42-7-3-remove-2.csv"


def test_empty_run_writes_header_only_file_unless_skipped():
    names = []

    def handler(req):
        if req.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "tok"})
        names.append((req.url.params["name"], req.content.decode()))
        return httpx.Response(200)
    dest(handler).finish()
    assert names == [("mm/sync-7/run3.csv", "ppid,list_id,delete,process_consent\n")]
    names.clear()
    dest(handler, skip_empty="true").finish()
    assert names == []
