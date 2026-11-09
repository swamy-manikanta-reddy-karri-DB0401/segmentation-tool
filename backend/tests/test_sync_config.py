import pytest

from app.destinations import Sailthru, Webhook
from app.sync_engine import SyncError, build_query, normalize_config, validate_config
from tests.test_compiler import BOOKINGS, PARENT

SCHEMA = {"parent": {**PARENT, "columns": PARENT["columns"] + [{"name": "email", "type": "string"}]},
          "models": {2: {**BOOKINGS, "primary_key": "booking_id",
                         "columns": BOOKINGS["columns"] + [{"name": "booking_id", "type": "number"}]}}}


def test_legacy_config_is_translated():
    cfg = normalize_config({"mapping": [], "mode": "mirror"}, Webhook)
    assert (cfg["sync_type"], cfg["mode"], cfg["delete_behavior"]) == ("default", "upsert", "remove")
    cfg = normalize_config({"mapping": [], "mode": "upsert"}, Webhook)
    assert cfg["delete_behavior"] == "do_nothing"


def test_sailthru_users_requires_matching_and_respects_mode_rules():
    base = {"sync_type": "users", "mode": "upsert", "mapping": [{"source": "country", "target": "country"}]}
    with pytest.raises(SyncError, match="record matching"):
        validate_config(base, Sailthru, SCHEMA)
    with pytest.raises(SyncError, match="only works in update"):
        validate_config({**base, "match": {"source": "user_id", "field": "sid"}}, Sailthru, SCHEMA)
    cfg = validate_config({**base, "match": {"source": "email", "field": "email"}, "delete_behavior": "clear"},
                          Sailthru, SCHEMA)
    assert cfg["delete_behavior"] == "clear"


def test_event_sync_needs_table_and_maps_customer_columns():
    cfg = {"sync_type": "purchases", "mode": "insert", "model_id": 2, "match": {"source": "customer.email", "field": "email"},
           "mapping": [{"source": "booking_id", "target": "item_id"}]}
    with pytest.raises(SyncError, match="required fields"):
        validate_config(cfg, Sailthru, SCHEMA)
    full = {**cfg, "mapping": [{"source": s, "target": t} for s, t in [
        ("booking_id", "item_id"), ("status", "item_title"), ("total_amount", "item_price"),
        ("booking_id", "item_qty"), ("status", "item_url")]]}
    ok = validate_config(full, Sailthru, SCHEMA)
    assert ok["delete_behavior"] == "do_nothing"
    with pytest.raises(SyncError, match="isn't available"):
        validate_config({**full, "mapping": full["mapping"] + [{"source": "email", "target": "x"}]}, Sailthru, SCHEMA)


def test_event_sync_query_joins_event_table_to_audience():
    cfg = validate_config({"sync_type": "custom_events", "mode": "insert", "model_id": 2,
                           "match": {"source": "customer.email", "field": "email"},
                           "mapping": [{"source": "status", "target": "status"}], "options": {"event_name": "booked"}},
                          Sailthru, SCHEMA)
    q = build_query(cfg, Sailthru.get_sync_type("custom_events"), SCHEMA, {"type": "group", "op": "and", "conditions": []})
    assert "FROM `samples`.`wanderbricks`.`bookings` e JOIN `samples`.`wanderbricks`.`users` p ON e.`user_id` = p.`user_id`" in q.sql
    assert "CAST(e.`booking_id` AS STRING) AS __pk" in q.sql and "'m', CAST(p.`email` AS STRING)" in q.sql


def test_advanced_mapping_validation_and_query():
    base = {"sync_type": "users", "mode": "upsert", "match": {"source": "email", "field": "email"}}
    cfg = validate_config({**base, "mapping": [
        {"target": "tier", "type": "static", "value": "gold"},
        {"target": "greeting", "type": "template", "template": "Hi {{ row.country | upcase }}"},
        {"target": "run", "type": "variable", "variable": "sync-run-id"}]}, Sailthru, SCHEMA)
    q = build_query(cfg, Sailthru.get_sync_type("users"), SCHEMA, {"type": "group", "op": "and", "conditions": []})
    assert "'r', named_struct('country', p.`country`)" in q.sql and "'f', map()" in q.sql
    with pytest.raises(SyncError, match="unknown columns"):
        validate_config({**base, "mapping": [{"target": "x", "type": "template", "template": "{{ row.nope }}"}]}, Sailthru, SCHEMA)
