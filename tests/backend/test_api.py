import importlib
import csv
import io
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.db import connect, default_db_path, hash_secret, initialize, iso, password_hash, utcnow


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("ITLES_COOKIE_SECURE", "0")
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "0")
    app_module = importlib.import_module("backend.app")
    monkeypatch.setattr(app_module, "DEMO_LOGIN_LIMITER", app_module.DemoLoginLimiter())
    path = str(tmp_path / "telemetry.db")
    conn = connect(path)
    initialize(conn)
    for org_id, account in (("org-a", "forest-a"), ("org-b", "forest-b")):
        conn.execute(
            "INSERT INTO organizations VALUES(?,?,?,?,0)",
            (org_id, account, account, password_hash("correct-secret")),
        )
        conn.execute(
            "INSERT INTO machines VALUES(?,?,?,?,?,?)",
            (f"{org_id}-machine", org_id, f"Machine {org_id}", None, None, None),
        )
        conn.execute(
            "INSERT INTO device_tokens VALUES(?,?,?,?)",
            (hash_secret(f"token-{org_id}"), org_id, f"{org_id}-machine", iso(utcnow())),
        )
    conn.commit()
    conn.close()
    return TestClient(create_app(path))


def login(api, account="forest-a"):
    response = api.post("/api/auth/login", json={"account": account, "password": "correct-secret"})
    assert response.status_code == 200
    assert response.json()["organization"]["id"] == ("org-a" if account == "forest-a" else "org-b")


def event(machine_id, *, kind="production", occurred_at="2026-01-10T12:00:00Z", event_id=None, **values):
    base = {"event_id": event_id or str(uuid4()), "machine_id": machine_id, "occurred_at": occurred_at, "kind": kind}
    if kind == "production":
        return base | {"volume_m3": "5.123456", "basis": "under_bark", "source": "onboard_measurement", "method": "harvester_onboard", "method_version": "test-v1", "calibration_ref": None} | values
    return base | {"measurements": [{"key": "fuel_level_pct", "value": 35.0, "unit": "%"}]} | values


def ingest(api, events, batch_id=None, token="token-org-a"):
    return api.post(
        "/api/ingest",
        headers={"Authorization": f"Bearer {token}"},
        json={"schema_version": 1, "batch_id": batch_id or str(uuid4()), "events": events},
    )


def test_auth_and_tenant_isolation(api):
    assert api.get("/api/machines").status_code == 401
    login(api)
    assert api.get("/api/machines/org-b-machine").status_code == 404
    assert api.get("/api/machines").json()["machines"][0]["id"] == "org-a-machine"
    assert api.post("/api/auth/logout").status_code == 200
    assert api.get("/api/auth/me").status_code == 401


def test_demo_is_off_unless_explicitly_enabled(api):
    assert api.post("/api/auth/demo").status_code == 404


def test_secure_cookie_is_on_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("ITLES_COOKIE_SECURE", raising=False)
    path = str(tmp_path / "secure.db")
    conn = connect(path)
    initialize(conn)
    conn.execute(
        "INSERT INTO organizations VALUES(?,?,?,?,0)",
        ("secure-org", "Secure Org", "secure-org", password_hash("correct-secret")),
    )
    conn.commit()
    conn.close()
    client = TestClient(create_app(path), base_url="https://testserver")
    response = client.post("/api/auth/login", json={"account": "secure-org", "password": "correct-secret"})
    assert response.status_code == 200
    cookie = response.headers["set-cookie"].lower()
    assert "secure" in cookie and "httponly" in cookie and "samesite=strict" in cookie


