"""Email + password sign-in, admin-managed users, custom roles, multiple roles per person."""
import pytest
from fastapi.testclient import TestClient

from app import access, auth, config, db


@pytest.fixture()
def app_(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "auth.sqlite3")
    monkeypatch.setattr(db, "_backend", None)
    monkeypatch.delenv("LAKEBASE_ENDPOINT", raising=False)
    monkeypatch.setenv("CDP_LOCAL_AUTH", "1")
    monkeypatch.setenv("CDP_ADMIN_EMAIL", "boss@x.com")
    monkeypatch.setenv("CDP_ADMIN_PASSWORD", "correct horse")
    monkeypatch.setattr(auth, "_fails", {})
    from app import main
    monkeypatch.setattr(main.insights, "destination_configured", lambda _id: True)
    auth.seed()
    ts = db.now()
    cnbc = db.insert("brands", {"name": "CNBC", "created_at": ts})
    golf = db.insert("brands", {"name": "GolfNow", "created_at": ts})
    cols = [{"name": "spine_id", "type": "string", "data_type": "string"}]
    for name, brand in (("CNBC Users", cnbc), ("Golf Users", golf)):
        db.insert("models", {"kind": "parent", "name": name, "table_ref": "c.s." + name[:3], "primary_key": "spine_id",
                             "columns": cols, "brand_id": brand, "created_at": ts})
    return TestClient(main.app), {"cnbc": cnbc, "golf": golf}


def sign_in(client, email, password):
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    return r, ({"Authorization": f"Bearer {r.json()['token']}"} if r.status_code == 200 else {})


