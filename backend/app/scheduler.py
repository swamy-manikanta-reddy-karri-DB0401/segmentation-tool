"""In-process scheduler: starts due syncs and raises stale-sync alerts."""
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from .db import Alert, SessionLocal, Sync, SyncRun
from .health import alert_cfg, is_due, is_stale, raise_alert, sched
from .sync import run_sync

_stop = threading.Event()
_pool = ThreadPoolExecutor(max_workers=4)
TICK_SECONDS = 20


def tick() -> None:
    now = datetime.utcnow()
    with SessionLocal() as db:
        for sync in db.query(Sync).all():
            if sched(sync)["type"] == "manual":
                continue
            runs = db.query(SyncRun).filter_by(sync_id=sync.id).order_by(SyncRun.id.desc())
            last = runs.first()
            if last and last.status in ("queued", "running"):
                continue
            last_sched = runs.filter(SyncRun.trigger == "schedule").first()
            if is_due(sync, last, last_sched, now):
                run = SyncRun(sync_id=sync.id, trigger="schedule")
                db.add(run)
                db.commit()
                _pool.submit(run_sync, run.id)
            elif alert_cfg(sync)["on_stale"] and is_stale(sync, last, now):
                open_stale = db.query(Alert).filter_by(sync_id=sync.id, kind="stale", acknowledged_at=None).first()
                if not open_stale:
                    raise_alert(db, sync, None, "stale", "critical", "Scheduled sync hasn't run within its expected window")


def _loop() -> None:
    while not _stop.wait(TICK_SECONDS):
        try:
            tick()
        except Exception as e:  # noqa: BLE001 - keep the scheduler alive
            print("scheduler error:", e)


def start() -> None:
    _stop.clear()
    threading.Thread(target=_loop, daemon=True, name="scheduler").start()


def stop() -> None:
    _stop.set()
