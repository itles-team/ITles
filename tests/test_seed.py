import csv
import importlib
import io
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from decimal import Decimal
from threading import Barrier
from uuid import NAMESPACE_URL, UUID, uuid5

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from backend import db, schemas
from backend.seed import DEMO_ACCOUNT, DEMO_MACHINE_IDS, DEMO_ORG_ID, seed_demo


app_module = importlib.import_module("backend.app")
PERIOD = "start=2026-09-14&end=2026-09-15"
EXPECTED_COUNTS = {
    "organizations": 1, "machines": 3, "events": 18, "measurements": 70,
    "positions": 7, "production": 10, "ingest_audit": 4,
    "ingest_batches": 0, "device_tokens": 0, "sessions": 0,
}


@pytest.fixture
def conn(tmp_path):
    connection = db.connect(str(tmp_path / "seed.sqlite3"))
    db.initialize(connection)
    try:
        yield connection
    finally:
        connection.close()


def counts(conn):
    return {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in EXPECTED_COUNTS}


def total_values(totals):
    return {row["basis"]: (row["volume_m3"], row["records"]) for row in totals}


def test_fixed_counts_missing_conditions_and_exact_integer_totals(conn):
    assert seed_demo(conn) == "demo-karelia-v2"
    assert counts(conn) == EXPECTED_COUNTS
    assert tuple(conn.execute("SELECT account,password_hash,is_demo FROM organizations").fetchone()) == ("demo-fleet-v2", None, 1)
    for machine_id, measurements, metrics, positions, production, events in [
        (DEMO_MACHINE_IDS[0], 55, 11, 5, 6, 11),
        (DEMO_MACHINE_IDS[1], 15, 5, 2, 4, 7),
        (DEMO_MACHINE_IDS[2], 0, 0, 0, 0, 0),
    ]:
        assert conn.execute("SELECT COUNT(*),COUNT(DISTINCT metric_key) FROM measurements WHERE machine_id=?", (machine_id,)).fetchone()[:] == (measurements, metrics)
        for table, expected in [("positions", positions), ("production", production), ("events", events)]:
            assert conn.execute(f"SELECT COUNT(*) FROM {table} WHERE machine_id=?", (machine_id,)).fetchone()[0] == expected
    assert dict(conn.execute("SELECT basis,SUM(volume_micro_m3) FROM production GROUP BY basis")) == {
        "under_bark": 39_075_000, "over_bark": 16_000_000, "unknown": 1_125_000,
    }
    assert conn.execute("SELECT COUNT(*) FROM production WHERE typeof(volume_micro_m3) != 'integer' OR calibration_ref IS NOT NULL").fetchone()[0] == 0
    for machine_id, expected in [(DEMO_MACHINE_IDS[0], [1200, 1204, 1208, 1209, 1213.5]), (DEMO_MACHINE_IDS[1], [883, 886, 2.25])]:
        actual = conn.execute("SELECT value FROM measurements WHERE machine_id=? AND metric_key='engine_hours_total' ORDER BY observed_at", (machine_id,)).fetchall()
        assert [row[0] for row in actual] == expected


