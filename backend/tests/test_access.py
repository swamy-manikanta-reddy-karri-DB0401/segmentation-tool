"""Brands, roles and maker-checker, exercised through the API as different personas (local dev mode)."""
import pytest
from fastapi.testclient import TestClient

from app import config, db


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.sqlite3")
    monkeypatch.setattr(db, "_backend", None)
    monkeypatch.delenv("LAKEBASE_ENDPOINT", raising=False)
    from app import access, main
    monkeypatch.setattr(access, "_groups_for", lambda email: [])
    monkeypatch.setattr(main.insights, "destination_configured", lambda _id: True)
    ts = db.now()
    cnbc = db.insert("brands", {"name": "CNBC", "created_at": ts})
    golf = db.insert("brands", {"name": "GolfNow", "created_at": ts})
    cols = [{"name": "spine_id", "type": "string", "data_type": "string"}, {"name": "email", "type": "string", "data_type": "string"}]
    p1 = db.insert("models", {"kind": "parent", "name": "CNBC User Profile", "table_ref": "c.s.cnbc", "primary_key": "spine_id",
                              "columns": cols, "brand_id": cnbc, "created_at": ts})
    p2 = db.insert("models", {"kind": "parent", "name": "GolfNow Users", "table_ref": "c.s.golf", "primary_key": "spine_id",
                              "columns": cols, "brand_id": golf, "created_at": ts})
    d1 = db.insert("destinations", {"name": "Webhook A", "type": "webhook", "config": {"url": "https://x"}, "brand_id": cnbc, "created_at": ts})
    d2 = db.insert("destinations", {"name": "Webhook B", "type": "webhook", "config": {"url": "https://y"}, "brand_id": cnbc, "created_at": ts})
    grants = [("admin@x.com", "brand_admin", cnbc, []), ("maker@x.com", "builder", cnbc, []),
              ("ops@x.com", "operator", cnbc, [d1]), ("viewer@x.com", "viewer", cnbc, []), ("golf@x.com", "brand_admin", golf, [])]
    for who, role, brand, dests in grants:
        db.insert("role_bindings", {"principal_type": "user", "principal": who, "role": role, "brand_id": brand,
                                    "destination_ids": dests, "created_at": ts})
    client = TestClient(main.app)
    ids = {"cnbc": cnbc, "golf": golf, "p1": p1, "p2": p2, "d1": d1, "d2": d2}

    def call(who, method, path, **kw):
        return client.request(method, path, headers={"X-Dev-User": who}, **kw)
    return call, ids


def new_audience(call, who, pid):
    return call(who, "POST", "/api/audiences", json={"name": "Fans", "parent_id": pid,
                                                      "definition": {"type": "group", "op": "and", "conditions": []}})


def new_sync(call, who, aid, did):
    return call(who, "POST", "/api/syncs", json={"name": "Fans → hook", "audience_id": aid, "destination_id": did,
                                                  "config": {"mapping": [{"source": "email", "target": "email"}]},
                                                  "schedule": {"type": "manual"}})


def test_brand_scoping_hides_other_brands(api):
    call, ids = api
    assert [p["name"] for p in call("viewer@x.com", "GET", "/api/parents").json()] == ["CNBC User Profile"]
    assert {d["name"] for d in call("viewer@x.com", "GET", "/api/destinations").json()} == {"Webhook A", "Webhook B"}
    assert call("golf@x.com", "GET", "/api/destinations").json() == []
    assert call("golf@x.com", "GET", f"/api/schema?parent_id={ids['p1']}").status_code == 403


def test_platform_only_actions(api):
    call, ids = api
    for who in ("admin@x.com", "maker@x.com"):
        assert call(who, "POST", "/api/connections/test", json={}).status_code == 403
        assert call(who, "DELETE", f"/api/models/{ids['p1']}").status_code == 403
        assert call(who, "POST", "/api/brands", json={"name": "Z"}).status_code == 403
    assert call("you@local.dev", "POST", "/api/brands", json={"name": "Fandango"}).status_code == 403  # persona, not admin
    me = call("viewer@x.com", "GET", "/api/me").json()
    assert me["platform_admin"] is False and me["brands"][0]["can"]["view"] and not me["brands"][0]["can"]["audiences.edit"]


