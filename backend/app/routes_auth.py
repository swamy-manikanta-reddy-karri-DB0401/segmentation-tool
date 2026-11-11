"""Sign-in, user management and custom roles."""
from __future__ import annotations

import re

from fastapi import APIRouter, Body, HTTPException, Request

from . import access, auth, db, directory

router = APIRouter(prefix="/api")


@router.get("/directory/{kind}")
def directory_search(kind: str, q: str = "", limit: int = 50):
    """Databricks users or groups (for the "who" picker when granting a role)."""
    access.require("access.manage")
    if kind not in ("users", "groups"):
        raise HTTPException(404, "Look up users or groups")
    return directory.search(kind, q, limit)


def _mode() -> str:
    return "databricks" if access.IN_DATABRICKS_APP else "local" if auth.local_enabled() else "open"


def _local_only() -> None:
    if not auth.local_enabled():
        raise HTTPException(400, "People are managed in Databricks, not here" if access.IN_DATABRICKS_APP
                            else "Sign-in is switched off (CDP_LOCAL_AUTH=0)")


# ---- sign in -----------------------------------------------------------------------------------

@router.get("/auth/config")
def auth_config():
    return {"mode": _mode(), "min_password": auth.MIN_PASSWORD}


@router.post("/auth/login")
def login(body: dict = Body(...)):
    _local_only()
    try:
        token, user = auth.login(body.get("email") or "", body.get("password") or "")
    except PermissionError as e:
        raise HTTPException(401, str(e)) from None
    return {"token": token, "expires_in_hours": auth.SESSION_HOURS, "user": {"email": user["email"], "name": user["name"]}}


@router.post("/auth/logout")
def logout(request: Request):
    auth.logout(access.bearer(request.headers))
    return {"ok": True}


@router.post("/auth/change-password")
def change_password(request: Request, body: dict = Body(...)):
    _local_only()
    row = db.one("SELECT * FROM users WHERE email = ?", (access.current().email,))
    if not row or not auth.verify_password(body.get("current") or "", row["password_hash"]):
        raise ValueError("Your current password isn't right")
    new = auth.check_new_password(body.get("new") or "")
    if auth.verify_password(new, row["password_hash"]):
        raise ValueError("Choose a password you haven't used for this account")
    db.update("users", row["id"], {"password_hash": auth.hash_password(new)})
    auth.end_sessions(row["id"], except_token=access.bearer(request.headers))  # sign out everywhere else
    return {"ok": True}


# ---- users (admins) ------------------------------------------------------------------------------

def _user_out(u: dict, bindings: list[dict], brands: dict[int, str], custom: dict) -> dict:
    mine = [b for b in bindings if b["principal_type"] == "user" and b["principal"].lower() == u["email"]]
    return {"id": u["id"], "email": u["email"], "name": u["name"], "is_admin": bool(u["is_admin"]), "active": bool(u["active"]),
            "created_at": u["created_at"], "created_by": u["created_by"], "last_login_at": u["last_login_at"],
            "roles": [{"id": b["id"], "role": b["role"], "label": access.role_label(b["role"], custom), "brand_id": b["brand_id"],
                       "brand_name": brands.get(b["brand_id"]) if b["brand_id"] is not None else None} for b in mine]}


def _users_out() -> list[dict]:
    bindings = db.query("SELECT * FROM role_bindings")
    brands = {b["id"]: b["name"] for b in db.query("SELECT id, name FROM brands")}
    custom = access.custom_roles()
    return [_user_out(u, bindings, brands, custom) for u in db.query("SELECT * FROM users ORDER BY lower(email)")]


def _user(user_id: int) -> dict:
    row = db.one("SELECT * FROM users WHERE id = ?", (user_id,))
    if not row:
        raise HTTPException(404, f"User {user_id} not found")
    return row


def _other_active_admins(user_id: int) -> int:
    return db.one("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND active = 1 AND id != ?", (user_id,))["n"]


@router.get("/users")
def list_users():
    access.require("access.manage")
    return _users_out()


@router.post("/users")
def create_user(body: dict = Body(...)):
    access.require("access.manage")
    _local_only()
    email = auth.clean_email(body.get("email"))
    if db.one("SELECT id FROM users WHERE email = ?", (email,)):
        raise ValueError(f"{email} already has an account")
    name = (body.get("name") or "").strip() or email.split("@")[0]
    uid = db.insert("users", {"email": email, "name": name, "password_hash": auth.hash_password(auth.check_new_password(body.get("password") or "")),
                              "is_admin": bool(body.get("is_admin")), "active": 1,
                              "created_by": access.current().email, "created_at": db.now()})
    access.audit("create", "user", uid, None, name=email, admin=bool(body.get("is_admin")))
    return next(u for u in _users_out() if u["id"] == uid)