def test_payload_contract_provenance_uuids_and_fixed_times(conn, monkeypatch):
    class FutureDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2035, 1, 1, tzinfo=UTC)

    monkeypatch.setattr(schemas, "datetime", FutureDateTime)
    seed_demo(conn)
    adapter = TypeAdapter(schemas.Event)
    for row in conn.execute("SELECT * FROM events"):
        payload = json.loads(row["canonical_payload"])
        assert payload["fixture"] == {"version": "demo-v2", "synthetic": True, "transport_verified": False}
        assert db.canonical_hash(payload) == (row["payload_hash"], row["canonical_payload"])
        event = adapter.validate_python(payload["event"])
        assert str(event.event_id) == row["event_id"]
        assert event.machine_id == row["machine_id"]
        assert UUID(row["event_id"]).version == 5
        assert row["event_id"] == str(uuid5(NAMESPACE_URL, f"itles:demo-v2:{row['machine_id']}:{row['kind']}:{row['occurred_at']}"))
        occurred = datetime.fromisoformat(row["occurred_at"].replace("Z", "+00:00"))
        received = datetime.fromisoformat(row["received_at"].replace("Z", "+00:00"))
        assert (received - occurred).total_seconds() == 30
        assert row["occurred_at"][:10] in {"2026-09-14", "2026-09-15"}
        assert row["received_at"][:10] in {"2026-09-14", "2026-09-15"}
        if event.kind == "telemetry":
            stored = conn.execute("SELECT metric_key,value,unit,observed_at FROM measurements WHERE event_id=? ORDER BY metric_key", (row["event_id"],)).fetchall()
            assert [tuple(value) for value in stored] == sorted((item.key, item.value, item.unit, row["occurred_at"]) for item in event.measurements)
            assert all(item.unit == schemas.METRICS[item.key][1] for item in event.measurements)
            position = conn.execute("SELECT latitude,longitude,observed_at FROM positions WHERE event_id=?", (row["event_id"],)).fetchone()
            assert (tuple(position) if position else None) == ((event.position.latitude, event.position.longitude, row["occurred_at"]) if event.position else None)
        else:
            stored = conn.execute("SELECT volume_micro_m3,basis,source,method,method_version,calibration_ref FROM production WHERE event_id=?", (row["event_id"],)).fetchone()
            assert tuple(stored) == (int(event.volume_m3 * 1_000_000), event.basis, event.source, event.method, event.method_version, None)
    assert dict(conn.execute("SELECT status,COUNT(*) FROM ingest_audit GROUP BY status")) == {"accepted": 2, "duplicates": 1, "rejected": 1}
    for row in conn.execute("SELECT received_at,reason FROM ingest_audit"):
        assert row["received_at"][:10] in {"2026-09-14", "2026-09-15"}
        assert row["reason"].startswith("СИНТЕТИЧЕСКИЙ ПРИМЕР demo-v2:")
        assert "не результат доставки или теста транспорта" in row["reason"]


def test_repeated_seed_is_bytewise_unchanged_after_clock_advances(conn, monkeypatch):
    seed_demo(conn)
    before = conn.serialize()
    changes = conn.total_changes
    monkeypatch.setattr(db, "utcnow", lambda: datetime(2040, 1, 1, tzinfo=UTC))
    for _ in range(3):
        assert seed_demo(conn) == DEMO_ORG_ID
        assert not conn.in_transaction
        assert conn.total_changes == changes
        assert conn.serialize() == before


def test_prior_demo_v1_is_not_migrated_or_relabelled(conn):
    stamp = "2025-05-01T00:00:00.000000Z"
    digest, canonical = db.canonical_hash({"fixture": True, "original": "do not rewrite"})
    conn.execute("INSERT INTO organizations VALUES(?,?,?,?,?)", ("demo-karelia", "Original v1", "demo-fleet", None, 1))
    conn.execute("INSERT INTO machines VALUES(?,?,?,?,?,?)", ("demo-harvester-01", "demo-karelia", "Old machine", "Old model", None, None))
    conn.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)", ("legacy-event", "demo-karelia", "demo-harvester-01", stamp, "production", digest, canonical, stamp))
    conn.execute("INSERT INTO production VALUES(?,?,?,?,?,?,?,?,?)", ("legacy-event", "demo-harvester-01", stamp, 123456, "unknown", "accounting_import", "manual_ledger", "unknown", None))
    conn.execute("INSERT INTO ingest_audit(organization_id,machine_id,received_at,status,reason) VALUES(?,?,?,?,?)", ("demo-karelia", "demo-harvester-01", stamp, "accepted", "original provenance"))
    conn.commit()
    queries = {
        "organizations": "id='demo-karelia'", "machines": "id='demo-harvester-01'",
        "events": "event_id='legacy-event'", "production": "event_id='legacy-event'",
        "ingest_audit": "organization_id='demo-karelia'",
    }

    def snapshot():
        return {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} WHERE {where}")] for table, where in queries.items()}

    before = snapshot()
    assert seed_demo(conn) == DEMO_ORG_ID
    assert seed_demo(conn) == DEMO_ORG_ID
    assert snapshot() == before
    assert conn.execute("SELECT COUNT(*) FROM organizations").fetchone()[0] == 2


