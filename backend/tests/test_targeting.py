"""Ad Manager key-value targeting: membership store, destination behaviour, lookup API access."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import config, db, targeting
from app.destinations.gam_kv import GamKeyValues


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.sqlite3")
    monkeypatch.setattr(db, "_backend", None)
    monkeypatch.delenv("LAKEBASE_ENDPOINT", raising=False)
    db.conn()


def rows(*ids):
    return [{"id": f"r{i}", "match": None, "fields": {"user_id": uid}} for i, uid in enumerate(ids)]


def test_slug_and_validation():
    assert targeting.slug("Engaged non-subscribers (video)") == "engaged_non_subscribers_video"
    assert len(targeting.slug("x" * 80)) == 40
    with pytest.raises(ValueError):
        targeting.validate_key("way_too_long_key")
    with pytest.raises(ValueError):
        targeting.validate_value("Has Spaces")


def test_destination_adds_and_removes_members(store):
    d = GamKeyValues({"key": "mm_aud"}, {"sync_id": 7, "audience_name": "Engaged fans", "options": {}})
    assert d.upsert(rows("u1", "u2", "")) == {"r2": "No visitor ID value"}
    d2 = GamKeyValues({"key": "mm_aud"}, {"sync_id": 8, "audience_name": "Lapsed", "options": {"value": "lapsed_90d"}})
    d2.upsert(rows("u1"))
    assert targeting.lookup(["u1", "u2", "nobody"]) == {"u1": {"mm_aud": ["engaged_fans", "lapsed_90d"]}, "u2": {"mm_aud": ["engaged_fans"]}, "nobody": {}}
    d.remove(rows("u1"))
    assert targeting.lookup(["u1"])["u1"] == {"mm_aud": ["lapsed_90d"]}
    d.upsert(rows("u2"))  # re-adding is idempotent
    assert [s["members"] for s in targeting.stats("mm_aud")] == [1, 1]
    targeting.clear_sync(8)
    assert targeting.lookup(["u1"])["u1"] == {}


def test_default_delete_behaviour_is_remove():
    from app import sync_engine
    cfg = sync_engine.normalize_config({"sync_type": "membership"}, GamKeyValues)
    assert cfg["delete_behavior"] == "remove"


def test_prepare_creates_key_and_value_in_ad_manager():
    calls = []

    def handler(req):
        if req.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "tok"})
        calls.append((req.method, req.url.path, json.loads(req.content) if req.content else None))
        if req.method == "GET" and req.url.path.endswith("customTargetingKeys"):
            return httpx.Response(200, json={"customTargetingKeys": [{"adTagName": "other", "name": "networks/1/customTargetingKeys/9"}]})
        if req.method == "POST" and req.url.path.endswith("customTargetingKeys"):
            return httpx.Response(200, json={"name": "networks/1/customTargetingKeys/55", "adTagName": "mm_aud"})
        if req.method == "GET":
            return httpx.Response(200, json={"customTargetingValues": []})
        return httpx.Response(200, json={"name": "networks/1/customTargetingValues/77"})

    from tests.test_gam import SA
    d = GamKeyValues({"key": "mm_aud", "network_code": "1", "service_account_json": SA},
                     {"sync_id": 3, "audience_name": "Engaged fans", "options": {}})
    d.http = httpx.Client(transport=httpx.MockTransport(handler))
    assert d.prepare() == {}
    posts = [c for c in calls if c[0] == "POST"]
    assert posts[0][2] == {"adTagName": "mm_aud", "displayName": "MediaMint CDP audiences", "type": "PREDEFINED", "reportableType": "OFF"}
    assert posts[1][2]["customTargetingKey"] == "networks/1/customTargetingKeys/55" and posts[1][2]["adTagName"] == "engaged_fans"


def test_prepare_never_fails_the_run():
    d = GamKeyValues({"key": "mm_aud", "network_code": "1", "service_account_json": "{bad"}, {"options": {}})
    assert d.prepare() == {}


def test_lookup_api_requires_an_allowed_identity(store, monkeypatch):
    from app import access, main
    monkeypatch.setattr(access, "_groups_for", lambda email, *a: [])
    targeting.add("mm_aud", "fans", 1, ["u1"])
    c = TestClient(main.app)
    denied = c.get("/api/targeting", params={"user_id": "u1"}, headers={"X-Dev-User": "site-server@x.com"})
    assert denied.status_code == 403
    assert db.get_setting("targeting_last_denied")["identity"] == "site-server@x.com"
    targeting.set_clients(["Site-Server@x.com"])
    ok = c.get("/api/targeting", params={"user_id": "u1"}, headers={"X-Dev-User": "site-server@x.com"})
    assert ok.status_code == 200 and ok.json() == {"user_id": "u1", "targeting": {"mm_aud": ["fans"]}}
    assert ok.headers["cache-control"] == "private, max-age=60"
    many = c.post("/api/targeting/lookup", json={"user_ids": ["u1", "u2"]}, headers={"X-Dev-User": "site-server@x.com"})
    assert many.json() == {"visitors": {"u1": {"mm_aud": ["fans"]}, "u2": {}}}
