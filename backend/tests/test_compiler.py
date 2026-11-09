import pytest

from app.compiler import Compiler, CompileError

PARENT = {
    "id": 1, "kind": "parent", "name": "users", "table_ref": "samples.wanderbricks.users", "primary_key": "user_id",
    "columns": [
        {"name": "user_id", "type": "number"}, {"name": "country", "type": "string"},
        {"name": "is_business", "type": "boolean"}, {"name": "created_at", "type": "timestamp"},
    ],
}
BOOKINGS = {
    "id": 2, "kind": "related", "name": "bookings", "table_ref": "samples.wanderbricks.bookings",
    "foreign_key": "user_id", "timestamp_column": "created_at",
    "columns": [{"name": "user_id", "type": "number"}, {"name": "status", "type": "string"},
                {"name": "total_amount", "type": "number"}, {"name": "created_at", "type": "timestamp"}],
}
CLICKS = {
    "id": 3, "kind": "event", "name": "clickstream", "table_ref": "samples.wanderbricks.clickstream",
    "foreign_key": "user_id", "timestamp_column": "timestamp", "event_name_column": "event",
    "columns": [{"name": "user_id", "type": "number"}, {"name": "event", "type": "string"},
                {"name": "metadata.device", "type": "string"}, {"name": "timestamp", "type": "timestamp"}],
}
SCHEMA = {"parent": PARENT, "models": {2: BOOKINGS, 3: CLICKS}}


def compile_(conditions, op="and", **kw):
    return Compiler(SCHEMA, **kw).compile({"type": "group", "op": op, "conditions": conditions})


def test_property_values_are_parameterized():
    c = compile_([{"type": "property", "column": "country", "operator": "in", "values": ["India", "x'); DROP TABLE t;--"]}])
    assert "DROP" not in c.sql
    assert "lower(p.`country`) IN (lower(:p0), lower(:p1))" in c.sql
    assert c.params[1]["value"] == "x'); DROP TABLE t;--"


def test_unknown_column_rejected():
    with pytest.raises(CompileError):
        compile_([{"type": "property", "column": "secret`; DROP", "operator": "is_null"}])


def test_relation_count_and_sum():
    c = compile_([{
        "type": "relation", "model_id": 2,
        "filter": {"type": "group", "op": "and", "conditions": [{"type": "property", "column": "status", "operator": "equals", "value": "confirmed"}]},
        "time_window": {"type": "within_last", "amount": 6, "unit": "month"},
        "aggregate": {"fn": "sum", "column": "total_amount", "operator": "gt", "value": 1000},
    }], as_of="2025-07-31")
    assert "SUM(r.`total_amount`)" in c.sql
    assert "INTERVAL 6 MONTH" in c.sql
    assert "TIMESTAMP'2025-07-31 23:59:59'" in c.sql
    assert "EXISTS (SELECT 1 FROM bookings_1 c WHERE c.__k0 = p.`user_id` AND c.__v > :p1)" in c.sql


def test_did_not_event_includes_people_without_rows():
    c = compile_([{"type": "event", "model_id": 3, "did": False, "event_names": ["click"],
                   "time_window": {"type": "within_last", "amount": 7, "unit": "day"}}])
    assert "NOT EXISTS (SELECT 1 FROM clickstream_1 c WHERE c.__k0 = p.`user_id` AND NOT (c.__v = :p1))" in c.sql


def test_frequency_less_than_includes_zero():
    c = compile_([{"type": "event", "model_id": 3, "frequency": {"operator": "lt", "value": 3}}])
    assert "NOT EXISTS" in c.sql


def test_struct_field_in_event_filter():
    c = compile_([{"type": "event", "model_id": 3, "filter": {"type": "group", "op": "and", "conditions": [
        {"type": "property", "column": "metadata.device", "operator": "equals", "value": "mobile"}]}}])
    assert "e.`metadata`.`device`" in c.sql


def test_sequence_not_followed_by():
    c = compile_([{"type": "sequence", "first": {"model_id": 3, "event_names": ["view"]},
                   "then": {"model_id": 2}, "did_then": False, "within": {"amount": 2, "unit": "week"}}])
    assert "LEFT ANTI JOIN" in c.sql
    assert "INTERVAL 14 DAY" in c.sql