@pytest.mark.parametrize("enclosing_transaction", [False, True])
def test_concurrent_seed_creates_exactly_one_scenario(tmp_path, enclosing_transaction):
    path = str(tmp_path / "parallel.sqlite3")
    initial = db.connect(path)
    db.initialize(initial)
    initial.close()
    barrier = Barrier(6)

    def seed_once(_):
        connection = db.connect(path)
        try:
            barrier.wait(timeout=10)
            if enclosing_transaction:
                connection.execute("BEGIN IMMEDIATE")
            result = seed_demo(connection)
            if enclosing_transaction:
                assert connection.in_transaction
                connection.commit()
            return result
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=6) as executor:
        assert list(executor.map(seed_once, range(6))) == [DEMO_ORG_ID] * 6
    connection = db.connect(path)
    try:
        assert counts(connection) == EXPECTED_COUNTS
    finally:
        connection.close()


def test_seed_respects_caller_transaction_and_rollback(conn):
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("INSERT INTO organizations VALUES('other','Other','other',NULL,0)")
    seed_demo(conn)
    assert conn.in_transaction
    assert conn.execute("SELECT COUNT(*) FROM organizations").fetchone()[0] == 2
    conn.rollback()
    assert counts(conn) == dict.fromkeys(EXPECTED_COUNTS, 0)
    seed_demo(conn)
    assert counts(conn) == EXPECTED_COUNTS


@pytest.mark.parametrize("enclosing_transaction", [False, True])
def test_failed_seed_is_atomic_and_does_not_rollback_caller_work(conn, enclosing_transaction):
    conn.execute("INSERT INTO organizations VALUES('other','Other','other',NULL,0)")
    conn.execute("INSERT INTO machines VALUES(?,?,?,?,?,?)", (DEMO_MACHINE_IDS[1], "other", "Collision", None, None, None))
    conn.commit()
    if enclosing_transaction:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT INTO organizations VALUES('pending','Pending','pending',NULL,0)")
    before = "\n".join(conn.iterdump())
    with pytest.raises(sqlite3.IntegrityError):
        seed_demo(conn)
    assert conn.in_transaction is enclosing_transaction
    assert "\n".join(conn.iterdump()) == before


@pytest.mark.parametrize("organization_id,is_demo", [("customer", 0), (DEMO_ORG_ID, 0), ("old-demo", 1)])
def test_reserved_account_collision_does_not_expose_another_organization(conn, organization_id, is_demo):
    conn.execute("INSERT INTO organizations VALUES(?,?,?,?,?)", (organization_id, "Existing", DEMO_ACCOUNT, None, is_demo))
    conn.commit()
    before = conn.serialize()
    with pytest.raises(ValueError, match="reserved"):
        seed_demo(conn)
    assert conn.serialize() == before


@pytest.fixture
def demo_api(tmp_path, monkeypatch):
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "1")
    monkeypatch.setenv("ITLES_COOKIE_SECURE", "0")
    monkeypatch.setattr(app_module, "DEMO_LOGIN_LIMITER", app_module.DemoLoginLimiter())
    monkeypatch.setattr(app_module, "utcnow", lambda: datetime(2030, 1, 1, tzinfo=UTC))
    path = str(tmp_path / "api.sqlite3")
    with TestClient(app_module.create_app(path)) as client:
        response = client.post("/api/auth/demo")
        assert response.status_code == 200
        assert response.json()["demo"] is True
        assert response.json()["organization"]["id"] == DEMO_ORG_ID
        assert response.json()["data_period"] == {"start": "2026-09-14", "end": "2026-09-15"}
        yield client


