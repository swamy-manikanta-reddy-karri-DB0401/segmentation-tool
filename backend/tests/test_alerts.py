"""Alerting: trigger evaluation, one notification per status change, policy layering, routing, muting."""
from datetime import datetime, timedelta, timezone

import pytest

from app import alerts, config, db


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.sqlite3")
    monkeypatch.setattr(db, "_backend", None)
    monkeypatch.delenv("LAKEBASE_ENDPOINT", raising=False)
    sent = []
    monkeypatch.setattr(alerts, "send", lambda r, s, t, old, new, msg, err: sent.append((r["name"], t, old, new)))
    ts = db.now()
    b = db.insert("brands", {"name": "CNBC", "created_at": ts})
    p = db.insert("models", {"kind": "parent", "name": "Users", "table_ref": "c.s.t", "primary_key": "id", "columns": [], "brand_id": b, "created_at": ts})
    a = db.insert("audiences", {"name": "Fans", "definition": {}, "parent_id": p, "created_at": ts, "updated_at": ts})
    d1 = db.insert("destinations", {"name": "Sailthru", "type": "sailthru", "config": {}, "brand_id": b, "created_at": ts})
    d2 = db.insert("destinations", {"name": "GAM", "type": "gam", "config": {}, "brand_id": b, "created_at": ts})
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat(timespec="seconds")
    s1 = db.insert("syncs", {"name": "Fans → Sailthru", "audience_id": a, "destination_id": d1, "config": {}, "created_at": old})
    s2 = db.insert("syncs", {"name": "Fans → GAM", "audience_id": a, "destination_id": d2, "config": {}, "created_at": old})

    def recipient(name, severity="all", dests=()):
        return db.insert("alert_recipients", {"name": name, "channel": "slack", "config": {"webhook_url": "https://x"}, "severity": severity,
                                              "destination_ids": list(dests), "brand_id": None, "enabled": 1, "created_at": ts})

    def run(sync_id, status="success", failed=0, rows=10, added=1):
        return db.insert("sync_runs", {"sync_id": sync_id, "status": status, "started_at": db.now(), "finished_at": db.now(),
                                       "failed": failed, "audience_rows": rows, "added": added, "changed": 0, "removed": 0,
                                       "error": "boom" if status == "failed" else None})
    return {"s1": s1, "s2": s2, "d1": d1, "d2": d2, "sent": sent, "recipient": recipient, "run": run}


def status(sync_id, trigger):
    r = db.one("SELECT status FROM alerts WHERE sync_id = ? AND trigger = ?", (sync_id, trigger))
    return r["status"] if r else "healthy"


def test_one_notification_per_status_change(env):
    env["recipient"]("ops")
    for _ in range(3):  # three failures in a row → one CRITICAL notification
        alerts.after_run(env["s1"], env["run"](env["s1"], "failed"))
    assert status(env["s1"], "fatal") == "critical"
    alerts.after_run(env["s1"], env["run"](env["s1"]))  # recovery
    assert status(env["s1"], "fatal") == "healthy"
    assert env["sent"] == [("ops", "fatal", "healthy", "critical"), ("ops", "fatal", "critical", "healthy")]
    assert [e["new_status"] for e in db.query("SELECT new_status FROM alert_events ORDER BY id")] == ["critical", "healthy"]


def test_rejected_threshold_and_audience_minimum(env):
    alerts.save_policy("destination", env["d1"], {"rejected": {"min_rows": 5}, "audience": {"enabled": True, "min_rows": 100}}, None)
    alerts.after_run(env["s1"], env["run"](env["s1"], "completed_with_errors", failed=3, rows=50))
    assert status(env["s1"], "rejected") == "healthy"  # 3 < 5
    assert status(env["s1"], "audience") == "warning"  # 50 < 100
    alerts.after_run(env["s1"], env["run"](env["s1"], "completed_with_errors", failed=7, rows=150))
    assert status(env["s1"], "rejected") == "warning" and status(env["s1"], "audience") == "healthy"


def test_sync_override_beats_destination_default(env):
    alerts.save_policy("destination", env["d1"], {"fatal": {"severity": "warning"}}, None)
    eff = alerts.effective("sync", env["s1"])["triggers"]["fatal"]
    assert eff["severity"] == "warning" and eff["source"] == "destination"
    alerts.save_policy("sync", env["s1"], {"fatal": {"severity": "critical"}}, None)
    eff = alerts.effective("sync", env["s1"])["triggers"]["fatal"]
    assert eff["severity"] == "critical" and eff["source"] == "sync"
    assert alerts.effective("sync", env["s2"])["triggers"]["fatal"]["source"] == "default"


def test_routing_by_severity_and_destination(env):
    env["recipient"]("everything")
    env["recipient"]("pager", severity="critical")
    env["recipient"]("gam team", dests=[env["d2"]])
    alerts.after_run(env["s1"], env["run"](env["s1"], "completed_with_errors", failed=2))  # WARNING on Sailthru
    assert {n for n, *_ in env["sent"]} == {"everything"}
    env["sent"].clear()
    alerts.after_run(env["s2"], env["run"](env["s2"], "failed"))  # CRITICAL on GAM
    assert {n for n, *_ in env["sent"]} == {"everything", "pager", "gam team"}


def test_mute_records_but_does_not_notify(env):
    env["recipient"]("ops")
    alerts.mute(env["s1"], "fatal", 60)
    alerts.after_run(env["s1"], env["run"](env["s1"], "failed"))
    assert status(env["s1"], "fatal") == "critical" and env["sent"] == []
    assert db.one("SELECT muted FROM alert_events")["muted"] == 1
    alerts.unmute(env["s1"], "fatal")
    alerts.after_run(env["s1"], env["run"](env["s1"]))
    assert env["sent"] == [("ops", "fatal", "critical", "healthy")]


def test_nothing_delivered_for_days(env):
    alerts.evaluate_periodic()
    assert status(env["s1"], "throughput") == "warning"  # created 30 days ago, never delivered
    alerts.after_run(env["s1"], env["run"](env["s1"], added=5))
    assert status(env["s1"], "throughput") == "healthy"


def test_webhook_payload_matches_hightouch_shape(env):
    sync = alerts._sync(env["s1"])
    p = alerts.payload(sync, "rejected", "healthy", "warning", "2 records rejected", "bad email")
    assert p["resourceType"] == "Sync" and p["newStatus"] == "WARNING" and p["oldStatus"] == "HEALTHY"
    assert p["trigger"] == {"displayName": "Rejected records", "status": "WARNING", "displayMessage": "2 records rejected", "error": "bad email"}


def test_recipient_validation_and_masking():
    with pytest.raises(ValueError, match="Slack"):
        alerts.validate_recipient({"name": "x", "channel": "slack", "config": {"webhook_url": "nope"}})
    r = alerts.validate_recipient({"name": "Pager", "channel": "pagerduty", "config": {"routing_key": "R" * 32}, "severity": "critical"})
    masked = alerts.mask({**r, "id": 1})
    assert masked["config"]["routing_key"] == "••••••••"
    kept = alerts.validate_recipient({"config": {"routing_key": "••••••••"}}, {**r, "id": 1})
    assert kept["config"]["routing_key"] == "R" * 32
