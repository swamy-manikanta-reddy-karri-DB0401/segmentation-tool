import pytest

from app import connection


def base(**kw):
    return {"name": "Marketing", "host": "adb-1.2.azuredatabricks.net/", "auth_type": "oauth", "client_id": "abc",
            "secret": "s3cret", "warehouse_id": "wh1", "state_schema": "main.cdp_state", **kw}


def test_normalize_adds_scheme_and_trims_host():
    assert connection.normalize(base())["host"] == "https://adb-1.2.azuredatabricks.net"


def test_oauth_requires_client_id():
    with pytest.raises(ValueError, match="client"):
        connection.normalize(base(client_id=""))


def test_pat_drops_client_id():
    out = connection.normalize(base(auth_type="pat", client_id="ignored"))
    assert out["client_id"] == ""


@pytest.mark.parametrize("schema", ["cdp_state", "a.b.c", "main.cdp-state", ""])
def test_state_schema_must_be_catalog_dot_schema(schema):
    with pytest.raises(ValueError, match="catalog.schema"):
        connection.normalize(base(state_schema=schema))


def test_unknown_auth_type_rejected():
    with pytest.raises(ValueError, match="Authentication"):
        connection.normalize(base(auth_type="basic"))


def test_pat_bearer_is_the_token_itself():
    assert connection.bearer({"auth_type": "pat", "secret": "dapi123"}) == "dapi123"


def test_oauth_token_is_cached(monkeypatch):
    calls = []

    class R:
        status_code = 200

        @staticmethod
        def json():
            return {"access_token": f"tok{len(calls)}", "expires_in": 3600}

    monkeypatch.setattr(connection.httpx, "post", lambda *a, **k: calls.append(1) or R())
    c = {"auth_type": "oauth", "host": "https://h", "client_id": "cid-cache-test", "secret": "x"}
    assert connection.bearer(c) == connection.bearer(c)
    assert len(calls) == 1
