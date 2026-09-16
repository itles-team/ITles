"""Immutable, synthetic demo-v2 fixture; no OEM data or transport evidence."""
from datetime import datetime, timedelta
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5

from .db import canonical_hash, iso
from .schemas import METRICS


DEMO_VERSION = "demo-v2"
DEMO_ACCOUNT = "demo-fleet-v2"
DEMO_ORG_ID = "demo-karelia-v2"
DEMO_MACHINE_IDS = tuple(f"demo-v2-harvester-{index:02}" for index in range(1, 4))
DEMO_START = "2026-09-14"
DEMO_END = "2026-09-15"

_COMPLETE_KEYS = (
    "fuel_level_pct", "fuel_rate_lph", "fuel_consumed_total_l", "engine_oil_pressure_kpa",
    "engine_oil_temperature_c", "engine_oil_level_pct", "hydraulic_oil_temperature_c",
    "hydraulic_oil_level_pct", "coolant_temperature_c", "engine_rpm", "engine_hours_total",
)
_PARTIAL_KEYS = (
    "fuel_level_pct", "fuel_rate_lph", "engine_oil_temperature_c", "engine_rpm", "engine_hours_total",
)
_TELEMETRY = (
    (0, "2026-09-14T06:00:00.000000Z", (82, 16.5, 18400, 380, 78, 86, 54, 79, 80, 1350, 1200), (61.7800, 34.3300)),
    (0, "2026-09-14T12:00:00.000000Z", (74, 19.2, 18472, 410, 84, 85, 61, 78, 84, 1500, 1204), (61.7812, 34.3335)),
    (0, "2026-09-14T18:00:00.000000Z", (67, 14.8, 18540, 365, 82, 85, 59, 78, 82, 1250, 1208), (61.7826, 34.3370)),
    (0, "2026-09-15T06:00:00.000000Z", (65, 15.1, 18556, 375, 79, 84, 55, 77, 81, 1300, 1209), (61.7838, 34.3410)),
    (0, "2026-09-15T12:00:00.000000Z", (58.5, 18.4, 18632, 405, 85, 84, 63, 77, 85, 1450, 1213.5), (61.7850, 34.3460)),
    (1, "2026-09-14T07:00:00.000000Z", (42, 14.0, 88, 1400, 883), (61.7900, 34.3220)),
    (1, "2026-09-15T07:00:00.000000Z", (37, 13.5, 91, 1350, 886), (61.7920, 34.3270)),
    (1, "2026-09-15T11:00:00.000000Z", (37, 0, 54, 0, 2.25), None),
)
_PRODUCTION = (
    (0, "2026-09-14T08:00:00.000000Z", 12_450_000, "under_bark", "onboard_measurement", "harvester_onboard", "synthetic-v2-a"),
    (0, "2026-09-14T10:00:00.000000Z", 4_250_000, "over_bark", "onboard_measurement", "harvester_onboard", "synthetic-v2-a"),
    (0, "2026-09-14T14:00:00.000000Z", 10_375_000, "under_bark", "onboard_measurement", "harvester_onboard", "synthetic-v2-a"),
    (0, "2026-09-15T08:00:00.000000Z", 8_125_000, "under_bark", "onboard_measurement", "harvester_onboard", "synthetic-v2-a"),
    (0, "2026-09-15T09:00:00.000000Z", 6_125_000, "over_bark", "onboard_measurement", "harvester_onboard", "synthetic-v2-a"),
    (0, "2026-09-15T10:00:00.000000Z", 2_875_000, "over_bark", "onboard_measurement", "harvester_onboard", "synthetic-v2-a"),
    (1, "2026-09-14T10:00:00.000000Z", 5_125_000, "under_bark", "operator_export", "merchantable_log", "synthetic-v2-a"),
    (1, "2026-09-14T15:00:00.000000Z", 2_750_000, "over_bark", "operator_export", "merchantable_log", "synthetic-v2-a"),
    (1, "2026-09-15T08:00:00.000000Z", 3_000_000, "under_bark", "operator_export", "merchantable_log", "synthetic-v2-b"),
    (1, "2026-09-15T10:00:00.000000Z", 1_125_000, "unknown", "accounting_import", "manual_ledger", "unknown"),
)
_AUDIT = (
    (0, "2026-09-14T08:00:30.000000Z", "accepted", "пример принятой записи"),
    (1, "2026-09-15T08:00:30.000000Z", "accepted", "пример принятой записи другой версии метода"),
    (1, "2026-09-15T08:01:00.000000Z", "duplicates", "пример повтора; дополнительного объёма нет"),
    (1, "2026-09-15T09:00:00.000000Z", "rejected", "пример неверной единицы; измерение не добавлено"),
)


