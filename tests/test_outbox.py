"""Contract tests for the disk-backed edge delivery queue."""

from copy import deepcopy
import json
from uuid import uuid4

import pytest

from edge.outbox import Outbox


def batch(*, batch_id=None, event_id=None, volume="5.123456"):
    return {
        "schema_version": 1,
        "batch_id": batch_id or str(uuid4()),
        "events": [{
            "event_id": event_id or str(uuid4()),
            "machine_id": "machine-a",
            "occurred_at": "2026-01-10T12:00:00Z",
            "kind": "production",
            "volume_m3": volume,
            "basis": "under_bark",
            "source": "onboard_measurement",
            "method": "harvester_onboard",
            "method_version": "test-v1",
        }],
    }


@pytest.fixture()
def outbox(tmp_path):
    queue = Outbox(tmp_path / "outbox.sqlite3")
    yield queue
    queue.close()


def acknowledgement(payload):
    return {
        "batch_id": payload["batch_id"],
        "accepted": len(payload["events"]),
        "duplicates": 0,
    }


def row_for(outbox, batch_id):
    return outbox.db.execute(
        "SELECT state, attempts, reason, payload FROM outbox WHERE batch_id=?", (batch_id,)
    ).fetchone()


def test_network_failure_keeps_the_batch_and_resumes_in_order(outbox):
    first, second = batch(), batch()
    outbox.enqueue(first)
    outbox.enqueue(second)

    attempted = []

    def unavailable(payload):
        attempted.append(payload["batch_id"])
        raise OSError("offline")

    assert outbox.flush(unavailable) == {"pending": 2, "sent": 0, "quarantined": 0}
    assert len(attempted) == 1
    failed_batch_id = attempted[0]
    other_batch_id = next(item["batch_id"] for item in (first, second) if item["batch_id"] != failed_batch_id)
    assert row_for(outbox, failed_batch_id)[:3] == ("pending", 1, "transport_unavailable")
    assert row_for(outbox, other_batch_id)[:3] == ("pending", 0, None)

    delivered = []

    def recovered(payload):
        delivered.append(payload["batch_id"])
        return 200, acknowledgement(payload)

    assert outbox.flush(recovered) == {"pending": 0, "sent": 2, "quarantined": 0}
    assert delivered == [failed_batch_id, other_batch_id]
    assert row_for(outbox, failed_batch_id)[:3] == ("sent", 2, "acknowledged")


def test_enqueue_deduplicates_identical_batches_and_rejects_reused_id_with_changes(outbox):
    payload = batch()
    assert outbox.enqueue(payload) == "pending"
    assert outbox.enqueue(deepcopy(payload)) == "pending"
    assert outbox.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 1

    assert outbox.flush(lambda item: (200, acknowledgement(item))) == {"pending": 0, "sent": 1, "quarantined": 0}
    assert outbox.enqueue(deepcopy(payload)) == "sent"

    changed = deepcopy(payload)
    changed["events"][0]["volume_m3"] = "5.123457"
    with pytest.raises(ValueError, match="batch_id"):
        outbox.enqueue(changed)
    assert outbox.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 1


def test_checksum_corruption_is_quarantined_without_attempting_transport(outbox):
    payload = batch()
    outbox.enqueue(payload)
    outbox.db.execute(
        "UPDATE outbox SET payload=? WHERE batch_id=?",
        ("{corrupted", payload["batch_id"]),
    )
    outbox.db.commit()

    def must_not_send(_payload):
        raise AssertionError("corrupt local payload must not reach the transport")

    assert outbox.flush(must_not_send) == {"pending": 0, "sent": 0, "quarantined": 1}
    assert row_for(outbox, payload["batch_id"])[:3] == ("quarantined", 1, "local_checksum_mismatch")


def test_invalid_acknowledgement_with_wrong_batch_id_remains_pending(outbox):
    first, second = batch(), batch()
    outbox.enqueue(first)
    outbox.enqueue(second)
    calls = []

    def wrong_batch(payload):
        calls.append(payload["batch_id"])
        return 200, {"batch_id": str(uuid4()), "accepted": 1, "duplicates": 0}

    assert outbox.flush(wrong_batch) == {"pending": 2, "sent": 0, "quarantined": 0}
    assert len(calls) == 1
    failed_batch_id = calls[0]
    other_batch_id = next(item["batch_id"] for item in (first, second) if item["batch_id"] != failed_batch_id)
    assert row_for(outbox, failed_batch_id)[:3] == ("pending", 1, "invalid_acknowledgement")
    assert row_for(outbox, other_batch_id)[:3] == ("pending", 0, None)


@pytest.mark.parametrize(
    ("status", "expected_state", "reason"),
    [
        (401, "pending", "retry_http_401"),
        (409, "quarantined", "rejected_http_409"),
        (422, "quarantined", "rejected_http_422"),
    ],
)
def test_http_rejection_classes_have_explicit_delivery_outcomes(outbox, status, expected_state, reason):
    payload = batch()
    outbox.enqueue(payload)

    assert outbox.flush(lambda _item: (status, {})) == {
        "pending": int(expected_state == "pending"),
        "sent": 0,
        "quarantined": int(expected_state == "quarantined"),
    }
    assert row_for(outbox, payload["batch_id"])[:3] == (expected_state, 1, reason)


def test_production_decimal_string_is_preserved_on_disk_and_during_delivery(outbox):
    payload = batch(volume="7.120000")
    outbox.enqueue(payload)
    stored_payload = json.loads(row_for(outbox, payload["batch_id"])[3])
    assert stored_payload["events"][0]["volume_m3"] == "7.120000"

    delivered = []
    assert outbox.flush(lambda item: (delivered.append(item) or 200, acknowledgement(item))) == {
        "pending": 0,
        "sent": 1,
        "quarantined": 0,
    }
    assert delivered[0]["events"][0]["volume_m3"] == "7.120000"


@pytest.mark.parametrize("receipt", [None, [], "ok", {"accepted": True, "duplicates": 0}, {"accepted": 1, "duplicates": 0, "rejected": 1}])
def test_malformed_receipts_never_delete_pending_data(outbox, receipt):
    payload = batch()
    outbox.enqueue(payload)
    if isinstance(receipt, dict):
        receipt = receipt | {"batch_id": payload["batch_id"]}
    assert outbox.flush(lambda _: (200, receipt))["pending"] == 1
    stored = row_for(outbox, payload["batch_id"])
    assert stored[2] == "invalid_acknowledgement"
    assert stored[3] is not None
