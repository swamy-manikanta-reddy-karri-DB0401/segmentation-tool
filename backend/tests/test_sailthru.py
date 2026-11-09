import json
from email.parser import BytesParser
from email.policy import default
from urllib.parse import parse_qs

import httpx
import pytest

from app.destinations import sailthru
from app.destinations.sailthru import Sailthru, sign


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(sailthru.time, "sleep", lambda s: None)


def test_signature_matches_docs_example_and_official_client():
    params = {"api_key": "123key", "format": "json", "json": '{"id":"neil@example.com"}'}
    assert sign("abcsecret", params) == "fa5c79189b708199f3cf69f1cf8f7928"
    # Official client sorts parameter VALUES (not names): "b..." sorts before "json".
    import hashlib
    p = {"api_key": "zzz", "format": "json", "json": "{}"}
    assert sign("s", p) == hashlib.md5(b"sjsonzzz{}").hexdigest()


def parse(request: httpx.Request) -> tuple[dict, bytes | None]:
    """Return (signed form/query params, uploaded file bytes) and verify the signature."""
    if request.method in ("GET", "DELETE"):
        form = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        file = None
    elif request.headers["content-type"].startswith("multipart/"):
        msg = BytesParser(policy=default).parsebytes(
            b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content)
        form, file = {}, None
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if name == "file":
                file = part.get_payload(decode=True)
            else:
                form[name] = part.get_content()
    else:
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        file = None
    assert form["sig"] == sign("s", {k: v for k, v in form.items() if k != "sig"})
    return json.loads(form["json"]), file


def make(handler, sync_type="users", mode="upsert", match="email", **options):
    d = Sailthru({"api_key": "k", "secret": "s"},
                 {"sync_type": sync_type, "mode": mode, "match_field": match, "options": options})
    d.http = httpx.Client(base_url=sailthru.API, transport=httpx.MockTransport(handler))
    return d


def row(id_, match, **fields):
    return {"id": id_, "match": match, "group": fields.pop("_group", None), "fields": fields}


def test_realtime_upsert_sends_vars_and_list():
    seen = []

    def handler(req):
        seen.append((req.method, req.url.path, parse(req)[0]))
        return httpx.Response(200, json={"ok": True})

    d = make(handler, send_method="realtime", list_name="VIP")
    assert d.upsert([row("1", "a@x.com", country="India"), row("2", None)]) == {"2": "Missing email"}
    assert seen == [("POST", "/user", {"id": "a@x.com", "key": "email", "vars": {"country": "India"}, "lists": {"VIP": 1}})]


def test_update_mode_only_updates_existing_users_by_sid():
    def handler(req):
        payload, _ = parse(req)
        if req.method == "GET":
            if payload["id"] == "missing":
                return httpx.Response(400, json={"error": 99, "errormsg": "User not found with sid: missing"})
            return httpx.Response(200, json={"keys": {"sid": payload["id"]}})
        assert payload["key"] == "sid"
        return httpx.Response(200, json={"ok": True})

    d = make(handler, mode="update", match="sid")
    failures = d.upsert([row("1", "abc", plan="gold"), row("2", "missing", plan="gold")])
    assert list(failures) == ["2"] and "update mode only updates existing users" in failures["2"]


def test_bulk_upsert_uploads_json_lines_job_and_waits():
    calls = []

    def handler(req):
        payload, file = parse(req)
        calls.append((req.method, req.url.path, payload))
        if req.method == "POST":
            lines = [json.loads(x) for x in file.decode().splitlines()]
            assert payload == {"job": "update"}
            assert lines == [{"id": "a@x.com", "vars": {"tier": "gold"}, "lists": {"VIP": 1}}]
            return httpx.Response(200, json={"job_id": "j1", "status": "pending"})
        statuses = {1: "running", 2: "completed"}
        return httpx.Response(200, json={"status": statuses[len(calls) - 1]})

    d = make(handler, list_name="VIP")  # send_method defaults to bulk
    assert d.batch_size_for_run() == 100000
    assert d.upsert([row("1", "a@x.com", tier="gold")]) == {}
    assert [c[1] for c in calls] == ["/job", "/job", "/job"]