def test_viewer_and_operator_cannot_build(api):
    call, ids = api
    assert new_audience(call, "viewer@x.com", ids["p1"]).status_code == 403
    assert new_audience(call, "ops@x.com", ids["p1"]).status_code == 403
    assert new_audience(call, "golf@x.com", ids["p1"]).status_code == 403


def test_maker_checker_flow(api):
    call, ids = api
    aid = new_audience(call, "maker@x.com", ids["p1"]).json()["id"]
    s = new_sync(call, "maker@x.com", aid, ids["d1"]).json()
    assert s["approval_status"] == "pending" and s["submitted_by"] == "maker@x.com"
    sid = s["id"]
    # nobody can run a pending sync, and the builder can't approve their own work
    assert call("admin@x.com", "POST", f"/api/syncs/{sid}/run", json={}).status_code == 400
    assert call("maker@x.com", "POST", f"/api/syncs/{sid}/approve", json={}).status_code == 403
    assert call("admin@x.com", "POST", f"/api/syncs/{sid}/reject", json={}).status_code == 400  # needs a reason
    assert call("admin@x.com", "POST", f"/api/syncs/{sid}/reject", json={"note": "map first name too"}).json()["approval_status"] == "rejected"
    # builder fixes it -> pending again -> admin approves
    assert call("maker@x.com", "PUT", f"/api/syncs/{sid}", json={"name": "Fans v2"}).json()["approval_status"] == "pending"
    approved = call("admin@x.com", "POST", f"/api/syncs/{sid}/approve", json={"note": "ok"}).json()
    assert approved["approval_status"] == "approved" and approved["approved_by"] == "admin@x.com"
    # a builder's later edit sends it back for approval
    assert call("maker@x.com", "PUT", f"/api/syncs/{sid}", json={"name": "Fans v3"}).json()["approval_status"] == "pending"
    log = [(r["actor"], r["action"]) for r in call("admin@x.com", "GET", "/api/audit").json()]
    assert ("admin@x.com", "approve") in log and ("admin@x.com", "reject") in log and ("maker@x.com", "create") in log


def test_admin_publishes_directly_and_operator_scope(api, monkeypatch):
    call, ids = api
    from app import main
    monkeypatch.setattr(main.sync_engine, "start_run", lambda *a, **k: 99)
    aid = new_audience(call, "admin@x.com", ids["p1"]).json()["id"]
    s1 = new_sync(call, "admin@x.com", aid, ids["d1"]).json()
    s2 = new_sync(call, "admin@x.com", aid, ids["d2"]).json()
    assert s1["approval_status"] == "approved"
    assert call("ops@x.com", "POST", f"/api/syncs/{s1['id']}/run", json={}).json() == {"run_id": 99}
    assert call("ops@x.com", "POST", f"/api/syncs/{s2['id']}/run", json={}).status_code == 403  # not their destination
    assert call("ops@x.com", "PUT", f"/api/syncs/{s1['id']}", json={"name": "x"}).status_code == 403
    assert call("ops@x.com", "PUT", f"/api/syncs/{s1['id']}", json={"enabled": False}).status_code == 200  # may pause
    assert call("viewer@x.com", "POST", f"/api/syncs/{s1['id']}/run", json={}).status_code == 403


def test_syncs_cannot_cross_brands(api):
    call, ids = api
    db.insert("role_bindings", {"principal_type": "user", "principal": "both@x.com", "role": "brand_admin", "brand_id": None,
                                "destination_ids": [], "created_at": db.now()})
    aid = new_audience(call, "both@x.com", ids["p2"]).json()["id"]
    r = new_sync(call, "both@x.com", aid, ids["d1"])
    assert r.status_code == 400 and "another brand" in r.json()["detail"], r.text