def test_default_database_is_local_and_import_does_not_create_it(tmp_path, monkeypatch):
    monkeypatch.delenv("ITLES_DB_PATH", raising=False)
    assert default_db_path() == ".local/itles.sqlite3"
    root = Path(__file__).resolve().parents[2]
    environment = os.environ | {"PYTHONPATH": str(root), "ITLES_DB_PATH": ".local/itles.sqlite3"}
    completed = subprocess.run(
        [sys.executable, "-c", "import backend.app; import server"], cwd=tmp_path, env=environment,
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert not (tmp_path / ".local").exists()


def test_login_checks_dummy_hash_and_throttles_by_hashed_account_only(api, monkeypatch):
    app_module = importlib.import_module("backend.app")
    app_module.LOGIN_LIMITER._records.clear()
    checked = []

    def dummy_check(_password, stored):
        checked.append(stored)
        return False

    monkeypatch.setattr(app_module, "password_matches", dummy_check)
    missing_account = "missing-org"
    for _ in range(5):
        assert api.post("/api/auth/login", json={"account": missing_account, "password": "correct-secret"}).status_code == 401
    assert api.post("/api/auth/login", json={"account": missing_account, "password": "correct-secret"}).status_code == 429
    assert checked == [app_module.DUMMY_PASSWORD_HASH] * 5
    assert missing_account not in app_module.LOGIN_LIMITER._records
    assert all(len(key) == 64 for key in app_module.LOGIN_LIMITER._records)


def test_ingest_idempotence_and_conflicts_are_atomic(api):
    item = event("org-a-machine", event_id=str(uuid4()))
    batch_id = str(uuid4())
    assert ingest(api, [item], batch_id).json() == {"batch_id": batch_id, "accepted": 1, "duplicates": 0, "rejected": 0}
    assert ingest(api, [item], batch_id).json() == {"batch_id": batch_id, "accepted": 0, "duplicates": 1, "rejected": 0}

    changed = item | {"volume_m3": "6.000000"}
    conflict = ingest(api, [changed], str(uuid4()))
    assert conflict.status_code == 409
    login(api)
    fleet = api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()
    assert fleet["record_count"] == 1
    assert fleet["totals"][0]["volume_m3"] == "5.123456"

    different_batch_id = str(uuid4())
    different_batch = ingest(api, [item], different_batch_id)
    assert different_batch.json() == {"batch_id": different_batch_id, "accepted": 0, "duplicates": 1, "rejected": 0}
    batch_conflict = ingest(api, [changed], batch_id)
    assert batch_conflict.status_code == 409


def test_late_telemetry_does_not_regress_latest_value(api):
    recent = event("org-a-machine", kind="telemetry", occurred_at="2026-01-10T12:00:00Z")
    late = event("org-a-machine", kind="telemetry", occurred_at="2026-01-10T11:00:00Z", measurements=[{"key": "fuel_level_pct", "value": 10.0, "unit": "%"}])
    assert ingest(api, [recent]).status_code == 200
    assert ingest(api, [late]).status_code == 200
    login(api)
    metrics = {metric["key"]: metric for metric in api.get("/api/machines").json()["machines"][0]["metrics"]}
    assert metrics["fuel_level_pct"]["value"] == 35.0
    assert metrics["fuel_level_pct"]["observed_at"] == "2026-01-10T12:00:00.000000Z"
    assert metrics["engine_rpm"]["value"] is None
    assert metrics["engine_rpm"]["status"] == "missing"


@pytest.mark.parametrize(
    "payload",
    [
        lambda: event("org-a-machine", kind="telemetry", measurements=[{"key": "fuel_level_pct", "value": 10.0, "unit": "L"}]),
        lambda: event("org-a-machine", kind="production", volume_m3="1.1234567"),
        lambda: event("org-a-machine", kind="production") | {"method_version": ""},
        lambda: event("org-a-machine", kind="telemetry") | {"unexpected": True},
        lambda: event("org-a-machine", occurred_at="2036-01-10T12:00:00Z"),
    ],
)
def test_invalid_events_are_rejected_before_storage(api, payload):
    response = ingest(api, [payload()])
    assert response.status_code == 422
    login(api)
    quality = api.get("/api/quality").json()
    assert quality["counts"]["accepted"] == 0
    assert quality["counts"]["rejected"] == 1
    assert api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()["record_count"] == 0


def test_fleet_dates_are_inclusive_and_totals_are_exact(api):
    first = event("org-a-machine", occurred_at="2026-01-10T00:00:00Z", volume_m3="0.000001")
    last = event("org-a-machine", occurred_at="2026-01-10T23:59:59Z", volume_m3="2.500000")
    excluded = event("org-a-machine", occurred_at="2026-01-11T00:00:00Z", volume_m3="9.000000")
    assert ingest(api, [first, last, excluded]).status_code == 200
    login(api)
    response = api.get("/api/fleet?start=2026-01-10&end=2026-01-10")
    assert response.status_code == 200
    data = response.json()
    assert data["period"] == {"start": "2026-01-10", "end": "2026-01-10"}
    assert data["record_count"] == 2
    total = data["totals"]
    assert len(total) == 1
    assert {key: total[0][key] for key in ("basis", "volume_m3", "records")} == {
        "basis": "under_bark", "volume_m3": "2.500001", "records": 2,
    }
    assert total[0]["provenance"] == {
        "sources": ["onboard_measurement"], "methods": ["harvester_onboard"],
        "method_versions": ["test-v1"], "calibration_refs": [],
    }
    assert total[0]["warnings"] == []
    assert api.get("/api/fleet?start=2026-W01&end=2026-01-10").status_code == 422
    ledger_rows = api.get("/api/exports/ledger.csv?start=2026-01-10&end=2026-01-10").text.splitlines()
    assert len(ledger_rows) == 3
    ledger = list(csv.DictReader(io.StringIO("\n".join(ledger_rows))))
    assert [row["volume_m3"] for row in ledger] == ["0.000001", "2.500000"]


def test_unknown_method_version_is_preserved_and_warned(api):
    item = event("org-a-machine", method_version="unknown", calibration_ref=None)
    assert ingest(api, [item]).status_code == 200
    login(api)
    total = api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()["totals"][0]
    assert total["provenance"]["method_versions"] == ["unknown"]
    assert len(total["warnings"]) == 1
    detail = api.get("/api/machines/org-a-machine?start=2026-01-10&end=2026-01-10").json()
    assert detail["production"][0]["method_version"] == "unknown"
    assert detail["production"][0]["calibration_ref"] is None


def test_token_cannot_write_another_machine(api):
    response = ingest(api, [event("org-b-machine")])
    assert response.status_code == 403
    login(api, "forest-b")
    assert api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()["record_count"] == 0


def test_ingest_body_size_is_limited_before_json_validation(api):
    response = api.post(
        "/api/ingest",
        headers={"Authorization": "Bearer token-org-a"},
        content=b"x" * (512 * 1024 + 1),
    )
    assert response.status_code == 413


def test_gps_only_telemetry_is_valid(api):
    position = event("org-a-machine", kind="telemetry", measurements=[], position={"latitude": 61.785, "longitude": 34.346})
    assert ingest(api, [position]).status_code == 200
    login(api)
    assert api.get("/api/machines").json()["machines"][0]["position"]["latitude"] == 61.785


def test_end_date_at_datetime_limit_is_a_validation_error(api):
    login(api)
    assert api.get("/api/fleet?start=9999-12-31&end=9999-12-31").status_code == 422


def test_interactive_documentation_routes_are_not_exposed(api):
    assert api.get("/docs").status_code == 404
    assert api.get("/redoc").status_code == 404


def test_cross_organization_event_id_is_unavailable_without_data_leak(api):
    shared_id = str(uuid4())
    assert ingest(api, [event("org-a-machine", event_id=shared_id)]).status_code == 200
    response = ingest(api, [event("org-b-machine", event_id=shared_id)], token="token-org-b")
    assert response.status_code == 409
    assert response.json() == {"detail": "event_id is unavailable"}
    login(api, "forest-b")
    assert api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()["record_count"] == 0


def test_engine_hour_counter_decrease_makes_period_value_unavailable(api):
    first = event("org-a-machine", kind="telemetry", occurred_at="2026-01-10T10:00:00Z", measurements=[{"key": "engine_hours_total", "value": 100.0, "unit": "h"}])
    reset = event("org-a-machine", kind="telemetry", occurred_at="2026-01-10T11:00:00Z", measurements=[{"key": "engine_hours_total", "value": 90.0, "unit": "h"}])
    assert ingest(api, [first, reset]).status_code == 200
    login(api)
    fleet = api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()
    assert fleet["machines"][0]["engine_hours"] is None
    assert any("уменьшение счётчика моточасов" in item for item in api.get("/api/quality").json()["limitations"])


def test_simultaneous_retries_accept_only_one_copy(api):
    packet = [event("org-a-machine", volume_m3="0.123456")]
    batch_id = str(uuid4())
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda _: ingest(api, packet, batch_id), range(24)))
    assert all(response.status_code == 200 for response in responses)
    assert sum(response.json()["accepted"] for response in responses) == 1
    assert sum(response.json()["duplicates"] for response in responses) == 23
    login(api)
    result = api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()
    assert result["record_count"] == 1
    assert result["totals"][0]["volume_m3"] == "0.123456"