def test_bulk_job_error_rejects_batch():
    def handler(req):
        if req.method == "POST":
            return httpx.Response(200, json={"job_id": "j2"})
        return httpx.Response(200, json={"status": "incomplete"})

    failures = make(handler).upsert([row("1", "a@x.com"), row("2", "b@x.com")])
    assert set(failures) == {"1", "2"} and "incomplete" in failures["1"]


def test_clear_deletes_mapped_vars_with_job_update():
    sent = {}

    def handler(req):
        payload, file = parse(req)
        if req.method == "POST":
            sent["payload"], sent["lines"] = payload, file.decode().splitlines()
            return httpx.Response(200, json={"job_id": "j3"})
        return httpx.Response(200, json={"status": "completed"})

    assert make(handler).clear([row("1", "a@x.com", tier="gold", country="IN")]) == {}
    assert sent["payload"] == {"job": "update", "update": {"delete_vars": ["country", "tier"]}}
    assert sent["lines"] == ['{"id":"a@x.com"}']
    assert "Email matching" in make(handler, mode="update", match="sid").clear([row("1", "abc", tier="g")])["1"]


def test_delete_behavior_deletes_users():
    seen = []

    def handler(req):
        seen.append((req.method, parse(req)[0]))
        return httpx.Response(200, json={"ok": True})

    assert make(handler).remove([row("1", "a@x.com")]) == {}
    assert seen == [("DELETE", {"id": "a@x.com", "key": "email"})]


def test_custom_events_use_option_name_and_report_errors():
    def handler(req):
        payload, _ = parse(req)
        if payload["event"] == "purchase":
            return httpx.Response(400, json={"error": 99, "errormsg": "Reserved event name"})
        assert payload == {"id": "a@x.com", "key": "email", "event": "viewed_property", "vars": {"city": "Goa"}}
        return httpx.Response(200, json={"ok": True})

    d = make(handler, sync_type="custom_events", mode="insert", event_name="viewed_property")
    assert d.upsert([row("e1", "a@x.com", city="Goa")]) == {}
    bad = d.upsert([row("e2", "a@x.com", event="purchase")])
    assert bad == {"e2": "Sailthru error 99: Reserved event name"}


def test_purchases_grouped_into_orders_with_dollar_conversion():
    orders = []

    def handler(req):
        orders.append(parse(req)[0])
        return httpx.Response(200, json={"ok": True})

    d = make(handler, sync_type="purchases", mode="insert", group_by="order_id", price_unit="dollars")
    item = dict(item_qty=1, item_title="Room", item_id="R1", item_url="https://x/r1")
    rows = [row("l1", "a@x.com", _group="o1", item_price=10.99, date="2025-07-01", **item),
            row("l2", "a@x.com", _group="o1", item_price=5, **item),
            row("l3", "b@x.com", _group="o2", item_price=1, **item)]
    assert d.upsert(rows) == {}
    by_email = {o["email"]: o for o in orders}
    assert [i["price"] for i in by_email["a@x.com"]["items"]] == [1099, 500]
    assert by_email["a@x.com"]["date"] == "2025-07-01" and len(by_email["b@x.com"]["items"]) == 1


def test_returns_payload():
    seen = []
    d = make(lambda r: seen.append(parse(r)[0]) or httpx.Response(200, json={}), sync_type="returns", mode="insert")
    d.upsert([row("r1", "a@x.com", item_qty=1, item_price=1099, item_url="https://x/1", item_order_id="o1")])
    assert seen == [{"email": "a@x.com", "items": [{"qty": 1, "price": 1099, "url": "https://x/1", "order_id": "o1"}]}]


def test_rate_limit_is_retried():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, json={"error": 43, "errormsg": "Too many requests"})
        return httpx.Response(200, json={})

    assert make(handler, send_method="realtime", concurrency=1).upsert([row("1", "a@x.com")]) == {}
    assert calls["n"] == 2
