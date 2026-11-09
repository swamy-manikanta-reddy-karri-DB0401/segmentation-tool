"""Sync engine: run a segment query on the source and push members to Sailthru."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from .connectors import get_source
from .db import Connection, Model, Segment, SessionLocal, Sync, SyncMember, SyncRejection, SyncRun
from .health import alert_cfg, raise_alert
from .modelctx import model_ctx
from .privacy import sync_problems
from .rules import build_select
from .sailthru import Sailthru

CANCELS: dict[int, threading.Event] = {}  # run_id -> cancel flag for in-flight runs
MAX_REJECTIONS = 1000


class SyncAbort(Exception):
    """A run that stops before pushing anything (bad config, blocked by thresholds)."""


def identifier_column(sync: Sync, model: Model) -> str:
    return sync.match_column or model.email_column


def check_config(sync_like: dict, model: Model) -> None:
    """Shared by create/update and run: identifier present, mapping passes the field guard."""
    ident = sync_like.get("match_column") or model.email_column
    if not ident:
        raise SyncAbort(f"Model '{model.name}' has no email column; choose a match column for the sync")
    mapped = [m["source"] for m in sync_like.get("mapping", []) if m.get("source")]
    problems = sync_problems(model, mapped)
    if problems:
        raise SyncAbort("Field guard: " + "; ".join(problems))
    if sync_like.get("action", "add_to_list") == "add_to_list" and not sync_like.get("list_name"):
        raise SyncAbort("A Sailthru list name is required for 'add to list'")


def run_sync(run_id: int) -> None:
    db = SessionLocal()
    run = db.get(SyncRun, run_id)
    cancel = CANCELS[run_id] = threading.Event()
    log: list[str] = []
    rejections: list[tuple[str, str]] = []
    flags: list[str] = []
    sync = db.get(Sync, run.sync_id)
    try:
        if run.status == "cancelled":  # cancelled while queued
            return
        run.status = "running"
        db.commit()
        seg = db.get(Segment, sync.segment_id)
        model = db.get(Model, seg.model_id)
        src = get_source(db.get(Connection, model.source_id))
        cfg = db.get(Connection, sync.destination_id).config
        st = Sailthru(cfg.get("api_key", ""), cfg.get("api_secret", ""), bool(cfg.get("dry_run", True)))
        run.dry_run = int(st.dry_run)
        alerts = alert_cfg(sync)
        deadline = time.time() + max(sync.timeout_minutes or 30, 1) * 60

        check_config({"match_column": sync.match_column, "mapping": sync.mapping, "action": sync.action, "list_name": sync.list_name}, model)
        ctx = model_ctx(db, model, src)
        mapping = [m for m in sync.mapping if m.get("source") in ctx.columns and m.get("target")]
        ident_col = identifier_column(sync, model)
        select_cols = list(dict.fromkeys([ident_col] + [m["source"] for m in mapping]))
        sql, params = build_select(model.table_name, select_cols, seg.filter, ctx)
        names, rows = src.run(sql, params)
        idx = {n: i for i, n in enumerate(names)}

        members: dict[str, dict] = {}
        skipped_blank = 0
        for r in rows:
            ident = r[idx[ident_col]]
            if ident is None or not str(ident).strip():
                skipped_blank += 1
                continue
            ident = str(ident).strip()
            if sync.match_key == "email":
                ident = ident.lower()
            members[ident] = {m["target"]: r[idx[m["source"]]] for m in mapping}
        run.matched = len(members)
        log.append(f"Query returned {len(rows)} rows, {len(members)} with a usable {sync.match_key} identifier")
        if skipped_blank:
            log.append(f"{skipped_blank} rows skipped: blank {ident_col}")

        # row-count thresholds (alert trigger; optionally a safety stop)
        prev = (
            db.query(SyncRun).filter(SyncRun.sync_id == sync.id, SyncRun.id < run.id, SyncRun.status.in_(["success", "warning"]))
            .order_by(SyncRun.id.desc()).first()
        )
        n = len(members)
        if alerts["min_rows"] is not None and n < alerts["min_rows"]:
            flags.append(f"Row count {n:,} is below the minimum of {alerts['min_rows']:,}")
        if alerts["max_rows"] is not None and n > alerts["max_rows"]:
            flags.append(f"Row count {n:,} is above the maximum of {alerts['max_rows']:,}")
        if alerts["max_change_pct"] is not None and prev and prev.matched:
            change = abs(n - prev.matched) * 100 / prev.matched
            if change > alerts["max_change_pct"]:
                flags.append(f"Row count changed {change:.0f}% since the last run ({prev.matched:,} -> {n:,}), limit {alerts['max_change_pct']}%")
        if flags and alerts["block_on_threshold"]:
            raise SyncAbort("Blocked by row-count threshold: " + "; ".join(flags))

        track = sync.action == "add_to_list"
        previous = {m.email for m in db.query(SyncMember).filter_by(sync_id=sync.id)} if track else set()
        to_remove = sorted(previous - set(members)) if track and sync.mode == "mirror" else []
        jobs = [(i, v, True) for i, v in members.items()] + [(i, {}, False) for i in to_remove]
        run.total = len(jobs)
        db.commit()

        def push(job):
            ident, variables, subscribed = job
            if cancel.is_set() or time.time() > deadline:
                return job, "skipped", ""
            try:
                res = st.push(sync.action, ident, sync.match_key, variables, sync.list_name, subscribed)
                if st.dry_run and len(log) < 6:
                    log.append(f"[dry-run] {res['payload']}")
                return job, "ok", ""
            except Exception as e:  # noqa: BLE001
                return job, "rejected", str(e)

        added_ok, removed_ok, skipped = set(), set(), 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            for job, outcome, reason in pool.map(push, jobs):
                if outcome == "ok":
                    (added_ok if job[2] else removed_ok).add(job[0])
                elif outcome == "rejected":
                    rejections.append((job[0], reason))
                else:
                    skipped += 1
        run.added, run.removed, run.failed = len(added_ok), len(removed_ok), len(rejections)

        if track:  # membership = who we know is on the list after this run
            db.query(SyncMember).filter_by(sync_id=sync.id).delete()
            for i in (previous - removed_ok) | added_ok:
                db.add(SyncMember(sync_id=sync.id, email=i))

        if skipped and cancel.is_set():
            run.status = "cancelled"
        elif skipped:
            run.status = "timed_out"
        elif rejections and len(rejections) == len(jobs):
            run.status, run.error = "failed", "Every row was rejected by the destination"
        elif rejections:
            run.status = "warning"
        else:
            run.status = "success"
    except SyncAbort as e:
        run.status, run.error = "failed", str(e)
    except Exception as e:  # noqa: BLE001
        run.status, run.error = "failed", str(e)
    finally:
        CANCELS.pop(run_id, None)
        run.finished_at = datetime.utcnow()
        run.flags = "\n".join(flags)
        log += [f"REJECTED {i}: {r}" for i, r in rejections[:10]]
        if run.error:
            log.append(f"ERROR {run.error}")
        run.log = "\n".join(log)
        for i, r in rejections[:MAX_REJECTIONS]:
            db.add(SyncRejection(run_id=run.id, identifier=i, reason=r))
        db.commit()
        _alert(db, sync, run, flags)
        db.close()


def _alert(db, sync: Sync, run: SyncRun, flags: list[str]) -> None:
    cfg = alert_cfg(sync)
    if run.status == "failed" and cfg["on_failure"]:
        raise_alert(db, sync, run, "failed", "critical", run.error or "Sync failed")
    elif run.status == "cancelled" and cfg["on_failure"]:
        raise_alert(db, sync, run, "cancelled", "critical", "Run was cancelled before it finished")
    elif run.status == "timed_out" and cfg["on_failure"]:
        raise_alert(db, sync, run, "timed_out", "critical", f"Run exceeded the {sync.timeout_minutes}-minute timeout")
    elif run.status == "warning" and cfg["on_rejected"]:
        pct = 100 * run.failed / max(run.total, 1)
        raise_alert(db, sync, run, "rejected", "critical" if pct >= cfg["unhealthy_pct"] else "warning",
                    f"{run.failed:,} of {run.total:,} rows ({pct:.0f}%) were rejected by Sailthru")
    for f in flags:
        raise_alert(db, sync, run, "threshold", "warning", f)