def test_subsecond_ordering_and_last_microsecond_period_boundary(api):
    first = event("org-a-machine", kind="telemetry", occurred_at="2026-01-10T12:00:00.100001Z")
    later = event("org-a-machine", kind="telemetry", occurred_at="2026-01-10T12:00:00.900001Z", measurements=[{"key": "fuel_level_pct", "value": 70, "unit": "%"}])
    final = event("org-a-machine", occurred_at="2026-01-10T23:59:59.999999Z", volume_m3="1.000001")
    next_day = event("org-a-machine", occurred_at="2026-01-11T00:00:00Z")
    assert ingest(api, [later, first, final, next_day]).status_code == 200
    login(api)
    detail = api.get("/api/machines/org-a-machine?start=2026-01-10&end=2026-01-10").json()
    fuel = next(item for item in detail["metrics"] if item["key"] == "fuel_level_pct")
    assert fuel["value"] == 70
    assert fuel["observed_at"] == "2026-01-10T12:00:00.900001Z"
    assert len(detail["production"]) == 1
    assert detail["production"][0]["occurred_at"] == "2026-01-10T23:59:59.999999Z"
    assert detail["totals"][0]["volume_m3"] == "1.000001"
    conflict = ingest(api, [later | {"occurred_at": "2026-01-10T12:00:00.900002Z"}])
    assert conflict.status_code == 409


