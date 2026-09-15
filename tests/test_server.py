"""ASGI composition checks, not a replacement for real-browser verification."""

import importlib
import re

from fastapi.testclient import TestClient


def test_built_frontend_assets_and_security_boundary(tmp_path, monkeypatch):
    monkeypatch.setenv("ITLES_DB_PATH", str(tmp_path / "app.sqlite3"))
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "0")
    server = importlib.reload(importlib.import_module("server"))
    client = TestClient(server.app)
    response = client.get("/")
    assert response.status_code == 200
    assert '<div id="root"></div>' in response.text
    scripts = re.findall(r'src="(/assets/[^"]+\.js)"', response.text)
    assert scripts, "run the frontend build before this composition check"
    for script in scripts:
        asset = client.get(script)
        assert asset.status_code == 200
        assert "javascript" in asset.headers["content-type"]
    assert "connect-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["referrer-policy"] == "no-referrer"
    assert client.get("/api/health").headers["cache-control"] == "no-store"
    assert client.get("/api/not-a-route").status_code == 404
    assert client.get("/docs").status_code == 404
    assert client.post("/api/auth/demo").status_code == 404
    assert client.post("/api/auth/logout", headers={"Origin": "https://untrusted.example"}).status_code == 403
    assert client.post("/api/auth/logout", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_document_downloads_use_fixed_allowlist(tmp_path, monkeypatch):
    monkeypatch.setenv("ITLES_DB_PATH", str(tmp_path / "app.sqlite3"))
    server = importlib.reload(importlib.import_module("server"))
    monkeypatch.setattr(server, "ROOT", tmp_path)
    folder = tmp_path / "deliverables"
    folder.mkdir()
    (folder / "itles_report.pdf").write_bytes(b"%PDF-test")
    (folder / "private.env").write_bytes(b"not public")
    client = TestClient(server.app)
    documents = client.get("/api/documents").json()["documents"]
    assert [document["name"] for document in documents] == ["itles_report.pdf"]
    download = client.get(documents[0]["url"])
    assert download.content == b"%PDF-test"
    assert "attachment" in download.headers["content-disposition"]
    assert client.get("/api/documents/private.env").status_code == 404
    assert client.get("/api/documents/itles_source.zip").status_code == 404