def test_nested_or_group_and_date_between():
    c = compile_([
        {"type": "group", "op": "or", "conditions": [
            {"type": "property", "column": "is_business", "operator": "is_true"},
            {"type": "property", "column": "created_at", "operator": "between", "value": "2024-01-01", "value2": "2024-12-31"},
        ]},
    ])
    assert " OR " in c.sql and "INTERVAL 1 DAY" in c.sql


def test_audience_reference_and_cycle_guard():
    defs = {10: {"type": "group", "op": "and", "conditions": [{"type": "property", "column": "country", "operator": "equals", "value": "India"}]},
            11: {"type": "group", "op": "and", "conditions": [{"type": "audience", "audience_id": 11}]}}
    c = Compiler(SCHEMA, load_audience=defs.__getitem__).compile(
        {"type": "group", "op": "and", "conditions": [{"type": "audience", "audience_id": 10, "included": False}]})
    assert "p.`user_id` NOT IN (SELECT p1.`user_id`" in c.sql
    with pytest.raises(CompileError):
        Compiler(SCHEMA, load_audience=defs.__getitem__).compile(defs[11])


def test_bad_interval_rejected():
    with pytest.raises(CompileError):
        compile_([{"type": "event", "model_id": 3, "time_window": {"type": "within_last", "amount": "1; DROP", "unit": "day"}}])


def test_hightouch_string_operators_and_null_setting():
    neq = {"type": "property", "column": "country", "operator": "not_equals", "values": ["India"]}
    assert "(p.`country` IS NULL OR NOT (" in compile_([neq]).sql                      # nulls match
    assert "(p.`country` IS NOT NULL AND NOT (" in compile_([neq], null_matches_negation=False).sql
    c = compile_([{"type": "property", "column": "country", "operator": "not_starts_with", "values": ["In"]},
                  {"type": "property", "column": "country", "operator": "exists_not_empty"}])
    assert "startswith(lower(CAST(p.`country` AS STRING))" in c.sql and "trim(CAST(p.`country` AS STRING)) <> ''" in c.sql


def test_boolean_equals():
    c = compile_([{"type": "property", "column": "is_business", "operator": "equals", "values": ["true"]}])
    assert "p.`is_business` = :p0" in c.sql and c.params[0] == {"name": "p0", "type": "BOOLEAN", "value": "True"}


def test_calendar_and_rolling_windows():
    base = {"type": "property", "column": "created_at", "operator": "within", "amount": 2, "unit": "month"}
    rolling = compile_([{**base, "direction": "previous"}], as_of="2025-06-03").sql
    assert "p.`created_at` AS TIMESTAMP) >= TIMESTAMP'2025-06-03 23:59:59' - INTERVAL 2 MONTH" in rolling
    cal = compile_([{**base, "direction": "previous", "calendar": True}], as_of="2025-06-03").sql
    assert "date_trunc('MONTH', TIMESTAMP'2025-06-03 23:59:59') - INTERVAL 2 MONTH" in cal
    nw = compile_([{**base, "operator": "not_within", "direction": "previous"}]).sql
    assert "IS NOT NULL AND NOT (" in nw


def test_anniversary():
    c = compile_([{"type": "property", "column": "created_at", "operator": "anniversary", "direction": "next", "amount": 7}],
                 as_of="2025-02-27")
    assert "add_months(CAST(p.`created_at` AS DATE), 12 * (year(DATE'2025-02-27')" in c.sql
    assert "BETWEEN 0 AND 7" in c.sql


def test_event_then_did_not_perform():
    c = compile_([{"type": "event", "model_id": 3, "did": True, "event_names": ["view"],
                   "frequency": {"operator": "gte", "value": 2},
                   "then": {"did": False, "model_id": 2, "within": {"amount": 1, "unit": "day"}}}])
    assert "LEFT ANTI JOIN `samples`.`wanderbricks`.`bookings` b ON b.`user_id` = e.`user_id`" in c.sql
    assert "INTERVAL 1 DAY" in c.sql and "c.__v >= :p1" in c.sql


def test_legacy_operators_still_compile():
    c = compile_([{"type": "property", "column": "created_at", "operator": "within_last", "amount": 30, "unit": "day"},
                  {"type": "property", "column": "is_business", "operator": "is_true"},
                  {"type": "sequence", "first": {"model_id": 3}, "then": {"model_id": 2}, "did_then": True}])
    assert "INTERVAL 30 DAY" in c.sql and "LEFT SEMI JOIN" in c.sql