def test_metric_contract_does_not_invent_oem_operating_norms(api):
    measurements = [
        {"key": "engine_rpm", "value": 6000, "unit": "rpm"},
        {"key": "engine_oil_temperature_c", "value": 300, "unit": "°C"},
        {"key": "fuel_rate_lph", "value": 15.25, "unit": "L/h"},
        {"key": "fuel_consumed_total_l", "value": 180.0, "unit": "L"},
        {"key": "engine_oil_level_pct", "value": 45, "unit": "%"},
    ]
    assert ingest(api, [event("org-a-machine", kind="telemetry", measurements=measurements)]).status_code == 200
    login(api)
    detail = api.get("/api/machines/org-a-machine").json()
    values = {metric["key"]: metric for metric in detail["metrics"]}
    assert values["engine_rpm"]["value"] == 6000
    assert all(metric["norm"] is None for metric in values.values())
    assert values["hydraulic_oil_level_pct"]["status"] == "missing"
    invalid = event("org-a-machine", kind="telemetry", measurements=[{"key": "fuel_level_pct", "value": 101, "unit": "%"}])
    assert ingest(api, [invalid]).status_code == 422


def test_full_app_factory_has_no_database_side_effect(tmp_path):
    path = tmp_path / "new-folder" / "pilot.db"
    app = create_app(str(path))
    assert not path.exists()
    assert TestClient(app).get("/api/health").status_code == 200
    assert path.exists()


