"""The brand switcher (X-Active-Brand) and the Databricks user picker."""
import pytest
from fastapi.testclient import TestClient

from app import config, db, directory


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "switch.sqlite3")
    monkeypatch.setattr(db, "_backend", None)
    monkeypatch.delenv("LAKEBASE_ENDPOINT", raising=False)
    from app import access, main
    monkeypatch.setattr(access, "_groups_for", lambda email: [])
    ts = db.now()
    cnbc = db.insert("brands", {"name": "CNBC", "created_at": ts})
    golf = db.insert("brands", {"name": "GolfNow", "created_at": ts})
    cols = [{"name": "spine_id", "type": "string", "data_type": "string"}]
    p1 = db.insert("models", {"kind": "parent", "name": "CNBC Users", "table_ref": "c.s.cnbc", "primary_key": "spine_id",
                              "columns": cols, "brand_id": cnbc, "created_at": ts})
    p2 = db.insert("models", {"kind": "parent", "name": "Golf Users", "table_ref": "c.s.golf", "primary_key": "spine_id",
                              "columns": cols, "brand_id": golf, "created_at": ts})
    db.insert("destinations", {"name": "Hook A", "type": "webhook", "config": {"url": "https://x"}, "brand_id": cnbc, "created_at": ts})
    db.insert("destinations", {"name": "Hook B", "type": "webhook", "config": {"url": "https://y"}, "brand_id": golf, "created_at": ts})
    grants = [("two@x.com", "viewer", cnbc), ("two@x.com", "brand_admin", golf),   # one person, a different role on each brand
              ("wide@x.com", "builder", None), ("boss@x.com", "platform_admin", None), ("one@x.com", "viewer", cnbc)]
    for who, role, brand in grants:
        db.insert("role_bindings", {"principal_type": "user", "principal": who, "role": role, "brand_id": brand,
                                    "destination_ids": [], "created_at": ts})
    client = TestClient(main.app)

    def call(who, method, path, brand=None, **kw):
        headers = {"X-Dev-User": who, **({"X-Active-Brand": str(brand)} if brand is not None else {})}
        return client.request(method, path, headers=headers, **kw)
    return call, {"cnbc": cnbc, "golf": golf, "p1": p1, "p2": p2}


def names(rows):
    return [r["name"] for r in rows]


def test_switching_brand_changes_data_and_permissions(api):
    call, ids = api
    # no choice yet: lands in the first brand (alphabetical), with that brand's role only
    me = call("two@x.com", "GET", "/api/me").json()
    assert me["active_brand_id"] == ids["cnbc"] and names(me["brands"]) == ["CNBC"]
    assert me["brands"][0]["can"]["view"] and not me["brands"][0]["can"]["audiences.edit"]  # viewer there
    assert names(call("two@x.com", "GET", "/api/parents").json()) == ["CNBC Users"]
    assert names(call("two@x.com", "GET", "/api/destinations").json()) == ["Hook A"]

    # switch to GolfNow: the other brand's data and the other role's permissions
    me = call("two@x.com", "GET", "/api/me", brand=ids["golf"]).json()
    assert me["active_brand_id"] == ids["golf"] and names(me["brands"]) == ["GolfNow"]
    assert me["brands"][0]["can"]["audiences.edit"] and me["brands"][0]["can"]["syncs.approve"]  # brand admin there
    assert names(call("two@x.com", "GET", "/api/parents", brand=ids["golf"]).json()) == ["Golf Users"]
    assert names(call("two@x.com", "GET", "/api/destinations", brand=ids["golf"]).json()) == ["Hook B"]

    # the permissions are enforced, not just displayed
    body = {"name": "Fans", "definition": {"type": "group", "op": "and", "conditions": []}}
    assert call("two@x.com", "POST", "/api/audiences", brand=ids["golf"], json={**body, "parent_id": ids["p2"]}).status_code == 200
    assert call("two@x.com", "POST", "/api/audiences", brand=ids["cnbc"], json={**body, "parent_id": ids["p1"]}).status_code == 403
    # while in GolfNow the CNBC data is out of reach, even by id
    assert call("two@x.com", "GET", f"/api/schema?parent_id={ids['p1']}", brand=ids["golf"]).status_code == 403
    # and a role on another brand doesn't leak in: GolfNow's admin rights don't apply while in CNBC
    assert call("two@x.com", "POST", "/api/audiences", brand=ids["cnbc"], json={**body, "parent_id": ids["p2"]}).status_code == 403