def test_api_three_machine_conditions_norms_counter_reset_and_recorded_track(demo_api):
    machines = demo_api.get("/api/machines").json()["machines"]
    assert [machine["id"] for machine in machines] == list(DEMO_MACHINE_IDS)
    assert [machine["connection_status"] for machine in machines] == ["stale", "stale", "missing"]
    assert [sum(metric["value"] is not None for metric in machine["metrics"]) for machine in machines] == [11, 5, 0]
    for machine in machines:
        assert len(machine["metrics"]) == 12
        assert all(metric["norm"] is None for metric in machine["metrics"])
        assert all(metric["status"] == ("missing" if metric["value"] is None else "stale") for metric in machine["metrics"])
    assert next(item for item in machines[0]["metrics"] if item["key"] == "chain_oil_level_pct")["value"] is None
    partial = {item["key"]: item for item in machines[1]["metrics"]}
    assert partial["fuel_rate_lph"]["value"] == partial["engine_rpm"]["value"] == 0
    assert machines[1]["position"]["observed_at"] == "2026-09-15T07:00:00.000000Z"
    assert machines[1]["last_seen"] == "2026-09-15T11:00:00.000000Z"
    assert machines[2]["last_seen"] is None and machines[2]["position"] is None
    for machine_id, expected_hours, expected_track, expected_production in [
        (DEMO_MACHINE_IDS[0], 13.5, 5, 6), (DEMO_MACHINE_IDS[1], None, 2, 4), (DEMO_MACHINE_IDS[2], None, 0, 0),
    ]:
        response = demo_api.get(f"/api/machines/{machine_id}?{PERIOD}")
        assert response.status_code == 200
        detail = response.json()
        assert detail["engine_hours"] == expected_hours
        assert len(detail["track"]) == expected_track
        assert len(detail["production"]) == expected_production
        assert [point["observed_at"] for point in detail["track"]] == sorted(point["observed_at"] for point in detail["track"])
        if machine_id == DEMO_MACHINE_IDS[2]:
            assert detail["totals"] == []
    quality = demo_api.get("/api/quality").json()
    assert quality["counts"] == {"accepted": 2, "duplicates": 1, "rejected": 1}
    assert len(quality["recent"]) == 4
    assert all("СИНТЕТИЧЕСКИЙ ПРИМЕР demo-v2" in row["reason"] for row in quality["recent"])
    assert any("счётчика моточасов" in warning for warning in quality["limitations"])


@pytest.mark.parametrize("period,expected,hours", [
    (PERIOD, {"under_bark": ("39.075000", 5), "over_bark": ("16.000000", 4), "unknown": ("1.125000", 1)}, [13.5, None, None]),
    ("start=2026-09-14&end=2026-09-14", {"under_bark": ("27.950000", 3), "over_bark": ("7.000000", 2)}, [8.0, None, None]),
    ("start=2026-09-15&end=2026-09-15", {"under_bark": ("11.125000", 2), "over_bark": ("9.000000", 2), "unknown": ("1.125000", 1)}, [4.5, None, None]),
    ("start=2026-09-16&end=2026-09-16", {}, [None, None, None]),
])
def test_api_and_csv_exact_period_totals(demo_api, period, expected, hours):
    response = demo_api.get(f"/api/fleet?{period}")
    assert response.status_code == 200
    fleet = response.json()
    assert total_values(fleet["totals"]) == expected
    assert [machine["engine_hours"] for machine in fleet["machines"]] == hours
    response = demo_api.get(f"/api/exports/ledger.csv?{period}")
    assert response.status_code == 200
    ledger = list(csv.DictReader(io.StringIO(response.text)))
    assert fleet["record_count"] == len(ledger) == sum(value[1] for value in expected.values())
    assert len({row["event_id"] for row in ledger}) == len(ledger)
    for basis, (total, records) in expected.items():
        rows = [row for row in ledger if row["basis"] == basis]
        assert len(rows) == records
        assert sum(Decimal(row["volume_m3"]) for row in rows) == Decimal(total)


def test_api_per_machine_totals_and_unknown_mixed_method_warnings(demo_api):
    fleet = demo_api.get(f"/api/fleet?{PERIOD}").json()
    assert [total_values(machine["totals"]) for machine in fleet["machines"]] == [
        {"under_bark": ("30.950000", 3), "over_bark": ("13.250000", 3)},
        {"under_bark": ("8.125000", 2), "over_bark": ("2.750000", 1), "unknown": ("1.125000", 1)}, {},
    ]
    second = {row["basis"]: row for row in fleet["machines"][1]["totals"]}
    assert second["under_bark"]["provenance"]["method_versions"] == ["synthetic-v2-a", "synthetic-v2-b"]
    assert any("сопоставимость методик не подтверждена" in warning for warning in second["under_bark"]["warnings"])
    assert second["unknown"]["provenance"]["method_versions"] == ["unknown"]
    assert any("неизвестной версией метода" in warning for warning in second["unknown"]["warnings"])