def test_complete_outbox_api_ledger_chain_recovers_after_lost_ack(api, tmp_path):
    from edge.outbox import Outbox

    payload = {"schema_version": 1, "batch_id": str(uuid4()), "events": [
        event("org-a-machine", volume_m3="0.000001"),
        event("org-a-machine", volume_m3="12.345678"),
    ]}
    queue_path = tmp_path / "edge.sqlite3"
    queue = Outbox(queue_path)
    queue.enqueue(payload)

    def lose_ack(packet):
        response = api.post("/api/ingest", headers={"Authorization": "Bearer token-org-a"}, json=packet)
        assert response.status_code == 200
        raise OSError("simulated lost response after server commit")

    assert queue.flush(lose_ack)["pending"] == 1
    queue.close()
    queue = Outbox(queue_path)
    try:
        def transport(packet):
            response = api.post("/api/ingest", headers={"Authorization": "Bearer token-org-a"}, json=packet)
            assert response.json()["accepted"] == 0
            assert response.json()["duplicates"] == 2
            return response.status_code, response.json()

        assert queue.flush(transport) == {"pending": 0, "sent": 1, "quarantined": 0}
        assert queue.db.execute("SELECT payload FROM outbox").fetchone()[0] is None
    finally:
        queue.close()
    login(api)
    fleet = api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()
    ledger = list(csv.DictReader(io.StringIO(api.get("/api/exports/ledger.csv?start=2026-01-10&end=2026-01-10").text)))
    from decimal import Decimal

    assert fleet["record_count"] == len(ledger) == 2
    assert sum(Decimal(row["volume_m3"]) for row in ledger) == Decimal(fleet["totals"][0]["volume_m3"]) == Decimal("12.345679")


def test_empty_date_is_rejected_and_mixed_methods_are_disclosed(api):
    assert ingest(api, [event("org-a-machine"), event("org-a-machine", method_version="other-v2")]).status_code == 200
    login(api)
    assert api.get("/api/fleet?start=&end=").status_code == 422
    totals = api.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()["totals"]
    assert any("сопоставимость методик не подтверждена" in warning for warning in totals[0]["warnings"])


def test_demo_stays_labelled_and_does_not_refresh_fixture_timestamps(api, monkeypatch):
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "1")
    response = api.post("/api/auth/demo")
    assert response.status_code == 200
    session = response.json()
    assert session["demo"] is True
    assert session["data_period"]["start"] <= session["data_period"]["end"]
    original = api.get("/api/machines").json()["machines"]
    assert len(original) == 3
    assert api.post("/api/auth/logout").status_code == 200
    assert api.post("/api/auth/demo").status_code == 200
    assert api.get("/api/auth/me").json() == session
    assert api.get("/api/machines").json()["machines"] == original


@pytest.mark.parametrize("timestamp", [1768046400, "2026-01-10T12:00:00.1234567Z", "2026-01-10T12:00:00", "2026-01-10T15:00:00+03:00"])
def test_timestamps_are_not_guessed_or_silently_truncated(api, timestamp):
    assert ingest(api, [event("org-a-machine", occurred_at=timestamp)]).status_code == 422


def test_schema_version_does_not_coerce_boolean(api):
    response = api.post("/api/ingest", headers={"Authorization": "Bearer token-org-a"}, json={
        "schema_version": True, "batch_id": str(uuid4()), "events": [event("org-a-machine")],
    })
    assert response.status_code == 422


@pytest.mark.parametrize("setting,enabled", [
    (None, False), ("0", False), ("false", False), ("off", False), ("", False),
    ("1", True), ("true", True), ("TRUE", True), ("yes", True), ("YeS", True),
    (" true ", False),
])
def test_auth_options_matches_demo_admission_setting(api, monkeypatch, setting, enabled):
    if setting is None:
        monkeypatch.delenv("ITLES_DEMO_ENABLED", raising=False)
    else:
        monkeypatch.setenv("ITLES_DEMO_ENABLED", setting)
    response = api.get("/api/auth/options")
    assert response.status_code == 200
    assert response.json() == {"demo_enabled": enabled}
    assert "set-cookie" not in response.headers
    assert api.post("/api/auth/demo").status_code == (200 if enabled else 404)