def test_the_full_picture_ignores_the_switch(api):
    call, ids = api
    me = call("two@x.com", "GET", "/api/me", brand=ids["golf"]).json()
    assert [b["name"] for b in me["switch"]["brands"]] == ["CNBC", "GolfNow"] and me["switch"]["all"] is False
    by = {b["name"]: b["can"] for b in me["all_brands_access"]}
    assert not by["CNBC"]["audiences.edit"] and by["GolfNow"]["audiences.edit"]
    assert len(me["roles"]) == 2  # both roles still listed


def test_choices_that_are_not_theirs_are_ignored(api):
    call, ids = api
    assert call("one@x.com", "GET", "/api/me", brand=ids["golf"]).json()["active_brand_id"] == ids["cnbc"]  # no role on GolfNow
    assert call("one@x.com", "GET", "/api/me", brand="all").json()["active_brand_id"] == ids["cnbc"]  # "all" is for admins
    assert call("two@x.com", "GET", "/api/me", brand="99999").json()["active_brand_id"] == ids["cnbc"]
    assert call("two@x.com", "GET", "/api/me", brand="junk").json()["active_brand_id"] == ids["cnbc"]


def test_admins_and_brand_wide_roles_default_to_all_brands_and_can_narrow(api):
    call, ids = api
    for who in ("boss@x.com", "wide@x.com"):
        me = call(who, "GET", "/api/me").json()
        assert me["active_brand_id"] is None and names(me["brands"]) == ["CNBC", "GolfNow"] and me["switch"]["all"] is True
        narrowed = call(who, "GET", "/api/me", brand=ids["golf"]).json()
        assert narrowed["active_brand_id"] == ids["golf"] and names(narrowed["brands"]) == ["GolfNow"]
        assert names(call(who, "GET", "/api/parents", brand=ids["golf"]).json()) == ["Golf Users"]
        assert call(who, "GET", "/api/me", brand="all").json()["active_brand_id"] is None
    # an admin keeps full permissions inside whichever brand they pick
    assert all(call("boss@x.com", "GET", "/api/me", brand=ids["golf"]).json()["brands"][0]["can"].values())
    # brand management isn't narrowed by the switcher
    assert names(call("boss@x.com", "GET", "/api/brands", brand=ids["golf"]).json()) == ["CNBC", "GolfNow"]


# ---- Databricks user picker ------------------------------------------------------------------

def test_directory_lists_databricks_users_and_groups(api, monkeypatch):
    call, ids = api
    directory._cache.clear()
    seen = []

    def fake(path, params):
        seen.append((path, params))
        if path.endswith("/Users"):
            return {"Resources": [{"userName": "Zed@Corp.com", "displayName": "Zed Z", "active": True},
                                  {"userName": "amy@corp.com", "displayName": "Amy A", "active": True},
                                  {"userName": "gone@corp.com", "displayName": "Gone", "active": False}]}
        return {"Resources": [{"displayName": "cnbc-admins"}, {"displayName": "Analysts"}]}
    monkeypatch.setattr(directory, "_get", fake)
    users = call("boss@x.com", "GET", "/api/directory/users?q=a%22b").json()
    assert users == {"items": [{"email": "amy@corp.com", "name": "Amy A"}, {"email": "zed@corp.com", "name": "Zed Z"}], "error": ""}  # active only, sorted
    assert seen[0][1]["filter"] == 'userName co "a b" or displayName co "a b"'  # quotes can't break out of the filter
    assert [g["name"] for g in call("boss@x.com", "GET", "/api/directory/groups").json()["items"]] == ["Analysts", "cnbc-admins"]
    assert call("boss@x.com", "GET", "/api/directory/teams").status_code == 404
    assert call("two@x.com", "GET", "/api/directory/users").status_code == 403  # admins only


def test_directory_failure_reports_instead_of_breaking(api, monkeypatch):
    call, _ = api
    directory._cache.clear()

    def boom(path, params):
        raise RuntimeError("No Databricks workspace is configured")
    monkeypatch.setattr(directory, "_get", boom)
    r = call("boss@x.com", "GET", "/api/directory/users")
    assert r.status_code == 200 and r.json()["items"] == [] and "Couldn't load Databricks users" in r.json()["error"]
