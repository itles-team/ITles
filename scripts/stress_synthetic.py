"""In-process load/consistency probe; no network, OEM data or performance SLA."""

import argparse
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import time
from uuid import NAMESPACE_URL, uuid5

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.db import connect, hash_secret, initialize, iso, utcnow


def run(records: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="itles-synthetic-") as directory:
        path = str(Path(directory) / "probe.sqlite3")
        conn = connect(path)
        initialize(conn)
        conn.execute("INSERT INTO organizations VALUES('probe','Synthetic probe','probe',NULL,0)")
        conn.execute("INSERT INTO machines VALUES('probe-machine','probe','Synthetic machine',NULL,NULL,NULL)")
        conn.execute("INSERT INTO device_tokens VALUES(?,?,?,?)", (hash_secret("probe-token"), "probe", "probe-machine", iso(utcnow())))
        conn.execute("INSERT INTO sessions VALUES(?,?,?)", (hash_secret("probe-session"), "probe", "2099-01-01T00:00:00.000000Z"))
        conn.commit()
        client = TestClient(create_app(path))
        client.cookies.set("itles_session", "probe-session")
        started = time.monotonic()
        repeats = 0
        for batch_index, offset in enumerate(range(0, records, 500)):
            packet = {"schema_version": 1, "batch_id": str(uuid5(NAMESPACE_URL, f"probe:batch:{batch_index}")), "events": [
                {"event_id": str(uuid5(NAMESPACE_URL, f"probe:item:{i}")), "machine_id": "probe-machine",
                 "occurred_at": "2026-01-10T12:00:00.123456Z", "kind": "production", "volume_m3": "0.123456",
                 "basis": "under_bark", "source": "onboard_measurement", "method": "harvester_onboard",
                 "method_version": "synthetic-v1"}
                for i in range(offset, min(offset + 500, records))
            ]}
            for attempt in range(2):
                response = client.post("/api/ingest", headers={"Authorization": "Bearer probe-token"}, json=packet)
                assert response.status_code == 200, response.text
                expected = len(packet["events"])
                assert response.json()["accepted"] == (expected if attempt == 0 else 0)
                assert response.json()["duplicates"] == (expected if attempt == 1 else 0)
                repeats += expected if attempt else 0
        ingest_seconds = time.monotonic() - started
        query_started = time.monotonic()
        fleet = client.get("/api/fleet?start=2026-01-10&end=2026-01-10").json()
        assert fleet["record_count"] == records
        assert Decimal(fleet["totals"][0]["volume_m3"]) == records * Decimal("0.123456")
        assert conn.execute("SELECT COUNT(*) FROM production").fetchone()[0] == records
        conn.close()
        return {"status": "passed", "evidence": "synthetic_in_process_not_network_or_field",
                "records": records, "duplicate_deliveries": repeats,
                "total_m3": fleet["totals"][0]["volume_m3"],
                "ingest_and_retries_seconds": round(ingest_seconds, 3),
                "fleet_query_seconds": round(time.monotonic() - query_started, 3)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--records", type=int, default=10_000)
    args = parser.parse_args()
    if not 1 <= args.records <= 100_000:
        parser.error("records must be between 1 and 100000")
    print(json.dumps(run(args.records), ensure_ascii=False, indent=2))
