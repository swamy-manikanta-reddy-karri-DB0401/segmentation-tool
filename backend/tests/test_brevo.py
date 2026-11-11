import json

import httpx
import pytest

from app.destinations import brevo as brevo_mod
from app.destinations.brevo import Brevo


@pytest.fixture(autouse=True)
def no_waits(monkeypatch):
    monkeypatch.setattr(brevo_mod, "PROCESS_POLL_SECONDS", 0)
    monkeypatch.setattr(brevo_mod.time, "sleep", lambda s: None)


def row(i, email, **fields):
    return {"id": str(i), "match": email, "fields": fields}


def dest(handler, sync_type="contacts", mode="upsert", match="email", **options):
    d = Brevo({"api_key": "xkeysib-test", "requests_per_second": 1000},
              {"sync_type": sync_type, "mode": mode, "match_field": match, "options": dict(options)})
    d.http = httpx.Client(base_url=brevo_mod.API, transport=httpx.MockTransport(handler), headers={"api-key": "xkeysib-test"})
    return d


def test_test_uses_account_endpoint_and_api_key_header():
    def handler(req):
        assert req.url.path == "/v3/account" and req.headers["api-key"] == "xkeysib-test"
        return httpx.Response(200, json={"email": "ops@example.com", "companyName": "Acme"})
    assert "ops@example.com" in dest(handler).test()


def test_upsert_creates_with_update_enabled_and_capitalised_attributes():
    seen = []

    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(201, json={"id": 1})
    assert dest(handler).upsert([row(1, "a@x.com", firstname="Ann", lastname=None)]) == {}
    assert seen == [{"email": "a@x.com", "attributes": {"FIRSTNAME": "Ann"}, "updateEnabled": True}]


def test_insert_reports_existing_contact():
    d = dest(lambda r: httpx.Response(400, json={"code": "duplicate_parameter", "message": "Contact already exist"}), mode="insert")
    errors = d.upsert([row(1, "a@x.com")])
    assert "insert mode only creates" in errors["1"]


def test_update_by_contact_id_uses_identifier_type_and_reports_missing():
    seen = []

    def handler(req):
        seen.append((req.method, req.url.path, req.url.params.get("identifierType")))
        return httpx.Response(404, json={"code": "document_not_found", "message": "Contact does not exist"})
    errors = dest(handler, mode="update", match="contact_id").upsert([row(1, "42", FIRSTNAME="Ann")])
    assert seen == [("PUT", "/v3/contacts/42", "contact_id")]
    assert "not found" in errors["1"]


def test_delete_treats_already_deleted_as_success():
    d = dest(lambda r: httpx.Response(404, json={"message": "Contact not found"}))
    assert d.remove([row(1, "a@x.com")]) == {}


def test_list_sync_imports_into_list_and_waits_for_process():
    calls = []

    def handler(req):
        calls.append((req.method, req.url.path))
        if req.url.path == "/v3/contacts/import":
            body = json.loads(req.content)
            assert body["listIds"] == [7] and body["updateExistingContacts"] is True
            assert body["jsonBody"] == [{"email": "a@x.com", "attributes": {"FIRSTNAME": "Ann"}}]
            return httpx.Response(202, json={"processId": 99})
        return httpx.Response(200, json={"id": 99, "status": "completed"})
    errors = dest(handler, sync_type="lists", list_id="7").upsert([row(1, "a@x.com", FIRSTNAME="Ann"), row(2, None)])
    assert errors == {"2": "Missing email"}
    assert calls == [("POST", "/v3/contacts/import"), ("GET", "/v3/processes/99")]


def test_failed_import_fails_the_batch():
    def handler(req):
        if req.url.path == "/v3/contacts/import":
            return httpx.Response(202, json={"processId": 5})
        return httpx.Response(200, json={"status": "failed"})
    errors = dest(handler, sync_type="lists", list_id="7").upsert([row(1, "a@x.com")])
    assert "failed" in errors["1"]


def test_list_removal_unlinks_in_chunks():
    sent = []

    def handler(req):
        sent.append(json.loads(req.content)["emails"])
        return httpx.Response(201, json={"contacts": {"success": [], "failure": []}})
    rows = [row(i, f"u{i}@x.com") for i in range(160)]
    assert dest(handler, sync_type="lists", list_id="7").remove(rows) == {}
    assert [len(c) for c in sent] == [150, 10]


def test_prepare_finds_list_by_name_or_creates_it_in_first_folder():
    created = {}

    def handler(req):
        if req.url.path == "/v3/contacts/lists" and req.method == "GET":
            return httpx.Response(200, json={"lists": [{"id": 3, "name": "Other"}]})
        if req.url.path == "/v3/contacts/folders":
            return httpx.Response(200, json={"folders": [{"id": 11, "name": "Your first folder"}]})
        created.update(json.loads(req.content))
        return httpx.Response(201, json={"id": 21})
    d = dest(handler, sync_type="lists", list_name="Newsletter video readers")
    assert d.prepare() == {"list_id": 21}
    assert created == {"name": "Newsletter video readers", "folderId": 11}

    d2 = dest(lambda r: httpx.Response(200, json={"lists": [{"id": 3, "name": "newsletter VIDEO readers"}]}),
              sync_type="lists", list_name="Newsletter video readers")
    assert d2.prepare() == {"list_id": 3}
