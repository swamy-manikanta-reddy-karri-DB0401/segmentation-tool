"""Email + password sign-in for local development and non-Databricks deployments.

When the app runs as a Databricks App, people are identified by the Databricks proxy (see access.py) and none
of this is used. Everywhere else, people sign in with an email and password, get a session token, and send it as
``Authorization: Bearer <token>``. Set ``CDP_LOCAL_AUTH=0`` to switch sign-in off (the old open dev mode).

* Passwords are stored as salted scrypt hashes (standard library, no extra dependency).
* Session tokens are random; only their SHA-256 is stored, so a leaked database can't be replayed.
* Repeated wrong passwords lock the account briefly.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from . import db

log = logging.getLogger(__name__)

MIN_PASSWORD = 8
SESSION_HOURS = int(os.environ.get("CDP_SESSION_HOURS", "12"))
MAX_FAILS = 5
LOCK_SECONDS = 60
_SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}


def local_enabled() -> bool:
    """Local email/password sign-in applies outside Databricks Apps unless explicitly switched off."""
    return not os.environ.get("DATABRICKS_APP_NAME") and os.environ.get("CDP_LOCAL_AUTH", "1") != "0"


# ---- passwords ------------------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(got, bytes.fromhex(digest))
    except (ValueError, TypeError):
        return False


_DUMMY = hash_password("not-a-real-password")


def check_new_password(password: str) -> str:
    if len(password or "") < MIN_PASSWORD:
        raise ValueError(f"Use a password of at least {MIN_PASSWORD} characters")
    return password


def clean_email(email: str) -> str:
    email = (email or "").strip().lower()
    if "@" not in email or " " in email or email.startswith("@") or email.endswith("@"):
        raise ValueError("Enter a valid email address")
    return email


# ---- throttling -------------------------------------------------------------------------------

_fails: dict[str, tuple[int, float]] = {}
_fails_lock = threading.Lock()


def _locked_for(email: str) -> int:
    with _fails_lock:
        n, until = _fails.get(email, (0, 0.0))
    return int(until - time.time()) + 1 if n >= MAX_FAILS and until > time.time() else 0


def _record(email: str, ok: bool) -> None:
    with _fails_lock:
        if ok:
            _fails.pop(email, None)
            return
        n, until = _fails.get(email, (0, 0.0))
        if until < time.time():
            n = 0  # the last miss was over a minute ago (or the lock ran out): start counting again
        _fails[email] = (n + 1, time.time() + LOCK_SECONDS)


# ---- sessions ---------------------------------------------------------------------------------

def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def login(email: str, password: str) -> tuple[str, dict]:
    """Returns (session token, user row). Raises PermissionError with a message that doesn't reveal which part was wrong."""
    email = (email or "").strip().lower()
    wait = _locked_for(email)
    if wait:
        raise PermissionError(f"Too many wrong passwords. Try again in {wait} seconds.")
    user = db.one("SELECT * FROM users WHERE email = ?", (email,))
    ok = verify_password(password or "", user["password_hash"] if user else _DUMMY)  # same work either way
    if not (user and ok and user["active"]):
        _record(email, False)
        raise PermissionError("Wrong email or password" if not user or not ok else "This account is switched off. Ask an admin.")
    _record(email, True)
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    db.insert("sessions", {"token_hash": _digest(token), "user_id": user["id"], "created_at": now.isoformat(timespec="seconds"),
                           "expires_at": (now + timedelta(hours=SESSION_HOURS)).isoformat(timespec="seconds")})
    db.update("users", user["id"], {"last_login_at": db.now()})
    db.execute("DELETE FROM sessions WHERE expires_at < ?", (db.now(),))
    return token, user


def user_for_token(token: str) -> dict | None:
    if not token:
        return None
    row = db.one("SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id "
                 "WHERE s.token_hash = ?", (_digest(token),))
    if not row or not row["active"] or row["session_expires"] < db.now():
        return None
    return row


def logout(token: str) -> None:
    if token:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (_digest(token),))


def end_sessions(user_id: int, except_token: str | None = None) -> None:
    if except_token:
        db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user_id, _digest(except_token)))
    else:
        db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


# ---- first admin ------------------------------------------------------------------------------

def seed() -> None:
    """With sign-in on and nobody registered yet, create the first admin so someone can get in.
    CDP_ADMIN_EMAIL / CDP_ADMIN_PASSWORD choose it; otherwise admin@local.dev with a development password."""
    if not local_enabled() or db.one("SELECT id FROM users LIMIT 1"):
        return
    email = clean_email(os.environ.get("CDP_ADMIN_EMAIL") or "admin@local.dev")
    password = os.environ.get("CDP_ADMIN_PASSWORD")
    default = not password
    password = password or "admin12345"
    db.insert("users", {"email": email, "name": "Admin", "password_hash": hash_password(check_new_password(password)),
                        "is_admin": 1, "active": 1, "created_by": "system", "created_at": db.now()})
    log.warning("Created the first admin %s%s. Sign in and change the password.", email,
                " with the default development password" if default else "")