def make_user(client, admin, email, password="password1", **extra):
    r = client.post("/api/users", headers=admin, json={"email": email, "password": password, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_api_needs_sign_in_but_login_and_config_are_public(app_):
    client, _ = app_
    assert client.get("/api/auth/config").json()["mode"] == "local"
    for path in ("/api/me", "/api/brands", "/api/users"):
        assert client.get(path).status_code == 401
    assert client.get("/api/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/me", headers={"X-Dev-User": "boss@x.com"}).status_code == 401  # personas are off
    assert client.post("/api/inbox", json={"rows": []}).status_code == 200  # demo webhook receiver stays reachable


def test_login_logout_and_wrong_passwords(app_):
    client, _ = app_
    assert sign_in(client, "boss@x.com", "bad")[0].status_code == 401
    assert sign_in(client, "nobody@x.com", "whatever")[0].status_code == 401
    r, h = sign_in(client, "BOSS@x.com ", "correct horse")  # email is case-insensitive
    assert r.status_code == 200 and "password" not in r.text
    me = client.get("/api/me", headers=h).json()
    assert me["email"] == "boss@x.com" and me["platform_admin"] is True and me["auth_mode"] == "local"
    assert client.post("/api/auth/logout", headers=h).status_code == 200
    assert client.get("/api/me", headers=h).status_code == 401


def test_repeated_failures_lock_the_account_briefly(app_):
    client, _ = app_
    for _ in range(auth.MAX_FAILS):
        assert sign_in(client, "boss@x.com", "bad")[0].status_code == 401
    r, _ = sign_in(client, "boss@x.com", "correct horse")
    assert r.status_code == 401 and "Too many" in r.json()["detail"]


def test_admin_has_full_access_to_every_brand(app_):
    client, ids = app_
    _, h = sign_in(client, "boss@x.com", "correct horse")
    me = client.get("/api/me", headers=h).json()
    assert {b["name"] for b in me["brands"]} == {"CNBC", "GolfNow"}
    assert all(all(b["can"].values()) for b in me["brands"]) and all(me["platform"].values())
    assert {p["name"] for p in client.get("/api/parents", headers=h).json()} == {"CNBC Users", "Golf Users"}


def test_only_admins_manage_users_and_new_users_start_with_nothing(app_):
    client, ids = app_
    _, admin = sign_in(client, "boss@x.com", "correct horse")
    made = make_user(client, admin, "Ann@x.com", name="Ann")
    assert made["email"] == "ann@x.com" and made["roles"] == [] and made["is_admin"] is False and "password" not in str(made)
    assert client.post("/api/users", headers=admin, json={"email": "ann@x.com", "password": "password1"}).status_code == 400  # dup
    assert client.post("/api/users", headers=admin, json={"email": "x@x.com", "password": "short"}).status_code == 400
    assert client.post("/api/users", headers=admin, json={"email": "not-an-email", "password": "password1"}).status_code == 400
    _, ann = sign_in(client, "ann@x.com", "password1")
    me = client.get("/api/me", headers=ann).json()
    assert me["platform_admin"] is False and me["roles"] == [] and me["brands"] == []
    assert client.get("/api/parents", headers=ann).json() == []
    for call in (lambda: client.get("/api/users", headers=ann), lambda: client.post("/api/users", headers=ann, json={}),
                 lambda: client.post("/api/roles", headers=ann, json={"label": "X"}),
                 lambda: client.post("/api/brands", headers=ann, json={"name": "X"})):
        assert call().status_code == 403


def test_a_person_can_hold_several_roles_and_sees_them_with_permissions(app_):
    client, ids = app_
    _, admin = sign_in(client, "boss@x.com", "correct horse")
    make_user(client, admin, "multi@x.com")
    for role, brand in (("viewer", ids["cnbc"]), ("builder", ids["golf"]), ("operator", ids["golf"])):
        r = client.post("/api/role-bindings", headers=admin, json={"principal_type": "user", "principal": "multi@x.com",
                                                                    "role": role, "brand_id": brand})
        assert r.status_code == 200, r.text
    _, h = sign_in(client, "multi@x.com", "password1")
    me = client.get("/api/me", headers=h).json()
    assert [(r["label"], r["brand_name"]) for r in me["roles"]] == [
        ("Brand Viewer / Analyst", "CNBC"), ("Brand Audience Builder", "GolfNow"), ("Brand Sync Operator", "GolfNow")]
    assert all("view" in r["permissions"] for r in me["roles"])
    assert [b["name"] for b in me["brands"]] == ["CNBC"]  # working in their first brand until they switch
    by = {b["name"]: b["can"] for b in me["all_brands_access"]}
    assert by["CNBC"]["view"] and not by["CNBC"]["audiences.edit"]
    assert by["GolfNow"]["audiences.edit"] and by["GolfNow"]["syncs.run"]  # permissions from both roles add up
    assert [u for u in client.get("/api/users", headers=admin).json() if u["email"] == "multi@x.com"][0]["roles"].__len__() == 3


def test_custom_roles(app_):
    client, ids = app_
    _, admin = sign_in(client, "boss@x.com", "correct horse")
    r = client.post("/api/roles", headers=admin, json={"label": "Audience reviewer", "description": "Looks and approves",
                                                       "permissions": ["syncs.approve", "audiences.edit"]})
    assert r.status_code == 200, r.text
    role = r.json()
    assert role["custom"] and role["permissions"] == ["audiences.edit", "syncs.approve", "view"]  # 'view' is implied
    assert any(x["role"] == role["role"] for x in client.get("/api/roles", headers=admin).json())
    assert client.post("/api/roles", headers=admin, json={"label": "audience REVIEWER"}).status_code == 400
    assert client.post("/api/roles", headers=admin, json={"label": "brand viewer / analyst"}).status_code == 400  # clashes with a built-in
    assert client.post("/api/roles", headers=admin, json={"label": "Bad", "permissions": ["access.manage"]}).status_code == 400
    make_user(client, admin, "rev@x.com")
    g = client.post("/api/role-bindings", headers=admin, json={"principal_type": "user", "principal": "rev@x.com",
                                                                "role": role["role"], "brand_id": ids["cnbc"]})
    assert g.status_code == 200
    _, h = sign_in(client, "rev@x.com", "password1")
    me = client.get("/api/me", headers=h).json()
    assert me["roles"][0]["label"] == "Audience reviewer"
    can = me["brands"][0]["can"]
    assert can["syncs.approve"] and can["audiences.edit"] and not can["syncs.run"] and not can["destinations.manage"]
    assert client.get("/api/users", headers=h).status_code == 403  # custom roles never carry platform powers
    # edits apply straight away; a role in use can't be deleted
    client.put(f"/api/roles/{role['role']}", headers=admin, json={"permissions": ["syncs.run"]})
    can = client.get("/api/me", headers=h).json()["brands"][0]["can"]
    assert can["syncs.run"] and not can["syncs.approve"]
    assert client.delete(f"/api/roles/{role['role']}", headers=admin).status_code == 400
    client.delete(f"/api/role-bindings/{g.json()['id']}", headers=admin)
    assert client.delete(f"/api/roles/{role['role']}", headers=admin).status_code == 200
    assert client.delete("/api/roles/viewer", headers=admin).status_code == 404  # built-ins are fixed


def test_admin_flag_active_flag_and_last_admin_protection(app_):
    client, ids = app_
    _, admin = sign_in(client, "boss@x.com", "correct horse")
    me_id = [u for u in client.get("/api/users", headers=admin).json() if u["email"] == "boss@x.com"][0]["id"]
    assert client.put(f"/api/users/{me_id}", headers=admin, json={"is_admin": False}).status_code == 400
    assert client.put(f"/api/users/{me_id}", headers=admin, json={"active": False}).status_code == 400
    assert client.delete(f"/api/users/{me_id}", headers=admin).status_code == 400
    u = make_user(client, admin, "two@x.com")
    _, two = sign_in(client, "two@x.com", "password1")
    assert client.get("/api/users", headers=two).status_code == 403
    assert client.put(f"/api/users/{u['id']}", headers=admin, json={"is_admin": True}).json()["is_admin"] is True
    assert client.get("/api/users", headers=two).status_code == 200  # promoted: effective immediately, same session
    assert client.put(f"/api/users/{u['id']}", headers=admin, json={"active": False}).json()["active"] is False
    assert client.get("/api/me", headers=two).status_code == 401  # switched off: session ends
    assert sign_in(client, "two@x.com", "password1")[0].status_code == 401


def test_password_change_and_reset_end_old_sessions(app_):
    client, _ = app_
    _, admin = sign_in(client, "boss@x.com", "correct horse")
    u = make_user(client, admin, "pw@x.com")
    _, a = sign_in(client, "pw@x.com", "password1")
    _, b = sign_in(client, "pw@x.com", "password1")
    assert client.post("/api/auth/change-password", headers=a, json={"current": "wrong", "new": "newpassword"}).status_code == 400
    assert client.post("/api/auth/change-password", headers=a, json={"current": "password1", "new": "short"}).status_code == 400
    assert client.post("/api/auth/change-password", headers=a, json={"current": "password1", "new": "newpassword"}).status_code == 200
    assert client.get("/api/me", headers=a).status_code == 200 and client.get("/api/me", headers=b).status_code == 401
    assert sign_in(client, "pw@x.com", "password1")[0].status_code == 401
    assert client.put(f"/api/users/{u['id']}", headers=admin, json={"password": "adminreset1"}).status_code == 200
    assert client.get("/api/me", headers=a).status_code == 401
    assert sign_in(client, "pw@x.com", "adminreset1")[0].status_code == 200


def test_deleting_a_user_removes_their_grants(app_):
    client, ids = app_
    _, admin = sign_in(client, "boss@x.com", "correct horse")
    u = make_user(client, admin, "gone@x.com")
    client.post("/api/role-bindings", headers=admin, json={"principal_type": "user", "principal": "gone@x.com", "role": "viewer", "brand_id": ids["cnbc"]})
    assert client.delete(f"/api/users/{u['id']}", headers=admin).status_code == 200
    assert db.query("SELECT id FROM role_bindings WHERE principal = 'gone@x.com'") == []
    again = make_user(client, admin, "gone@x.com")  # a new account on the same email starts clean
    assert again["roles"] == []


def test_passwords_are_hashed_and_sessions_store_only_digests(app_):
    client, _ = app_
    _, h = sign_in(client, "boss@x.com", "correct horse")
    row = db.one("SELECT * FROM users WHERE email = 'boss@x.com'")
    assert "correct horse" not in row["password_hash"] and row["password_hash"].startswith("scrypt$")
    token = h["Authorization"].split()[1]
    assert db.one("SELECT id FROM sessions WHERE token_hash = ?", (token,)) is None
    assert db.one("SELECT id FROM sessions WHERE token_hash = ?", (auth._digest(token),))
    db.execute("UPDATE sessions SET expires_at = '2000-01-01T00:00:00+00:00'")
    assert client.get("/api/me", headers=h).status_code == 401  # expired


def test_databricks_app_ignores_local_users(app_, monkeypatch):
    client, _ = app_
    monkeypatch.setattr(access, "IN_DATABRICKS_APP", True)
    monkeypatch.setenv("DATABRICKS_APP_NAME", "cdp")
    assert client.get("/api/auth/config").json()["mode"] == "databricks"
    assert client.post("/api/auth/login", json={"email": "boss@x.com", "password": "correct horse"}).status_code == 400
    assert client.get("/api/me").status_code == 401  # needs the Databricks proxy headers