def test_funnel_counts_each_top_level_condition():
    c = Compiler(SCHEMA).funnel({"type": "group", "op": "and", "conditions": [
        {"type": "property", "column": "country", "operator": "equals", "values": ["India"]},
        {"type": "property", "column": "is_business", "operator": "equals", "values": [True]}]})
    assert c.sql.count("COUNT_IF(") == 2 and c.sql.startswith("SELECT COUNT(*)")


def _schema_with(**extra):
    import copy
    s = copy.deepcopy(SCHEMA)
    for k, v in extra.items():
        s[k] = v
    return s


def test_multi_key_join_and_sql_model():
    s = _schema_with()
    s["models"][2] = {**BOOKINGS, "query_type": "sql", "sql": "SELECT * FROM x.y.z WHERE ok",
                      "join_keys": [{"parent": "user_id", "model": "user_id"}, {"parent": "country", "model": "status"}]}
    c = Compiler(s).compile({"type": "group", "op": "and", "conditions": [{"type": "relation", "model_id": 2}]})
    assert "FROM (SELECT * FROM x.y.z WHERE ok) r" in c.sql
    assert "GROUP BY r.`user_id`, r.`status`" in c.sql and "c.__k1 = p.`country`" in c.sql


def test_traits_saved_inline_and_formula():
    traits = {7: {"id": 7, "name": "LTV", "method": "aggregation", "config": {"model_id": 2, "fn": "sum", "column": "total_amount"}},
              8: {"id": 8, "name": "Tier", "method": "sql_formula", "config": {"formula": "CASE WHEN {{trait \"LTV\"}} > 1000 THEN 'high' ELSE 'low' END", "result_type": "string"}},
              9: {"id": 9, "name": "Fav", "method": "occurrence", "config": {"model_id": 3, "occurrence": "most_frequent", "column": "event"}}}
    s = _schema_with(traits=traits)
    c = Compiler(s).compile({"type": "group", "op": "and", "conditions": [
        {"type": "property", "column": "trait.7", "operator": "gt", "value": 500},
        {"type": "property", "column": "trait.8", "operator": "equals", "values": ["high"]},
        {"type": "property", "column": "trait.9", "operator": "equals", "values": ["click"]},
        {"type": "trait", "inline": {"method": "count", "model_id": 2}, "operator": "gte", "value": 2}]})
    assert c.sql.count("trait_7 AS (") == 1                     # saved trait CTE reused by the formula
    assert "SUM(t.`total_amount`) AS v" in c.sql and "max_by(val, n)" in c.sql
    assert "coalesce((SELECT first(c.v) FROM inline_trait_" in c.sql


def test_merged_columns_privacy_case_and_compare():
    s = _schema_with()
    s["models"][2] = {**BOOKINGS, "merge_columns": ["status"], "join_keys": [{"parent": "user_id", "model": "user_id"}]}
    s["parent"] = {**PARENT, "column_settings": {"country": {"case_sensitive": True}, "is_business": {"privacy": "blocked"}}}
    c = Compiler(s).compile({"type": "group", "op": "and", "conditions": [
        {"type": "property", "column": "merged.2.status", "operator": "equals", "values": ["confirmed"]},
        {"type": "property", "column": "country", "operator": "equals", "values": ["India"]},
        {"type": "property", "column": "created_at", "operator": "gt", "compare": {"column": "created_at"}}]})
    assert "(SELECT first(x.`status`) FROM `samples`.`wanderbricks`.`bookings` x WHERE x.`user_id` = p.`user_id`)" in c.sql
    assert "p.`country` IN (:p" in c.sql and "lower(p.`country`)" not in c.sql
    assert "p.`created_at` > p.`created_at`" in c.sql
    with pytest.raises(CompileError, match="privacy"):
        Compiler(s).compile({"type": "group", "op": "and", "conditions": [{"type": "property", "column": "is_business", "operator": "exists"}]})


def test_split_groups():
    node = {"type": "split", "audience_id": 4, "groups": [{"name": "A", "percent": 80}, {"name": "B", "percent": 20}], "group": "B"}
    sql = compile_([node]).sql
    assert "pmod(xxhash64(CAST(p.`user_id` AS STRING), 'audience-4'), 100) >= 80" in sql
    with pytest.raises(CompileError):
        compile_([{**node, "groups": [{"name": "A", "percent": 50}]}])