def test_auth_options_discloses_no_tenant_or_session_information(api):
    expected = {"demo_enabled": False}
    assert api.get("/api/auth/options").json() == expected
    for account in ("forest-a", "forest-b"):
        login(api, account)
        response = api.get("/api/auth/options")
        assert response.status_code == 200
        assert response.json() == expected
        assert "set-cookie" not in response.headers
    api.cookies.clear()
    api.cookies.set("itles_session", "invalid-test-session")
    assert api.get("/api/auth/options").json() == expected


def test_auth_options_does_not_initialize_a_database(tmp_path, monkeypatch):
    monkeypatch.delenv("ITLES_DEMO_ENABLED", raising=False)
    path = tmp_path / "not-created.db"
    client = TestClient(create_app(str(path)))
    assert client.get("/api/auth/options").json() == {"demo_enabled": False}
    assert not path.exists()


def test_fleet_uses_one_snapshot_during_interleaved_ingest(api, monkeypatch):
    assert ingest(api, [event("org-a-machine")]).status_code == 200
    login(api)
    writer = TestClient(api.app)
    app_module = importlib.import_module("backend.app")
    original_totals = app_module._totals
    committed = False

    def interleaved_totals(conn, organization_id, start, end, machine_id=None):
        nonlocal committed
        result = original_totals(conn, organization_id, start, end, machine_id)
        if machine_id and not committed:
            committed = True
            assert ingest(writer, [event("org-a-machine", volume_m3="1.000000")]).status_code == 200
        return result

    monkeypatch.setattr(app_module, "_totals", interleaved_totals)
    url = "/api/fleet?start=2026-01-10&end=2026-01-10"
    response = api.get(url)
    assert response.status_code == 200
    snapshot = response.json()
    assert committed
    assert snapshot["record_count"] == 1
    assert snapshot["totals"] == snapshot["machines"][0]["totals"]
    assert snapshot["totals"][0]["records"] == 1
    assert snapshot["totals"][0]["volume_m3"] == "5.123456"
    refreshed = api.get(url).json()
    assert refreshed["record_count"] == 2
    assert refreshed["totals"] == refreshed["machines"][0]["totals"]
    assert refreshed["totals"][0]["volume_m3"] == "6.123456"


def test_machine_detail_uses_one_snapshot_during_interleaved_ingest(api, monkeypatch):
    def telemetry(hour, value):
        return event(
            "org-a-machine", kind="telemetry", occurred_at=f"2026-01-10T{hour}:00:00Z",
            measurements=[{"key": "engine_hours_total", "value": value, "unit": "h"}],
            position={"latitude": 61.0, "longitude": 34.0 + value / 1000},
        )

    assert ingest(api, [event("org-a-machine"), telemetry("10", 100), telemetry("11", 101)]).status_code == 200
    login(api)
    writer = TestClient(api.app)
    app_module = importlib.import_module("backend.app")
    original_payload = app_module._machine_payload
    committed = False

    def interleaved_payload(conn, organization_id, machine):
        nonlocal committed
        result = original_payload(conn, organization_id, machine)
        if not committed:
            committed = True
            assert ingest(writer, [event("org-a-machine"), telemetry("12", 102)]).status_code == 200
        return result

    monkeypatch.setattr(app_module, "_machine_payload", interleaved_payload)
    url = "/api/machines/org-a-machine?start=2026-01-10&end=2026-01-10"
    response = api.get(url)
    assert response.status_code == 200
    snapshot = response.json()
    assert committed
    assert len(snapshot["production"]) == snapshot["totals"][0]["records"] == 1
    assert len(snapshot["track"]) == 2
    assert snapshot["position"]["observed_at"] == snapshot["track"][-1]["observed_at"]
    assert snapshot["engine_hours"] == 1
    assert next(m["value"] for m in snapshot["metrics"] if m["key"] == "engine_hours_total") == 101
    refreshed = api.get(url).json()
    assert len(refreshed["production"]) == refreshed["totals"][0]["records"] == 2
    assert len(refreshed["track"]) == 3
    assert refreshed["engine_hours"] == 2