def _insert_event(conn, machine_id, occurred, kind, **values):
    event_id = str(uuid5(NAMESPACE_URL, f"itles:{DEMO_VERSION}:{machine_id}:{kind}:{occurred}"))
    payload = {
        "fixture": {"version": DEMO_VERSION, "synthetic": True, "transport_verified": False},
        "event": {"event_id": event_id, "machine_id": machine_id, "occurred_at": occurred, "kind": kind, **values},
    }
    digest, canonical = canonical_hash(payload)
    received = iso(datetime.fromisoformat(occurred.replace("Z", "+00:00")) + timedelta(seconds=30))
    conn.execute(
        "INSERT INTO events VALUES(?,?,?,?,?,?,?,?)",
        (event_id, DEMO_ORG_ID, machine_id, occurred, kind, digest, canonical, received),
    )
    return event_id


def _insert_scenario(conn):
    conn.execute(
        "INSERT INTO organizations(id,name,account,password_hash,is_demo) VALUES(?,?,?,?,1)",
        (DEMO_ORG_ID, "Учебный парк · синтетический сценарий v2", DEMO_ACCOUNT, None),
    )
    conn.executemany("INSERT INTO machines VALUES(?,?,?,?,?,?)", [
        (DEMO_MACHINE_IDS[0], DEMO_ORG_ID, "Харвестер 01", "Fictional H-900", "Fictional 700", "Synthetic computer"),
        (DEMO_MACHINE_IDS[1], DEMO_ORG_ID, "Харвестер 02", "Fictional H-700", "Fictional 600", "Synthetic computer"),
        (DEMO_MACHINE_IDS[2], DEMO_ORG_ID, "Харвестер 03", "Fictional H-500", None, "Synthetic computer"),
    ])
    for index, occurred, values, position in _TELEMETRY:
        machine_id = DEMO_MACHINE_IDS[index]
        keys = _COMPLETE_KEYS if index == 0 else _PARTIAL_KEYS
        measurements = [{"key": key, "value": value, "unit": METRICS[key][1]} for key, value in zip(keys, values, strict=True)]
        coordinates = {"latitude": position[0], "longitude": position[1]} if position else None
        event_id = _insert_event(conn, machine_id, occurred, "telemetry", measurements=measurements, position=coordinates)
        conn.executemany("INSERT INTO measurements VALUES(?,?,?,?,?,?)", [
            (event_id, machine_id, item["key"], item["value"], item["unit"], occurred) for item in measurements
        ])
        if position:
            conn.execute("INSERT INTO positions VALUES(?,?,?,?,?)", (event_id, machine_id, *position, occurred))
    for index, occurred, micro, basis, source, method, version in _PRODUCTION:
        machine_id = DEMO_MACHINE_IDS[index]
        event_id = _insert_event(
            conn, machine_id, occurred, "production", volume_m3=format(Decimal(micro) / Decimal(1_000_000), ".6f"),
            basis=basis, source=source, method=method, method_version=version, calibration_ref=None,
        )
        conn.execute("INSERT INTO production VALUES(?,?,?,?,?,?,?,?,?)", (event_id, machine_id, occurred, micro, basis, source, method, version, None))
    conn.executemany(
        "INSERT INTO ingest_audit(organization_id,machine_id,received_at,status,reason) VALUES(?,?,?,?,?)",
        [(DEMO_ORG_ID, DEMO_MACHINE_IDS[index], received, status,
          f"СИНТЕТИЧЕСКИЙ ПРИМЕР {DEMO_VERSION}: {reason}. Это не результат доставки или теста транспорта.")
         for index, received, status, reason in _AUDIT],
    )


def seed_demo(conn):
    """Create v2 once; leave prior versions and an enclosing transaction untouched."""
    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    conn.execute("SAVEPOINT seed_demo_v2")
    try:
        existing = conn.execute("SELECT id,is_demo FROM organizations WHERE account=?", (DEMO_ACCOUNT,)).fetchone()
        if existing:
            if existing["id"] != DEMO_ORG_ID or not existing["is_demo"]:
                raise ValueError("demo-v2 account is reserved for the synthetic scenario")
        else:
            _insert_scenario(conn)
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT seed_demo_v2")
        conn.execute("RELEASE SAVEPOINT seed_demo_v2")
        if owns_transaction:
            conn.rollback()
        raise
    conn.execute("RELEASE SAVEPOINT seed_demo_v2")
    if owns_transaction:
        conn.commit()
    return DEMO_ORG_ID
