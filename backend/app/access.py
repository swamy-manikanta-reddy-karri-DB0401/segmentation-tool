"""Who is calling, and what they may do.

Identity
* Deployed as a Databricks App: the user's identity arrives in the X-Forwarded-Email / X-Forwarded-User
  headers added by the Databricks Apps proxy. Their Databricks groups are looked up (cached) so roles can be
  granted to groups, the way workspace admins already manage access.
* Anywhere else: people sign in with email and password (auth.py). The first user is an admin; admins have
  full access to every brand and manage users and roles. With CDP_LOCAL_AUTH=0 sign-in is off and the
  X-Dev-User header picks a test persona; without it you are a Platform Admin.

Roles (per brand, granted to a user or a Databricks group). A person can hold several; their permissions add up.
Admins can also define custom roles: any mix of the brand permissions below.
* platform_admin  everything, incl. Databricks sources and the data model (schema)
* brand_admin     audiences, traits, destinations, governance; approves and runs syncs
* builder         audiences and sync drafts; syncs go live only after an admin approves them
* operator        runs approved syncs (optionally only to specific destinations)
* viewer          view and explore only

Maker-checker: a sync created or changed by someone who can't approve it waits in "pending" and is not
scheduled or runnable until a brand admin approves it.
"""
from __future__ import annotations

import os
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass, field

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool

from . import auth, db

ROLES = {
    "platform_admin": {"label": "Platform Admin",
                       "description": "Everything, including Databricks sources, the data model and access control."},
    "brand_admin": {"label": "Brand Marketing Admin",
                    "description": "Builds audiences and traits, manages destinations, approves and runs syncs."},
    "builder": {"label": "Brand Audience Builder",
                "description": "Builds audiences and drafts syncs; syncs go live only after an admin approves them."},
    "operator": {"label": "Brand Sync Operator",
                 "description": "Runs approved syncs (optionally only to specific destinations); can't change them."},
    "viewer": {"label": "Brand Viewer / Analyst", "description": "Explores customer data; can't build, change or send anything."},
}
BRAND_PERMS = {
    "brand_admin": {"view", "audiences.edit", "traits.manage", "syncs.edit", "syncs.approve", "syncs.run",
                    "destinations.manage", "governance.manage"},
    "builder": {"view", "audiences.edit", "syncs.edit"},
    "operator": {"view", "syncs.run"},
    "viewer": {"view"},
}
PLATFORM_PERMS = {"source.manage", "schema.manage", "settings.manage", "access.manage"}
ALL_BRAND_PERMS = set().union(*BRAND_PERMS.values())

IN_DATABRICKS_APP = bool(os.environ.get("DATABRICKS_APP_NAME"))


@dataclass
class Binding:
    role: str
    brand_id: int | None
    destination_ids: list[int] = field(default_factory=list)
    perms: set[str] = field(default_factory=set)  # what this role grants (built-in or custom)
    label: str = ""


@dataclass
class User:
    email: str
    name: str = ""
    groups: list[str] = field(default_factory=list)
    bindings: list[Binding] = field(default_factory=list)
    platform_admin: bool = False
    system: bool = False  # scheduler / background work
    # The brand the person has switched to. While set, they see only that brand's data and only the
    # permissions their roles give them on it. None = every brand they can see (admins, brand-wide roles).
    active_brand: int | None = None

    def can(self, perm: str, brand_id: int | None = None, destination_id: int | None = None) -> bool:
        if self.system or self.platform_admin:
            return True
        if perm in PLATFORM_PERMS:
            return False
        for b in self.bindings:
            if perm not in b.perms:
                continue
            if self.active_brand is not None and b.brand_id not in (None, self.active_brand):
                continue  # a role on another brand doesn't count while working in this one
            if b.brand_id is not None and brand_id is not None and b.brand_id != brand_id:
                continue
            if b.brand_id is not None and brand_id is None and perm != "view":
                continue  # shared (brand-less) objects can only be changed by platform admins
            if perm == "syncs.run" and b.destination_ids and destination_id not in b.destination_ids:
                continue
            return True
        return False

    def _brands(self, perm: str) -> set[int] | None:
        if self.system or self.platform_admin:
            return None
        out: set[int] = set()
        for b in self.bindings:
            if perm in b.perms:
                if b.brand_id is None:
                    return None
                out.add(b.brand_id)
        return out

    def brands(self, perm: str = "view") -> set[int] | None:
        """Brand IDs where the user has `perm` (within the active brand, if one is chosen); None means every brand."""
        out = self._brands(perm)
        if self.active_brand is None or self.system:
            return out
        return {self.active_brand} if out is None or self.active_brand in out else set()

    def all_brands(self, perm: str = "view") -> set[int] | None:
        """Like brands(), ignoring the active brand: everything they could switch to."""
        return self._brands(perm)

    def sees(self, brand_id: int | None) -> bool:
        allowed = self.brands("view")
        return allowed is None or brand_id is None or brand_id in allowed


