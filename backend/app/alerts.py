"""Sync alerting, modelled on Hightouch's: triggers per sync, defaults per destination, recipients by channel.

Triggers (each WARNING or CRITICAL, or healthy):
* fatal        a run fails outright                                    — on, CRITICAL
* rejected     a run has rejected rows (≥ min_rows)                    — on, WARNING
* throughput   nothing delivered for `days` days                       — on, WARNING (checked every 5 min)
* audience     the audience has fewer than `min_rows` people at run     — off until a minimum is set
* duration     a run takes longer than `minutes`                        — off until a limit is set (checked live)

Configuration: built-in defaults ← destination defaults ← per-sync overrides (each trigger separately).
State: one row per (sync, trigger) in `alerts`; every status change is an `alert_events` row and sends ONE
notification (warning / critical / recovered) to eligible recipients — unless the trigger is muted.
Channels: email (SMTP from workspace settings), Slack (incoming webhook), PagerDuty (Events API v2),
webhook (JSON POST with Hightouch-style payload and optional headers).
"""
from __future__ import annotations

import os
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import httpx

from . import db

TRIGGERS = {
    "fatal": {"label": "Run failed", "description": "A run can't complete — e.g. the destination rejected the credentials or the audience query failed.",
              "defaults": {"enabled": True, "severity": "critical"}},
    "rejected": {"label": "Rejected records", "description": "The destination refused some records in a run (bad email, missing field…).",
                 "defaults": {"enabled": True, "severity": "warning", "min_rows": 1}},
    "throughput": {"label": "Nothing delivered", "description": "No records were sent for a number of days — the sync may be stuck or the audience frozen.",
                   "defaults": {"enabled": True, "severity": "warning", "days": 7}},
    "audience": {"label": "Audience too small", "description": "Fewer people than expected qualified at run time — often a sign of broken upstream data.",
                 "defaults": {"enabled": False, "severity": "warning", "min_rows": 1}},
    "duration": {"label": "Slow run", "description": "A run takes longer than expected.",
                 "defaults": {"enabled": False, "severity": "warning", "minutes": 60}},
}
THRESHOLDS = {"rejected": "min_rows", "throughput": "days", "audience": "min_rows", "duration": "minutes"}
CHANNELS = {
    "email": {"label": "Email", "fields": ["address"]},
    "slack": {"label": "Slack", "fields": ["webhook_url"]},
    "pagerduty": {"label": "PagerDuty", "fields": ["routing_key"]},
    "webhook": {"label": "Webhook", "fields": ["url", "headers"]},
}
SEVERITIES = ("warning", "critical")
SECRET_FIELDS = {"webhook_url", "routing_key", "headers"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def _parse(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


# ---- configuration ------------------------------------------------------------------------

def validate_triggers(triggers: dict) -> dict:
    out = {}
    for key, cfg in (triggers or {}).items():
        if key not in TRIGGERS:
            raise ValueError(f"Unknown alert trigger {key!r}")
        clean: dict = {}
        if "enabled" in cfg:
            clean["enabled"] = bool(cfg["enabled"])
        if "severity" in cfg:
            if cfg["severity"] not in SEVERITIES:
                raise ValueError("Severity must be warning or critical")
            clean["severity"] = cfg["severity"]
        t = THRESHOLDS.get(key)
        if t and t in cfg and cfg[t] not in (None, ""):
            v = int(cfg[t])
            if v < 1:
                raise ValueError(f"{TRIGGERS[key]['label']}: the threshold must be at least 1")
            clean[t] = v
        out[key] = clean
    return out


def policy(scope: str, scope_id: int) -> dict | None:
    return db.one("SELECT * FROM alert_policies WHERE scope = ? AND scope_id = ?", (scope, scope_id))


def save_policy(scope: str, scope_id: int, triggers: dict, recipient_ids: list[int] | None) -> dict:
    triggers = validate_triggers(triggers)
    if recipient_ids is not None:
        for rid in recipient_ids:
            if not db.one("SELECT id FROM alert_recipients WHERE id = ?", (rid,)):
                raise ValueError(f"Recipient {rid} not found")
    values = {"triggers": triggers, "recipient_ids": recipient_ids, "updated_at": db.now()}
    existing = policy(scope, scope_id)
    if existing:
        db.update("alert_policies", existing["id"], values)
    else:
        db.insert("alert_policies", {"scope": scope, "scope_id": scope_id, **values})
    return effective(scope, scope_id)


def effective(scope: str, scope_id: int) -> dict:
    """Trigger settings with where each value comes from: default → destination → sync."""
    dest_id = scope_id if scope == "destination" else (db.one("SELECT destination_id FROM syncs WHERE id = ?", (scope_id,)) or {}).get("destination_id")
    layers = [("default", {k: v["defaults"] for k, v in TRIGGERS.items()})]
    dp = policy("destination", dest_id) if dest_id else None
    if dp:
        layers.append(("destination", dp["triggers"] or {}))
    sp = policy("sync", scope_id) if scope == "sync" else None
    if sp:
        layers.append(("sync", sp["triggers"] or {}))
    triggers: dict = {}
    for key in TRIGGERS:
        merged: dict = {}
        source = "default"
        for name, layer in layers:
            if layer.get(key):
                merged.update(layer[key])
                if name != "default":
                    source = name
        triggers[key] = {**merged, "source": source}
    recipients = (sp or {}).get("recipient_ids")
    recipients_source = "sync" if recipients is not None else "destination" if (dp and dp.get("recipient_ids") is not None) else "default"
    if recipients is None and dp:
        recipients = dp.get("recipient_ids")
    return {"triggers": triggers, "recipient_ids": recipients, "recipients_source": recipients_source,
            "own": (sp if scope == "sync" else dp) or {"triggers": {}, "recipient_ids": None}}


def recipients_for(sync: dict, severity_changed: tuple[str, str]) -> list[dict]:
    eff = effective("sync", sync["id"])
    rows = db.query("SELECT * FROM alert_recipients WHERE enabled = 1")
    if eff["recipient_ids"] is not None:
        rows = [r for r in rows if r["id"] in eff["recipient_ids"]]
    else:
        rows = [r for r in rows if (not r["destination_ids"] or sync["destination_id"] in r["destination_ids"])
                and (r["brand_id"] is None or r["brand_id"] == sync.get("brand_id"))]
    critical = "critical" in severity_changed
    return [r for r in rows if r["severity"] == "all" or critical]


# ---- state ---------------------------------------------------------------------------------

def _sync(sync_id: int) -> dict | None:
    return db.one("SELECT s.*, d.name AS destination_name, d.type AS destination_type, a.name AS audience_name, m.brand_id AS brand_id "
                  "FROM syncs s JOIN destinations d ON d.id = s.destination_id JOIN audiences a ON a.id = s.audience_id "
                  "LEFT JOIN models m ON m.id = a.parent_id WHERE s.id = ?", (sync_id,))


def _muted(row: dict | None) -> bool:
    if not row or not row.get("muted_until"):
        return False
    return row["muted_until"] == "forever" or (_parse(row["muted_until"]) or _now()) > _now()


def set_status(sync: dict, trigger: str, status: str, message: str, error: str = "", run_id: int | None = None) -> bool:
    """Record a trigger's status; on change, log an event and notify. Returns True if it changed."""
    row = db.one("SELECT * FROM alerts WHERE sync_id = ? AND trigger = ?", (sync["id"], trigger))
    old = row["status"] if row else "healthy"
    if old == status:
        if row and status != "healthy" and message and message != row["message"]:
            db.update("alerts", row["id"], {"message": message, "updated_at": db.now()})
        return False
    now = db.now()
    values = {"status": status, "message": message, "error": error, "updated_at": now,
              "opened_at": (row or {}).get("opened_at") if old != "healthy" and status != "healthy" else (now if status != "healthy" else (row or {}).get("opened_at")),
              "resolved_at": now if status == "healthy" else None, "last_run_id": run_id}
    if row:
        db.update("alerts", row["id"], values)
        alert_id = row["id"]
    else:
        alert_id = db.insert("alerts", {"sync_id": sync["id"], "trigger": trigger, "muted_until": None, **values})
    muted = _muted(row)
    deliveries = [] if muted else notify(sync, trigger, old, status, message, error)
    db.insert("alert_events", {"alert_id": alert_id, "sync_id": sync["id"], "trigger": trigger, "old_status": old,
                               "new_status": status, "message": message, "at": now, "muted": int(muted),
                               "deliveries": deliveries, "run_id": run_id})
    return True


def mute(sync_id: int, trigger: str, minutes: int | None) -> dict:
    if trigger not in TRIGGERS:
        raise ValueError("Unknown trigger")
    until = "forever" if not minutes else _iso(_now() + timedelta(minutes=int(minutes)))
    row = db.one("SELECT id FROM alerts WHERE sync_id = ? AND trigger = ?", (sync_id, trigger))
    if row:
        db.update("alerts", row["id"], {"muted_until": until})
    else:
        db.insert("alerts", {"sync_id": sync_id, "trigger": trigger, "status": "healthy", "message": "", "error": "",
                             "updated_at": db.now(), "opened_at": None, "resolved_at": None, "muted_until": until, "last_run_id": None})
    return {"muted_until": until}


def unmute(sync_id: int, trigger: str) -> None:
    db.execute("UPDATE alerts SET muted_until = NULL WHERE sync_id = ? AND trigger = ?", (sync_id, trigger))


# ---- evaluation -------------------------------------------------------------------------------

def after_run(sync_id: int, run_id: int) -> None:
    """Evaluate run-based triggers when a run ends."""
    sync = _sync(sync_id)
    run = db.one("SELECT * FROM sync_runs WHERE id = ?", (run_id,))
    if not sync or not run:
        return
    t = effective("sync", sync_id)["triggers"]
    failed = run["status"] == "failed"
    if t["fatal"]["enabled"]:
        set_status(sync, "fatal", t["fatal"]["severity"] if failed else "healthy",
                   f"Run #{run_id} failed" if failed else "", run.get("error") or "" if failed else "", run_id)
    if not failed:
        if t["rejected"]["enabled"]:
            bad = (run.get("failed") or 0) >= t["rejected"]["min_rows"]
            set_status(sync, "rejected", t["rejected"]["severity"] if bad else "healthy",
                       f"{run.get('failed')} records rejected in run #{run_id}" if bad else "", run.get("error") or "", run_id)
        if t["audience"]["enabled"] and run.get("audience_rows") is not None:
            small = run["audience_rows"] < t["audience"]["min_rows"]
            set_status(sync, "audience", t["audience"]["severity"] if small else "healthy",
                       f"Only {run['audience_rows']} people qualified (minimum {t['audience']['min_rows']})" if small else "", "", run_id)
        if (run.get("added") or 0) + (run.get("changed") or 0) + (run.get("removed") or 0) > 0 and t["throughput"]["enabled"]:
            set_status(sync, "throughput", "healthy", "", "", run_id)
    if t["duration"]["enabled"] and run.get("finished_at"):
        took = (_parse(run["finished_at"]) - _parse(run["started_at"])).total_seconds() / 60
        slow = took > t["duration"]["minutes"]
        set_status(sync, "duration", t["duration"]["severity"] if slow else "healthy",
                   f"Run #{run_id} took {took:.0f} min (limit {t['duration']['minutes']})" if slow else "", "", run_id)


def evaluate_periodic(now: datetime | None = None) -> None:
    """Time-based triggers: nothing delivered for N days, runs still going past the limit."""
    now = now or _now()
    for s in db.query("SELECT id FROM syncs WHERE enabled = 1 AND approval_status = 'approved'"):
        sync = _sync(s["id"])
        t = effective("sync", s["id"])["triggers"]
        if t["throughput"]["enabled"]:
            days = t["throughput"]["days"]
            since = _iso(now - timedelta(days=days))
            started = _parse(sync["created_at"]) or now
            delivered = db.one("SELECT id FROM sync_runs WHERE sync_id = ? AND status IN ('success', 'completed_with_errors') "
                               "AND (added + changed + removed) > 0 AND started_at >= ? LIMIT 1", (s["id"], since))
            stale = not delivered and started <= now - timedelta(days=days)
            set_status(sync, "throughput", t["throughput"]["severity"] if stale else "healthy",
                       f"Nothing delivered to {sync['destination_name']} in {days} day{'s' if days != 1 else ''}" if stale else "")
        if t["duration"]["enabled"]:
            run = db.one("SELECT id, started_at FROM sync_runs WHERE sync_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1", (s["id"],))
            if run:
                took = (now - _parse(run["started_at"])).total_seconds() / 60
                if took > t["duration"]["minutes"]:
                    set_status(sync, "duration", t["duration"]["severity"],
                               f"Run #{run['id']} has been running for {took:.0f} min (limit {t['duration']['minutes']})", "", run["id"])


# ---- notifications ----------------------------------------------------------------------------

def app_url() -> str:
    return os.environ.get("CDP_APP_URL", "").rstrip("/")


def _texts(sync: dict, trigger: str, old: str, new: str, message: str, error: str) -> tuple[str, str]:
    label = TRIGGERS[trigger]["label"]
    if new == "healthy":
        title = f"Recovered: {label} — {sync['name']}"
        body = f"“{label}” is healthy again for the sync {sync['name']} ({sync['audience_name']} → {sync['destination_name']})."
    else:
        title = f"{new.upper()}: {label} — {sync['name']}"
        body = f"{message or label} for the sync {sync['name']} ({sync['audience_name']} → {sync['destination_name']})."
        if error:
            body += f"\nError: {error[:500]}"
    url = app_url()
    if url:
        body += f"\nOpen: {url}/activations/{sync['id']}"
    return title, body


def payload(sync: dict, trigger: str, old: str, new: str, message: str, error: str) -> dict:
    """Webhook body, same shape as Hightouch's alert webhook."""
    url = app_url()
    return {"resourceId": str(sync["id"]), "resourceType": "Sync", "resourceName": sync["name"],
            "resourceUrl": f"{url}/activations/{sync['id']}" if url else None,
            "resourceLabels": {"audience": sync["audience_name"]}, "destinationLabels": {"name": sync["destination_name"], "type": sync["destination_type"]},
            "newStatus": new.upper(), "oldStatus": old.upper(),
            "trigger": {"displayName": TRIGGERS[trigger]["label"], "status": new.upper(), "displayMessage": message, "error": error or None}}


def send(recipient: dict, sync: dict, trigger: str, old: str, new: str, message: str, error: str) -> None:
    cfg = recipient["config"] or {}
    title, body = _texts(sync, trigger, old, new, message, error)
    ch = recipient["channel"]
    if ch == "slack":
        icon = ":white_check_mark:" if new == "healthy" else ":red_circle:" if new == "critical" else ":warning:"
        r = httpx.post(cfg["webhook_url"], json={"text": f"{icon} *{title}*\n{body}"}, timeout=10)
    elif ch == "webhook":
        headers = {}
        for line in (cfg.get("headers") or "").splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip()] = v.strip()
        r = httpx.post(cfg["url"], json=payload(sync, trigger, old, new, message, error), headers=headers, timeout=10)
    elif ch == "pagerduty":
        r = httpx.post("https://events.pagerduty.com/v2/enqueue", timeout=10, json={
            "routing_key": cfg["routing_key"], "event_action": "resolve" if new == "healthy" else "trigger",
            "dedup_key": f"mediamint-cdp-sync-{sync['id']}-{trigger}",
            "payload": {"summary": title[:1000], "source": "MediaMint CDP", "severity": "critical" if new == "critical" else "warning",
                        "custom_details": {"message": message, "error": error}}})
    elif ch == "email":
        send_email(cfg["address"], f"[MediaMint CDP] {title}", body)
        return
    else:
        raise ValueError(f"Unknown channel {ch}")
    if r.status_code >= 300:
        raise ValueError(f"{CHANNELS[ch]['label']} answered {r.status_code}: {r.text[:200]}")


def send_email(to: str, subject: str, body: str) -> None:
    s = db.get_setting("smtp") or {}
    if not s.get("host"):
        raise ValueError("Email isn't set up — add an SMTP server under Alerts → Recipients → Email settings")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = s.get("sender") or s.get("username"), to, subject
    msg.set_content(body)
    port = int(s.get("port") or 587)
    if port == 465:
        with smtplib.SMTP_SSL(s["host"], port, timeout=15, context=ssl.create_default_context()) as srv:
            if s.get("username"):
                srv.login(s["username"], s.get("password", ""))
            srv.send_message(msg)
    else:
        with smtplib.SMTP(s["host"], port, timeout=15) as srv:
            if s.get("starttls", True):
                srv.starttls(context=ssl.create_default_context())
            if s.get("username"):
                srv.login(s["username"], s.get("password", ""))
            srv.send_message(msg)


def notify(sync: dict, trigger: str, old: str, new: str, message: str, error: str) -> list[dict]:
    out = []
    for r in recipients_for(sync, (old, new)):
        try:
            send(r, sync, trigger, old, new, message, error)
            out.append({"recipient_id": r["id"], "name": r["name"], "channel": r["channel"], "ok": True})
        except Exception as e:  # noqa: BLE001 — one bad channel must not stop the others
            out.append({"recipient_id": r["id"], "name": r["name"], "channel": r["channel"], "ok": False, "error": str(e)[:300]})
    return out


def test_recipient(recipient: dict) -> str:
    fake = {"id": 0, "name": "Test sync", "audience_name": "Test audience", "destination_name": "Test destination", "destination_type": "test"}
    send(recipient, fake, "fatal", "healthy", "critical", "This is a test alert from MediaMint CDP — no action needed.", "")
    return f"Test alert sent via {CHANNELS[recipient['channel']]['label']}"


# ---- recipients -------------------------------------------------------------------------------

def validate_recipient(body: dict, existing: dict | None = None) -> dict:
    ch = body.get("channel") or (existing or {}).get("channel")
    if ch not in CHANNELS:
        raise ValueError("Choose a channel: email, Slack, PagerDuty or webhook")
    cfg = dict((existing or {}).get("config") or {})
    for k, v in (body.get("config") or {}).items():
        if v != "••••••••":
            cfg[k] = (v or "").strip()
    if ch == "email" and "@" not in cfg.get("address", ""):
        raise ValueError("Enter an email address")
    if ch == "slack" and not cfg.get("webhook_url", "").startswith("https://"):
        raise ValueError("Paste the Slack incoming-webhook URL (https://hooks.slack.com/…)")
    if ch == "pagerduty" and len(cfg.get("routing_key", "")) < 20:
        raise ValueError("Paste the PagerDuty integration (routing) key")
    if ch == "webhook" and not cfg.get("url", "").startswith(("https://", "http://")):
        raise ValueError("Enter the webhook URL")
    severity = body.get("severity", (existing or {}).get("severity", "all"))
    if severity not in ("all", "critical"):
        raise ValueError("Severity must be all or critical")
    name = (body.get("name") or (existing or {}).get("name") or "").strip()
    if not name:
        raise ValueError("Give the recipient a name")
    return {"name": name, "channel": ch, "config": cfg, "severity": severity,
            "destination_ids": [int(x) for x in body.get("destination_ids", (existing or {}).get("destination_ids") or [])],
            "enabled": bool(body.get("enabled", (existing or {}).get("enabled", True)))}


def mask(recipient: dict) -> dict:
    cfg = recipient.get("config") or {}
    return {**recipient, "config": {k: ("••••••••" if k in SECRET_FIELDS and v else v) for k, v in cfg.items()},
            "target": cfg.get("address") or (cfg.get("url") if recipient["channel"] == "webhook" else None)
            or {"slack": "Slack channel webhook", "pagerduty": "PagerDuty service"}.get(recipient["channel"], "")}


def migrate_legacy() -> None:
    """Older syncs kept a Slack-style webhook in their config; turn each into a recipient once."""
    if db.get_setting("alerts_migrated"):
        return
    for s in db.query("SELECT id, name, config FROM syncs"):
        url = ((s["config"] or {}).get("alerts") or {}).get("webhook_url")
        if url:
            rid = db.insert("alert_recipients", {"name": f"{s['name']} webhook", "channel": "slack", "config": {"webhook_url": url},
                                                 "severity": "all", "destination_ids": [], "brand_id": None, "enabled": 1,
                                                 "created_by": "migration", "created_at": db.now()})
            save_policy("sync", s["id"], {}, [rid])
    db.set_setting("alerts_migrated", True)
