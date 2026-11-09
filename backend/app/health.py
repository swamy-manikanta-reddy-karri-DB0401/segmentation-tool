"""Schedules, sync health and alert helpers."""
from datetime import datetime, timedelta

import httpx

DEFAULT_ALERTS = {
    "on_failure": True,          # fatal failure, cancelled, timed out
    "on_rejected": True,         # destination rejected some rows -> warning
    "unhealthy_pct": 50,         # rejected % at/above which warning becomes unhealthy
    "on_stale": True,            # scheduled sync hasn't run within its expected window
    "stale_grace_minutes": 15,
    "min_rows": None,            # row-count thresholds
    "max_rows": None,
    "max_change_pct": None,      # change vs the previous successful run
    "block_on_threshold": False,  # don't push when thresholds are violated
    "webhook_url": "",
}
MIN_INTERVAL = 5


def alert_cfg(sync) -> dict:
    return {**DEFAULT_ALERTS, **(sync.alerts or {})}


def sched(sync) -> dict:
    return sync.schedule or {"type": "manual"}


def normalize_schedule(s: dict) -> dict:
    t = (s or {}).get("type", "manual")
    if t == "interval":
        return {"type": "interval", "minutes": max(int(s.get("minutes") or 60), MIN_INTERVAL)}
    if t == "daily":
        hh, mm = str(s.get("time") or "09:00").split(":")[:2]
        if not (0 <= int(hh) < 24 and 0 <= int(mm) < 60):
            raise ValueError("Invalid daily time")
        return {"type": "daily", "time": f"{int(hh):02d}:{int(mm):02d}"}
    return {"type": "manual"}


def expected_interval(sync) -> timedelta | None:
    s = sched(sync)
    if s["type"] == "interval":
        return timedelta(minutes=s["minutes"])
    if s["type"] == "daily":
        return timedelta(days=1)
    return None


def is_due(sync, last_run, last_scheduled, now: datetime) -> bool:
    s = sched(sync)
    if not sync.schedule_enabled:
        return False
    if s["type"] == "interval":
        return last_run is None or now >= last_run.started_at + timedelta(minutes=s["minutes"])
    if s["type"] == "daily":
        hh, mm = map(int, s["time"].split(":"))
        today = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        return now >= today and (last_scheduled is None or last_scheduled.started_at < today)
    return False


def next_run(sync, last_run, now: datetime) -> datetime | None:
    s = sched(sync)
    if not sync.schedule_enabled or s["type"] == "manual":
        return None
    if s["type"] == "interval":
        return max(now, last_run.started_at + timedelta(minutes=s["minutes"])) if last_run else now
    hh, mm = map(int, s["time"].split(":"))
    t = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    return t if t > now else t + timedelta(days=1)


def is_stale(sync, last_run, now: datetime) -> bool:
    exp = expected_interval(sync)
    if not exp or not sync.schedule_enabled:
        return False
    ref = last_run.started_at if last_run else sync.created_at
    return now - ref > exp * 1.5 + timedelta(minutes=alert_cfg(sync)["stale_grace_minutes"])


def health(sync, last_run, now: datetime | None = None) -> dict:
    """healthy | warning | unhealthy | unknown, with a reason (mirrors Hightouch's trigger -> health mapping)."""
    now = now or datetime.utcnow()
    if is_stale(sync, last_run, now):
        return {"status": "unhealthy", "reason": "Scheduled sync hasn't run within its expected window"}
    if last_run is None:
        return {"status": "unknown", "reason": "Never run"}
    st, cfg = last_run.status, alert_cfg(sync)
    if st in ("queued", "running"):
        return {"status": "unknown", "reason": "Run in progress"}
    if st == "failed":
        return {"status": "unhealthy", "reason": last_run.error or "Last run failed"}
    if st == "cancelled":
        return {"status": "unhealthy", "reason": "Last run was cancelled"}
    if st == "timed_out":
        return {"status": "unhealthy", "reason": "Last run timed out"}
    if st == "warning":
        pct = 100 * last_run.failed / max(last_run.total, 1)
        if pct >= cfg["unhealthy_pct"]:
            return {"status": "unhealthy", "reason": f"{pct:.0f}% of rows rejected"}
        return {"status": "warning", "reason": f"{last_run.failed:,} rows rejected"}
    if last_run.flags:
        return {"status": "warning", "reason": last_run.flags.splitlines()[0]}
    return {"status": "healthy", "reason": ""}


def send_webhook(url: str, payload: dict) -> None:
    if not url:
        return
    try:
        httpx.post(url, json={"text": f"[{payload['severity']}] {payload['sync']}: {payload['message']}", **payload}, timeout=5)
    except Exception:  # noqa: BLE001 - alert delivery must never break a run
        pass


def raise_alert(db, sync, run, kind: str, severity: str, message: str):
    from .db import Alert

    db.add(Alert(sync_id=sync.id, run_id=run.id if run else None, kind=kind, severity=severity, message=message))
    db.commit()
    send_webhook(alert_cfg(sync)["webhook_url"], {"sync": sync.name, "kind": kind, "severity": severity, "message": message})
