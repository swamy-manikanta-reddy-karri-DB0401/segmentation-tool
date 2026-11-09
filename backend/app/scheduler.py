"""Sync scheduling (all times UTC).

Schedule shapes (stored as JSON on the sync):
  {"type": "manual"}
  {"type": "interval", "every": 2, "unit": "minutes|hours|days|weeks"}
  {"type": "recurrence", "recurrences": [{"days": [0, 1, 2, 3, 4], "time": "09:00"}]}   # days: 0=Mon, UTC time
  {"type": "cron", "expression": "0 12 * * *"}                                           # 5 fields, UTC
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone

from croniter import croniter

from . import config, db, sync_engine

log = logging.getLogger("scheduler")

UNIT_SECONDS = {"minutes": 60, "hours": 3600, "days": 86400, "weeks": 604800}
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
UNSUPPORTED_CRON = re.compile(r"W|LW|L-\d|#")


class ScheduleError(ValueError):
    pass


def validate(schedule: dict | None) -> dict:
    s = schedule or {"type": "manual"}
    t = s.get("type", "manual")
    if t == "manual":
        return {"type": "manual"}
    if t == "interval":
        try:
            every = int(s.get("every"))
        except (TypeError, ValueError):
            raise ScheduleError("Interval must be a whole number")
        unit = s.get("unit", "hours")
        if every < 1 or unit not in UNIT_SECONDS:
            raise ScheduleError("Interval must be at least 1 minute, hour, day or week")
        if unit == "minutes" and every < 5:
            raise ScheduleError("The shortest interval is 5 minutes")
        return {"type": "interval", "every": every, "unit": unit}
    if t == "recurrence":
        recs = []
        for r in s.get("recurrences") or []:
            days = sorted({int(d) for d in r.get("days", []) if 0 <= int(d) <= 6})
            if not days or not TIME_RE.match(r.get("time", "")):
                raise ScheduleError("Each recurrence needs at least one day and a time (HH:MM)")
            recs.append({"days": days, "time": r["time"]})
        if not recs:
            raise ScheduleError("Add at least one recurrence")
        return {"type": "recurrence", "recurrences": recs}
    if t == "cron":
        expr = (s.get("expression") or "").strip()
        if len(expr.split()) != 5:
            raise ScheduleError("Cron expressions need exactly 5 fields (minute hour day month weekday)")
        if UNSUPPORTED_CRON.search(expr):
            raise ScheduleError("W, LW, L-n and # are not supported in cron expressions")
        if not croniter.is_valid(expr):
            raise ScheduleError("Invalid cron expression")
        return {"type": "cron", "expression": expr}
    raise ScheduleError(f"Unknown schedule type {t!r}")


def next_run(schedule: dict, after: datetime) -> datetime | None:
    """Next UTC run strictly after `after` (for intervals, `after` is the last run start)."""
    t = schedule.get("type")
    if t == "interval":
        return after + timedelta(seconds=schedule["every"] * UNIT_SECONDS[schedule["unit"]])
    if t == "recurrence":
        best = None
        for r in schedule["recurrences"]:
            hh, mm = map(int, r["time"].split(":"))
            for offset in range(0, 8):
                day = (after + timedelta(days=offset)).replace(hour=hh, minute=mm, second=0, microsecond=0)
                if day > after and day.weekday() in r["days"]:
                    best = day if best is None or day < best else best
                    break
        return best
    if t == "cron":
        return croniter(schedule["expression"], after).get_next(datetime)
    return None


def compute_next(sync: dict, now: datetime | None = None) -> str | None:
    now = now or datetime.now(timezone.utc)
    schedule = sync.get("schedule") or {"type": "manual"}
    if not sync.get("enabled", True):
        return None
    if schedule.get("type") == "interval" and sync.get("last_run_at"):
        nxt = next_run(schedule, datetime.fromisoformat(sync["last_run_at"]))
        return max(nxt, now).isoformat(timespec="seconds")
    if schedule.get("type") == "interval":
        return now.isoformat(timespec="seconds")
    nxt = next_run(schedule, now)
    return nxt.isoformat(timespec="seconds") if nxt else None


def refresh_next(sync_id: int) -> None:
    s = db.one("SELECT * FROM syncs WHERE id = ?", (sync_id,))
    if s:
        db.update("syncs", sync_id, {"next_run_at": compute_next(s)})


def recover_interrupted_runs() -> None:
    for run in db.query("SELECT id FROM sync_runs WHERE status = 'running'"):
        db.update("sync_runs", run["id"], {"status": "failed", "finished_at": db.now(),
                                           "error": "Interrupted (server restarted during the run)"})
    for s in db.query("SELECT id FROM syncs"):
        refresh_next(s["id"])


def due_syncs(now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    from .insights import destination_configured  # syncs wait until their destination has credentials
    return [s for s in db.query("SELECT * FROM syncs WHERE enabled = 1 AND next_run_at IS NOT NULL")
            if datetime.fromisoformat(s["next_run_at"]) <= now and not sync_engine.is_running(s["id"])
            and destination_configured(s["destination_id"])]


async def loop() -> None:
    while True:
        try:
            for s in due_syncs():
                log.info("Starting scheduled sync %s", s["id"])
                sync_engine.start_run(s["id"], trigger="schedule")
                # Advance from now so a slow run can't trigger a burst of catch-up runs.
                db.update("syncs", s["id"], {"next_run_at": compute_next({**s, "last_run_at": db.now()})})
        except Exception:  # keep the scheduler alive
            log.exception("Scheduler tick failed")
        await asyncio.sleep(config.SCHEDULER_TICK_SECONDS)
