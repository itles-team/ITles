"""Disk-backed, at-least-once transport for the normalized ITles contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
from typing import Callable
from urllib import error, parse, request

MAX_BATCH_BYTES = 512 * 1024
MAX_PENDING_BYTES = 64_000_000
Transport = Callable[[dict], tuple[int, dict]]


def canonical(payload: dict) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def validate(payload: dict) -> dict:
    from backend.schemas import IngestBatch

    return IngestBatch.model_validate(payload).model_dump(mode="json", exclude_none=True)


class Outbox:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.path, timeout=30)
        self.path.chmod(0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS outbox (
                batch_id TEXT PRIMARY KEY,
                payload TEXT,
                digest TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                reason TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                acknowledged_at TEXT
            );
        """)

    def close(self):
        self.db.close()

    def enqueue(self, payload: dict) -> str:
        normalized = validate(payload)
        body = canonical(normalized)
        size = len(body.encode("utf-8"))
        if size > MAX_BATCH_BYTES:
            raise ValueError("Пакет превышает 512 КиБ")
        digest = hashlib.sha256(body.encode()).hexdigest()
        batch_id = str(normalized["batch_id"])
        try:
            self.db.execute("BEGIN IMMEDIATE")
            existing = self.db.execute("SELECT digest,state FROM outbox WHERE batch_id=?", (batch_id,)).fetchone()
            if existing:
                if existing[0] != digest:
                    raise ValueError("batch_id уже использован с другим содержимым")
                self.db.commit()
                return existing[1]
            used = self.db.execute("SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM outbox WHERE payload IS NOT NULL").fetchone()[0]
            if used + size > MAX_PENDING_BYTES:
                raise ValueError("Очередь заполнена; сначала восстановите доставку или разберите карантин")
            self.db.execute("INSERT INTO outbox(batch_id,payload,digest) VALUES (?,?,?)", (batch_id, body, digest))
            self.db.commit()
            return "pending"
        except Exception:
            self.db.rollback()
            raise

    def status(self) -> dict:
        counts = {"pending": 0, "sent": 0, "quarantined": 0}
        counts.update(dict(self.db.execute("SELECT state,COUNT(*) FROM outbox GROUP BY state")))
        return counts

    def flush(self, transport: Transport, limit: int = 100) -> dict:
        rows = self.db.execute("SELECT batch_id,payload,digest FROM outbox WHERE state='pending' ORDER BY created_at,batch_id LIMIT ?", (limit,)).fetchall()
        for batch_id, body, digest in rows:
            if body is None or hashlib.sha256(body.encode()).hexdigest() != digest:
                self._result(batch_id, "quarantined", "local_checksum_mismatch")
                continue
            try:
                payload = json.loads(body)
                validate(payload)
            except (ValueError, TypeError):
                self._result(batch_id, "quarantined", "invalid_local_contract")
                continue
            try:
                status, receipt = transport(payload)
            except (OSError, TimeoutError, ValueError):
                self._result(batch_id, "pending", "transport_unavailable")
                break
            if 200 <= status < 300:
                accepted, duplicates = receipt.get("accepted"), receipt.get("duplicates")
                valid_receipt = (
                    str(receipt.get("batch_id")) == batch_id
                    and type(accepted) is int and type(duplicates) is int
                    and accepted >= 0 and duplicates >= 0
                    and accepted + duplicates == len(payload["events"])
                )
                if valid_receipt:
                    self._result(batch_id, "sent", "acknowledged")
                else:
                    self._result(batch_id, "pending", "invalid_acknowledgement")
                    break
            elif status in (401, 403, 408, 425, 429) or status >= 500:
                self._result(batch_id, "pending", f"retry_http_{status}")
                break
            else:
                self._result(batch_id, "quarantined", f"rejected_http_{status}")
        return self.status()

    def _result(self, batch_id: str, state: str, reason: str):
        with self.db:
            self.db.execute("""
                UPDATE outbox SET state=?, reason=?, attempts=attempts+1,
                    acknowledged_at=CASE WHEN ?='sent' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
                    payload=CASE WHEN ?='sent' THEN NULL ELSE payload END
                WHERE batch_id=? AND state='pending'
            """, (state, reason, state, state, batch_id))


def http_transport(base_url: str, token: str) -> Transport:
    url = parse.urlsplit(base_url)
    if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("Укажите origin сервера без пути, параметров и пароля")
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("Требуется HTTPS; HTTP разрешён только для локального теста")
    if not token:
        raise ValueError("Задайте ITLES_DEVICE_TOKEN; ключ не сохраняется в очереди")

    class NoRedirect(request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = request.build_opener(NoRedirect)

    def send(payload: dict) -> tuple[int, dict]:
        req = request.Request(base_url.rstrip("/") + "/api/ingest", data=canonical(payload).encode(), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=20) as response:
                return response.status, json.loads(response.read(65_536))
        except error.HTTPError as exc:
            return exc.code, {}

    return send


def main() -> int:
    parser = argparse.ArgumentParser(description="Доставка нормализованных событий. Не считывает CAN/StanForD.")
    parser.add_argument("--db", default=".local/outbox.sqlite3")
    commands = parser.add_subparsers(dest="command", required=True)
    enqueue = commands.add_parser("enqueue")
    enqueue.add_argument("file", type=Path)
    flush = commands.add_parser("flush")
    flush.add_argument("--url", required=True)
    commands.add_parser("status")
    args = parser.parse_args()
    outbox = Outbox(args.db)
    try:
        if args.command == "enqueue":
            if args.file.stat().st_size > MAX_BATCH_BYTES:
                raise ValueError("Файл превышает 512 КиБ")
            with args.file.open() as stream:
                payload = json.load(stream)
            print(json.dumps({"state": outbox.enqueue(payload)}, ensure_ascii=False))
        elif args.command == "flush":
            result = outbox.flush(http_transport(args.url, os.environ.get("ITLES_DEVICE_TOKEN", "")))
            print(json.dumps(result))
            return 0 if result["pending"] == 0 and result["quarantined"] == 0 else 2
        else:
            print(json.dumps(outbox.status()))
        return 0
    except (OSError, ValueError, sqlite3.Error):
        # Validation exceptions can contain input values; do not echo them.
        print("Операция отклонена. Проверьте контракт, доступ к диску и настройки; данные не выводятся в журнал.", file=sys.stderr)
        return 1
    finally:
        outbox.close()


if __name__ == "__main__":
    raise SystemExit(main())