SYSTEM = User(email="system", name="Scheduler", system=True)
ANON = User(email="anonymous", name="Anonymous")  # no roles: for the few endpoints that need no sign-in
_user: ContextVar[User] = ContextVar("user", default=SYSTEM)


def current() -> User:
    return _user.get()


# ---- identity ----------------------------------------------------------------------------

_group_cache: dict[str, tuple[list[str], float]] = {}
_group_lock = threading.Lock()


def _host() -> str:
    h = os.environ.get("DATABRICKS_HOST", "").rstrip("/")
    return h if not h or h.startswith("http") else "https://" + h


def _groups_from_user_token(token: str) -> list[str]:
    """The signed-in person's own groups, read with their forwarded token (Databricks Apps user
    authorization, identity-only scope). The app's service principal can't see other users' groups."""
    import httpx
    r = httpx.get(f"{_host()}/api/2.0/preview/scim/v2/Me", headers={"Authorization": f"Bearer {token}"}, timeout=15)
    r.raise_for_status()
    return [g["display"] for g in r.json().get("groups", []) if g.get("display")]


def _groups_for(email: str, user_token: str | None = None) -> list[str]:
    """Databricks workspace groups of a user (cached for 5 minutes). Empty if the lookup isn't possible."""
    with _group_lock:
        hit = _group_cache.get(email)
        if hit and hit[1] > time.time():
            return hit[0]
    groups: list[str] = []
    if user_token:
        try:
            groups = _groups_from_user_token(user_token)
            _note_lookup("user token", email, groups, "")
        except Exception as e:  # noqa: BLE001
            _note_lookup("user token", email, [], f"{type(e).__name__}: {str(e)[:200]}")
        with _group_lock:
            _group_cache[email] = (groups, time.time() + 300)
        return groups
    try:
        from databricks.sdk import WorkspaceClient
        w = WorkspaceClient() if IN_DATABRICKS_APP else _local_client()
        if w:
            for u in w.users.list(filter=f'userName eq "{email}"', attributes="groups"):
                groups = [g.display for g in (u.groups or []) if g.display]
    except Exception:  # noqa: BLE001 — no group lookup means direct user grants only
        groups = []
    with _group_lock:
        _group_cache[email] = (groups, time.time() + 300)
    return groups


def check_group_lookup() -> dict:
    """Self-test: can this app read a user's Databricks groups? Looks up the first configured Platform Admin
    with the same identity real requests use, and stores the outcome in the setting `group_lookup`."""
    email = next((x for x in sorted(_platform_admin_names()) if "@" in x), "")
    result: dict = {"at": db.now(), "email": email, "identity": "app service principal" if IN_DATABRICKS_APP else "local token"}
    try:
        from databricks.sdk import WorkspaceClient
        w = WorkspaceClient() if IN_DATABRICKS_APP else _local_client()
        if not w or not email:
            raise ValueError("No Databricks client or no Platform Admin email to look up")
        users = list(w.users.list(filter=f'userName eq "{email}"', attributes="groups"))
        groups = [g.display for u in users for g in (u.groups or []) if g.display]
        result.update(ok=bool(groups), users_found=len(users), groups=groups,
                      error="" if groups else ("User visible but no groups returned" if users else "User not visible"))
        try:  # alternative: list groups with members and look for the user
            uid = users[0].id if users else None
            listed = [g.display_name for g in w.groups.list(attributes="displayName,members")
                      if uid and any(m.value == uid for m in (g.members or []))]
            result["groups_via_group_listing"] = listed
        except Exception as e:  # noqa: BLE001
            result["groups_via_group_listing_error"] = f"{type(e).__name__}: {str(e)[:200]}"
    except Exception as e:  # noqa: BLE001
        result.update(ok=False, users_found=0, groups=[], error=f"{type(e).__name__}: {str(e)[:300]}")
    db.set_setting("group_lookup", result)
    return result


def _local_client():
    from databricks.sdk import WorkspaceClient
    from . import config
    if config.DATABRICKS_HOST and config.DATABRICKS_TOKEN:
        return WorkspaceClient(host=config.DATABRICKS_HOST, token=config.DATABRICKS_TOKEN)
    return None


def _platform_admin_names() -> set[str]:
    raw = os.environ.get("CDP_PLATFORM_ADMINS", "" if IN_DATABRICKS_APP else "")
    return {x.strip().lower() for x in raw.split(",") if x.strip()}


_noted: set[str] = set()


