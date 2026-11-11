import pytest


@pytest.fixture(autouse=True)
def _open_dev_mode(monkeypatch):
    """Most tests exercise the API as X-Dev-User personas, which exists only when sign-in is switched off.
    test_auth.py turns sign-in back on."""
    monkeypatch.setenv("CDP_LOCAL_AUTH", "0")
    monkeypatch.delenv("DATABRICKS_APP_NAME", raising=False)