def test_ninth_demo_visitor_does_not_evict_active_sessions(api, monkeypatch):
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "1")
    visitors = [TestClient(api.app) for _ in range(9)]
    for visitor in visitors:
        assert visitor.post("/api/auth/demo").status_code == 200
    for visitor in visitors:
        assert visitor.get("/api/auth/me").status_code == 200


def test_demo_admission_preserves_active_sessions_and_reclaims_expired_slots(api, monkeypatch):
    app_module = importlib.import_module("backend.app")
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "1")
    existing = TestClient(api.app)
    organization_id = existing.post("/api/auth/demo").json()["organization"]["id"]
    existing_token = existing.cookies.get("itles_session")
    ordinary = TestClient(api.app)
    login(ordinary)
    now = utcnow()
    conn = connect(api.app.state.db_path)
    active_tokens = [f"synthetic-active-{i}" for i in range(app_module.DEMO_SESSION_CAP - 1)]
    conn.executemany("INSERT INTO sessions VALUES(?,?,?)", [
        (hash_secret(token), organization_id, iso(now + timedelta(days=1))) for token in active_tokens
    ])
    expired_tokens = ["synthetic-expired-demo", "synthetic-expired-ordinary"]
    conn.executemany("INSERT INTO sessions VALUES(?,?,?)", [
        (hash_secret(expired_tokens[0]), organization_id, iso(now)),
        (hash_secret(expired_tokens[1]), "org-a", iso(now - timedelta(seconds=1))),
    ])
    conn.commit()

    newcomer = TestClient(api.app)
    response = newcomer.post("/api/auth/demo")
    assert response.status_code == 429
    assert "set-cookie" not in response.headers
    assert existing.get("/api/auth/me").status_code == 200
    assert ordinary.get("/api/auth/me").status_code == 200
    assert conn.execute("SELECT COUNT(*) FROM sessions WHERE organization_id=?", (organization_id,)).fetchone()[0] == app_module.DEMO_SESSION_CAP
    for token in expired_tokens:
        assert conn.execute("SELECT 1 FROM sessions WHERE token_hash=?", (hash_secret(token),)).fetchone() is None
    for token in active_tokens:
        assert conn.execute("SELECT 1 FROM sessions WHERE token_hash=?", (hash_secret(token),)).fetchone() is not None

    another_ordinary = TestClient(api.app)
    login(another_ordinary)
    assert ordinary.get("/api/auth/me").status_code == 200
    conn.execute("UPDATE sessions SET expires_at=? WHERE token_hash=?", (iso(now), hash_secret(existing_token)))
    conn.commit()
    assert existing.get("/api/auth/me").status_code == 401
    assert newcomer.post("/api/auth/demo").status_code == 200
    assert newcomer.get("/api/auth/me").status_code == 200
    assert conn.execute("SELECT COUNT(*) FROM sessions WHERE organization_id=?", (organization_id,)).fetchone()[0] == app_module.DEMO_SESSION_CAP
    conn.close()


def test_concurrent_demo_visitors_cannot_exceed_admission_cap(api, monkeypatch):
    app_module = importlib.import_module("backend.app")
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "1")
    monkeypatch.setattr(app_module, "DEMO_SESSION_CAP", 2)
    existing = TestClient(api.app)
    organization_id = existing.post("/api/auth/demo").json()["organization"]["id"]

    def visit(_):
        return TestClient(api.app).post("/api/auth/demo").status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(visit, range(2))) == [200, 429]
    assert existing.get("/api/auth/me").status_code == 200
    conn = connect(api.app.state.db_path)
    assert conn.execute("SELECT COUNT(*) FROM sessions WHERE organization_id=?", (organization_id,)).fetchone()[0] == 2
    conn.close()
