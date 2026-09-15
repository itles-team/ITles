import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from scripts.check_deployment import DeploymentError, check_deployment, json_response


def test_deployment_probe_checks_real_api_and_closes_demo_session(tmp_path, monkeypatch):
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "1")
    monkeypatch.setenv("ITLES_COOKIE_SECURE", "1")
    with TestClient(create_app(str(tmp_path / "probe.sqlite3")), base_url="https://testserver") as client:
        check_deployment(client)
        check_deployment(client, demo=True)
        assert client.get("/api/auth/me").status_code == 401


def test_deployment_probe_does_not_enable_demo(tmp_path, monkeypatch):
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "0")
    with TestClient(create_app(str(tmp_path / "probe.sqlite3"))) as client:
        check_deployment(client)
        with pytest.raises(DeploymentError, match="HTTP 404, expected 200"):
            check_deployment(client, demo=True)


@pytest.mark.parametrize("status", [200, 405])
def test_deployment_probe_rejects_static_html_without_logging_body(status):
    response = httpx.Response(
        status, headers={"content-type": "text/html"}, text="<html>private-response</html>",
        request=httpx.Request("POST", "https://testserver/api/auth/login"),
    )
    with pytest.raises(DeploymentError, match="not JSON") as error:
        json_response(response, 200)
    assert "private-response" not in str(error.value)


@pytest.mark.parametrize("body", ["not-json", "[]", "null"])
def test_deployment_probe_rejects_invalid_json_contract(body):
    response = httpx.Response(
        200, headers={"content-type": "application/json"}, text=body,
        request=httpx.Request("GET", "https://testserver/api/health"),
    )
    with pytest.raises(DeploymentError):
        json_response(response, 200)