def _note_lookup(method: str, email: str, groups: list[str], error: str) -> None:
    """Record how group lookup went for the first request of each person per app start (diagnostics)."""
    if email in _noted:
        return
    _noted.add(email)
    seen = db.get_setting("group_lookup_requests") or {}
    seen[email] = {"at": db.now(), "method": method, "groups": groups, "error": error}
    db.set_setting("group_lookup_requests", dict(list(seen.items())[-20:]))


def custom_roles() -> dict[str, dict]:
    """Roles an admin defined, by key."""
    return {r["key"]: r for r in db.query("SELECT * FROM custom_roles ORDER BY label")}


def role_perms(role: str, custom: dict[str, dict] | None = None) -> set[str]:
    if role in BRAND_PERMS:
        return set(BRAND_PERMS[role])
    c = (custom if custom is not None else custom_roles()).get(role)
    return set(c["permissions"]) & ALL_BRAND_PERMS if c else set()


def role_label(role: str, custom: dict[str, dict] | None = None) -> str:
    if role in ROLES:
        return ROLES[role]["label"]
    c = (custom if custom is not None else custom_roles()).get(role)
    return c["label"] if c else role


def role_exists(role: str) -> bool:
    return role in ROLES or bool(db.one("SELECT id FROM custom_roles WHERE key = ?", (role,)))


def all_roles() -> list[dict]:
    """Built-in roles, then custom ones, each with the permissions it grants."""
    out = [{"role": k, **v, "custom": False,
            "permissions": sorted(BRAND_PERMS.get(k, ALL_BRAND_PERMS | PLATFORM_PERMS))} for k, v in ROLES.items()]
    out += [{"role": r["key"], "label": r["label"], "description": r["description"], "custom": True,
             "permissions": sorted(set(r["permissions"]) & ALL_BRAND_PERMS), "created_by": r["created_by"],
             "created_at": r["created_at"]} for r in custom_roles().values()]
    return out


def load_user(email: str, name: str = "", groups: list[str] | None = None, user_token: str | None = None,
              is_admin: bool = False) -> User:
    email = email.strip().lower()
    groups = groups if groups is not None else _groups_for(email, user_token)
    low_groups = {g.lower() for g in groups}
    rows = db.query("SELECT * FROM role_bindings")
    custom = custom_roles()
    bindings = [Binding(r["role"], r["brand_id"], [int(x) for x in r["destination_ids"] or []],
                        perms=role_perms(r["role"], custom), label=role_label(r["role"], custom)) for r in rows
                if (r["principal_type"] == "user" and r["principal"].lower() == email)
                or (r["principal_type"] == "group" and r["principal"].lower() in low_groups)]
    admins = _platform_admin_names()
    platform = (is_admin or email in admins or bool(low_groups & admins) or any(b.role == "platform_admin" for b in bindings))
    return User(email=email, name=name or email.split("@")[0], groups=groups,
                bindings=[b for b in bindings if b.role != "platform_admin"], platform_admin=platform)


PUBLIC_PATHS = {"/api/auth/config", "/api/auth/login"}


def bearer(headers) -> str:
    h = headers.get("authorization") or ""
    return h[7:].strip() if h.lower().startswith("bearer ") else ""


def _resolve(headers) -> User:
    if IN_DATABRICKS_APP:
        # people arrive with an email; service principals (e.g. a website's server) may only carry an id
        email = (headers.get("x-forwarded-email") or headers.get("x-forwarded-preferred-username")
                 or headers.get("x-forwarded-user") or "")
        if not email:
            raise HTTPException(401, "Sign in through Databricks to use this app")
        return load_user(email, headers.get("x-forwarded-preferred-username") or "",
                         user_token=headers.get("x-forwarded-access-token"))
    if auth.local_enabled():
        row = auth.user_for_token(bearer(headers))
        if not row:
            raise HTTPException(401, "Sign in to continue")
        return load_user(row["email"], row["name"], groups=[], is_admin=bool(row["is_admin"]))
    persona = headers.get("x-dev-user")
    if persona:
        return load_user(persona, groups=[])
    dev = os.environ.get("CDP_DEV_USER", "you@local.dev")
    u = load_user(dev, groups=[])
    u.platform_admin = True  # local development without sign-in or persona: full access
    return u


async def bind_user(request: Request) -> None:
    """App-wide dependency: resolve the caller once per request and expose it via current()."""
    path = request.url.path
    if not path.startswith("/api/"):
        return
    if path in PUBLIC_PATHS or (auth.local_enabled() and path == "/api/inbox" and request.method == "POST"):
        _user.set(ANON)  # sign-in itself, and the demo webhook receiver that syncs post to
        return
    _user.set(await run_in_threadpool(_resolve_scoped, request.headers))


