"""Explicitly fictional data for a safe UI demonstration, never OEM telemetry."""
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid5

from .db import canonical_hash, iso, new_id, utcnow


DEMO_ACCOUNT = "demo-fleet"


def seed_demo(conn):
    existing = conn.execute("SELECT id FROM organizations WHERE account = ?", (DEMO_ACCOUNT,)).fetchone()
    if existing:
        # Keep a database created by an earlier schema explicit about fixture provenance.
        conn.execute(
            "UPDATE production SET method_version='synthetic-v1' "
            "WHERE method_version='unknown' AND machine_id IN (SELECT id FROM machines WHERE organization_id=?)",
            (existing["id"],),
        )
        conn.commit()
        return existing["id"]
    org_id = "demo-karelia"
    conn.execute(
        "INSERT INTO organizations(id,name,account,password_hash,is_demo) VALUES(?,?,?,?,1)",
        (org_id, "Демонстрационный парк Карелия", DEMO_ACCOUNT, None),
    )
    machines = [
        ("demo-harvester-01", "Харвестер 01", "Fictional H-900", "Fictional 700", "Demo computer"),
        ("demo-harvester-02", "Харвестер 02", "Fictional H-700", "Fictional 600", "Demo computer"),
        ("demo-harvester-03", "Харвестер 03", "Fictional H-500", None, "Demo computer"),
    ]
    conn.executemany("INSERT INTO machines VALUES(?,?,?,?,?,?)", [(mid, org_id, *row) for mid, *row in machines])
    now = utcnow()
    samples = [
        ("demo-harvester-01", now - timedelta(minutes=20), [("fuel_level_pct", 62.5, "%"), ("engine_rpm", 1450, "rpm"), ("engine_hours_total", 1200.5, "h")], (61.785, 34.346)),
        ("demo-harvester-02", now - timedelta(hours=5), [("fuel_level_pct", 37.0, "%"), ("engine_oil_temperature_c", 91.0, "°C"), ("engine_hours_total", 883.25, "h")], (61.792, 34.327)),
        ("demo-harvester-03", now - timedelta(hours=28), [("engine_hours_total", 405.0, "h")], None),
    ]
    for machine_id, occurred, measurements, position in samples:
        event_id = str(uuid5(NAMESPACE_URL, f"itles-demo:{machine_id}:telemetry"))
        payload = {"fixture": True, "machine_id": machine_id, "occurred_at": iso(occurred)}
        digest, canonical = canonical_hash(payload)
        conn.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)", (event_id, org_id, machine_id, iso(occurred), "telemetry", digest, canonical, iso(now)))
        conn.executemany("INSERT INTO measurements VALUES(?,?,?,?,?,?)", [(event_id, machine_id, key, value, unit, iso(occurred)) for key, value, unit in measurements])
        if position:
            conn.execute("INSERT INTO positions VALUES(?,?,?,?,?)", (event_id, machine_id, *position, iso(occurred)))
    # Per-item deltas, deliberately split by measurement basis.
    for index, (machine_id, volume, basis) in enumerate([
        ("demo-harvester-01", 12_450_000, "under_bark"), ("demo-harvester-01", 4_250_000, "over_bark"),
        ("demo-harvester-02", 8_125_000, "under_bark"),
    ]):
        occurred = now - timedelta(hours=index + 2)
        event_id = str(uuid5(NAMESPACE_URL, f"itles-demo:{machine_id}:production:{index}"))
        payload = {"fixture": True, "event_id": event_id}
        digest, canonical = canonical_hash(payload)
        conn.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)", (event_id, org_id, machine_id, iso(occurred), "production", digest, canonical, iso(now)))
        conn.execute(
            "INSERT INTO production VALUES(?,?,?,?,?,?,?,?,?)",
            (event_id, machine_id, iso(occurred), volume, basis, "onboard_measurement", "harvester_onboard", "synthetic-v1", None),
        )
    conn.commit()
    return org_id
