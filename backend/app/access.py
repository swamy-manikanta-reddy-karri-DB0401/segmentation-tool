"""Who is calling, and what they may do.

Identity
* Deployed as a Databricks App: the user's identity arrives in the X-Forwarded-Email / X-Forwarded-User
  headers added by the Databricks Apps proxy. Their Databricks groups are looked up (cached) so roles can be
  granted to groups, the way workspace admins already manage access.
* Local development (no Apps proxy): the X-Dev-User header picks a test persona; without it you are a
  Platform Admin.

Roles (per brand, granted to a user or a Databricks group)
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

from . import db

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


@dataclass
class User:
    email: str
    name: str = ""
    groups: list[str] = field(default_factory=list)
    bindings: list[Binding] = field(default_factory=list)
    platform_admin: bool = False
    system: bool = False  # scheduler / background work

    def can(self, perm: str, brand_id: int | None = None, destination_id: int | None = None) -> bool:
        if self.system or self.platform_admin:
            return True
        if perm in PLATFORM_PERMS:
            return False
        for b in self.bindings:
            if perm not in BRAND_PERMS.get(b.role, set()):
                continue
            if b.brand_id is not None and brand_id is not None and b.brand_id != brand_id:
                continue
            if b.brand_id is not None and brand_id is None and perm != "view":
                continue  # shared (brand-less) objects can only be changed by platform admins
            if perm == "syncs.run" and b.role == "operator" and b.destination_ids and destination_id not in b.destination_ids:
                continue
            return True
        return False

    def brands(self, perm: str = "view") -> set[int] | None:
        """Brand IDs where the user has `perm`; None means every brand."""
        if self.system or self.platform_admin:
            return None
        out: set[int] = set()
        for b in self.bindings:
            if perm in BRAND_PERMS.get(b.role, set()):
                if b.brand_id is None:
                    return None
                out.add(b.brand_id)
        return out

    def sees(self, brand_id: int | None) -> bool:
        allowed = self.brands("view")
        return allowed is None or brand_id is None or brand_id in allowed


SYSTEM = User(email="system", name="Scheduler", system=True)
_user: ContextVar[User] = ContextVar("user", default=SYSTEM)


def current() -> User:
    return _user.get()


# ---- identity ----------------------------------------------------------------------------

_group_cache: dict[str, tuple[list[str], float]] = {}
_group_lock = threading.Lock()


def _groups_for(email: str) -> list[str]:
    """Databricks workspace groups of a user (cached for 5 minutes). Empty if the lookup isn't possible."""
    with _group_lock:
        hit = _group_cache.get(email)
        if hit and hit[1] > time.time():
            return hit[0]
    groups: list[str] = []
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


def _local_client():
    from databricks.sdk import WorkspaceClient
    from . import config
    if config.DATABRICKS_HOST and config.DATABRICKS_TOKEN:
        return WorkspaceClient(host=config.DATABRICKS_HOST, token=config.DATABRICKS_TOKEN)
    return None


def _platform_admin_names() -> set[str]:
    raw = os.environ.get("CDP_PLATFORM_ADMINS", "" if IN_DATABRICKS_APP else "")
    return {x.strip().lower() for x in raw.split(",") if x.strip()}


def load_user(email: str, name: str = "", groups: list[str] | None = None) -> User:
    email = email.strip().lower()
    groups = groups if groups is not None else _groups_for(email)
    low_groups = {g.lower() for g in groups}
    rows = db.query("SELECT * FROM role_bindings")
    bindings = [Binding(r["role"], r["brand_id"], [int(x) for x in r["destination_ids"] or []]) for r in rows
                if (r["principal_type"] == "user" and r["principal"].lower() == email)
                or (r["principal_type"] == "group" and r["principal"].lower() in low_groups)]
    admins = _platform_admin_names()
    platform = (email in admins or bool(low_groups & admins) or any(b.role == "platform_admin" for b in bindings))
    return User(email=email, name=name or email.split("@")[0], groups=groups,
                bindings=[b for b in bindings if b.role != "platform_admin"], platform_admin=platform)


def _resolve(headers) -> User:
    if IN_DATABRICKS_APP:
        email = headers.get("x-forwarded-email") or headers.get("x-forwarded-preferred-username") or ""
        if not email:
            raise HTTPException(401, "Sign in through Databricks to use this app")
        return load_user(email, headers.get("x-forwarded-preferred-username") or "")
    persona = headers.get("x-dev-user")
    if persona:
        return load_user(persona, groups=[])
    dev = os.environ.get("CDP_DEV_USER", "you@local.dev")
    u = load_user(dev, groups=[])
    u.platform_admin = True  # local development without a persona: full access
    return u


async def bind_user(request: Request) -> None:
    """App-wide dependency: resolve the caller once per request and expose it via current()."""
    if not request.url.path.startswith("/api/"):
        return
    _user.set(await run_in_threadpool(_resolve, request.headers))


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