def switchable_brands(u: User) -> list[dict]:
    """Brands the person can switch to (ignoring the one they're in now), by name."""
    allowed = u.all_brands()
    return [b for b in db.query("SELECT id, name FROM brands ORDER BY lower(name)") if allowed is None or b["id"] in allowed]


def sees_every_brand(u: User) -> bool:
    return u.all_brands() is None


def scope_to_brand(u: User, raw: str | None) -> None:
    """Apply the brand chosen in the app's brand switcher (X-Active-Brand: a brand id, or "all").
    A choice they may not make is ignored. Without a valid choice: people who see every brand (admins,
    brand-wide roles) work across all brands; everyone else lands in their first brand, so what they can
    do is always that brand's permissions."""
    raw = (raw or "").strip().lower()
    options = switchable_brands(u)
    ids = [b["id"] for b in options]
    if raw == "all" and sees_every_brand(u):
        u.active_brand = None
    elif raw.isdigit() and int(raw) in ids:
        u.active_brand = int(raw)
    else:
        u.active_brand = None if sees_every_brand(u) else (ids[0] if ids else None)


def _resolve_scoped(headers) -> User:
    u = _resolve(headers)
    scope_to_brand(u, headers.get("x-active-brand"))
    return u


def require(perm: str, brand_id: int | None = None, destination_id: int | None = None) -> User:
    u = current()
    if not u.can(perm, brand_id, destination_id):
        raise HTTPException(403, _denied(perm))
    return u


def require_view(brand_id: int | None) -> User:
    u = current()
    if not u.sees(brand_id):
        raise HTTPException(403, "You don't have access to this brand")
    return u


_DENIED = {
    "source.manage": "Only Platform Admins can manage Databricks sources.",
    "schema.manage": "Only Platform Admins can change the data model.",
    "settings.manage": "Only Platform Admins can change workspace settings.",
    "access.manage": "Only Platform Admins can manage brands and roles.",
    "audiences.edit": "Your role can't create or change audiences.",
    "traits.manage": "Only Brand Marketing Admins can manage traits.",
    "syncs.edit": "Your role can't create or change syncs.",
    "syncs.approve": "Only Brand Marketing Admins can approve syncs.",
    "syncs.run": "Your role can't run syncs to this destination.",
    "destinations.manage": "Only Brand Marketing Admins can manage destinations.",
    "governance.manage": "Only Brand Marketing Admins can manage destination rules and priority lists.",
    "view": "You don't have access to this brand.",
}


def _denied(perm: str) -> str:
    return _DENIED.get(perm, "You don't have permission to do that.")


# ---- which brand an object belongs to -------------------------------------------------------

def brand_of_parent(parent_id: int | None) -> int | None:
    row = db.one("SELECT brand_id FROM models WHERE id = ?", (parent_id,)) if parent_id else None
    return row["brand_id"] if row else None


def brand_of_model(model_id: int) -> int | None:
    m = db.one("SELECT kind, parent_id, brand_id FROM models WHERE id = ?", (model_id,))
    if not m:
        return None
    return m["brand_id"] if m["kind"] == "parent" else brand_of_parent(m["parent_id"])


def brand_of_audience(audience_id: int) -> int | None:
    a = db.one("SELECT parent_id FROM audiences WHERE id = ?", (audience_id,))
    return brand_of_parent(a["parent_id"]) if a else None


def brand_of_destination(dest_id: int) -> int | None:
    d = db.one("SELECT brand_id FROM destinations WHERE id = ?", (dest_id,))
    return d["brand_id"] if d else None


def brand_of_sync(sync_id: int) -> int | None:
    s = db.one("SELECT audience_id FROM syncs WHERE id = ?", (sync_id,))
    return brand_of_audience(s["audience_id"]) if s else None


# ---- audit & seed ---------------------------------------------------------------------------

def audit(action: str, object_type: str, object_id: int | None = None, brand_id: int | None = None, **details) -> None:
    db.insert("audit_log", {"at": db.now(), "actor": current().email, "action": action, "object_type": object_type,
                            "object_id": object_id, "brand_id": brand_id, "details": details})


def seed() -> None:
    """First run with brands: put existing parent models and destinations in a default brand."""
    if db.one("SELECT id FROM brands LIMIT 1"):
        return
    if not db.one("SELECT id FROM models WHERE kind = 'parent' LIMIT 1"):
        return
    bid = db.insert("brands", {"name": "Demo brand", "description": "Created automatically for existing data",
                               "created_at": db.now()})
    db.execute("UPDATE models SET brand_id = ? WHERE kind = 'parent' AND brand_id IS NULL", (bid,))
    db.execute("UPDATE destinations SET brand_id = ? WHERE brand_id IS NULL", (bid,))