@router.put("/users/{user_id}")
def update_user(user_id: int, body: dict = Body(...)):
    access.require("access.manage")
    _local_only()
    row = _user(user_id)
    me = access.current().email
    values: dict = {}
    if "name" in body:
        values["name"] = (body["name"] or "").strip() or row["email"].split("@")[0]
    if "is_admin" in body and bool(body["is_admin"]) != bool(row["is_admin"]):
        if not body["is_admin"] and (row["email"] == me or not _other_active_admins(user_id)):
            raise ValueError("You can't remove your own admin access, and at least one other admin must remain")
        values["is_admin"] = bool(body["is_admin"])
    if "active" in body and bool(body["active"]) != bool(row["active"]):
        if not body["active"] and (row["email"] == me or (row["is_admin"] and not _other_active_admins(user_id))):
            raise ValueError("You can't switch off your own account or the last active admin")
        values["active"] = bool(body["active"])
    if body.get("password"):
        values["password_hash"] = auth.hash_password(auth.check_new_password(body["password"]))
    if values:
        db.update("users", user_id, values)
        if "password_hash" in values or values.get("active") is False:
            auth.end_sessions(user_id)
        changed = [k for k in values if k != "password_hash"] + (["password reset"] if "password_hash" in values else [])
        access.audit("update", "user", user_id, None, name=row["email"], changed=", ".join(changed))
    return next(u for u in _users_out() if u["id"] == user_id)


@router.delete("/users/{user_id}")
def delete_user(user_id: int):
    access.require("access.manage")
    _local_only()
    row = _user(user_id)
    if row["email"] == access.current().email:
        raise ValueError("You can't delete your own account")
    if row["is_admin"] and row["active"] and not _other_active_admins(user_id):
        raise ValueError("You can't delete the last active admin")
    # their grants go with them, so a new account on the same email doesn't inherit old access
    db.execute("DELETE FROM role_bindings WHERE principal_type = 'user' AND lower(principal) = ?", (row["email"],))
    db.delete("users", user_id)
    access.audit("delete", "user", user_id, None, name=row["email"])
    return {"ok": True}


# ---- custom roles (admins) ---------------------------------------------------------------------------

def _clean_role(body: dict) -> dict:
    label = (body.get("label") or "").strip()
    if not label:
        raise ValueError("Give the role a name")
    perms = {str(p) for p in body.get("permissions") or []}
    unknown = perms - access.ALL_BRAND_PERMS
    if unknown:
        raise ValueError(f"Unknown permission: {', '.join(sorted(unknown))}")
    return {"label": label, "description": (body.get("description") or "").strip(), "permissions": sorted(perms | {"view"})}


def _label_taken(label: str, except_key: str | None = None) -> bool:
    low = label.lower()
    return (any(v["label"].lower() == low for v in access.ROLES.values())
            or any(r["label"].lower() == low and r["key"] != except_key for r in access.custom_roles().values()))


@router.post("/roles")
def create_role(body: dict = Body(...)):
    access.require("access.manage")
    values = _clean_role(body)
    if _label_taken(values["label"]):
        raise ValueError(f"A role called {values['label']} already exists")
    base = "custom_" + (re.sub(r"[^a-z0-9]+", "_", values["label"].lower()).strip("_") or "role")
    key, n = base, 2
    while db.one("SELECT id FROM custom_roles WHERE key = ?", (key,)):
        key, n = f"{base}_{n}", n + 1
    db.insert("custom_roles", {"key": key, **values, "created_by": access.current().email, "created_at": db.now()})
    access.audit("create", "role", None, None, name=values["label"], permissions=", ".join(values["permissions"]))
    return next(r for r in access.all_roles() if r["role"] == key)


def _custom(key: str) -> dict:
    row = db.one("SELECT * FROM custom_roles WHERE key = ?", (key,))
    if not row:
        raise HTTPException(404, "Custom role not found (built-in roles can't be changed)")
    return row


@router.put("/roles/{key}")
def update_role(key: str, body: dict = Body(...)):
    access.require("access.manage")
    row = _custom(key)
    values = _clean_role({"label": row["label"], "description": row["description"], "permissions": row["permissions"], **body})
    if _label_taken(values["label"], key):
        raise ValueError(f"A role called {values['label']} already exists")
    db.update("custom_roles", row["id"], values)
    access.audit("update", "role", row["id"], None, name=values["label"], permissions=", ".join(values["permissions"]))
    return next(r for r in access.all_roles() if r["role"] == key)


@router.delete("/roles/{key}")
def delete_role(key: str):
    access.require("access.manage")
    row = _custom(key)
    used = db.one("SELECT COUNT(*) AS n FROM role_bindings WHERE role = ?", (key,))["n"]
    if used:
        raise ValueError(f"{used} grant{'s' if used != 1 else ''} still use {row['label']}. Revoke {'them' if used != 1 else 'it'} first.")
    db.delete("custom_roles", row["id"])
    access.audit("delete", "role", row["id"], None, name=row["label"])
    return {"ok": True}
