import csv
import io
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from collections import deque
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Iterator

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from .db import canonical_hash, connect, default_db_path, hash_secret, initialize, iso, new_id, password_matches, utcnow
from .schemas import IngestBatch, LoginRequest, METRICS
from .seed import seed_demo

SESSION_COOKIE = "itles_session"
FRESH_TTL = timedelta(hours=2)
MAX_INGEST_BYTES = 512 * 1024
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LOGIN_LIMIT = 5
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_LOCK_SECONDS = 15 * 60
LOGIN_TRACKED_ACCOUNTS = 1024
DEMO_LOGIN_LIMIT = 20
DEMO_LOGIN_WINDOW_SECONDS = 10 * 60
DEMO_SESSION_CAP = 8
DUMMY_PASSWORD_HASH = "pbkdf2_sha256$9e347f8194a6f1de7b8ce4477dceff8a$7f293bd9efbc9f3cd24f5a75a8ad099bd1d2f8ae283e550cbfc6d68d4ba6653f"


class LoginLimiter:
    """Process-local, bounded account-code throttle; it intentionally stores no IP addresses."""

    def __init__(self):
        self._records: dict[str, tuple[int, float, float]] = {}
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        self._records = {key: value for key, value in self._records.items() if value[2] > now or value[1] > now - LOGIN_WINDOW_SECONDS}
        if len(self._records) > LOGIN_TRACKED_ACCOUNTS:
            oldest = sorted(self._records, key=lambda key: self._records[key][1])[:len(self._records) - LOGIN_TRACKED_ACCOUNTS]
            for key in oldest:
                self._records.pop(key, None)

    def allowed(self, account: str) -> bool:
        now = time.monotonic()
        with self._lock:
            self._prune(now)
            record = self._records.get(hash_secret(account))
            return not record or record[2] <= now

    def failed(self, account: str) -> None:
        now = time.monotonic()
        key = hash_secret(account)
        with self._lock:
            self._prune(now)
            previous = self._records.get(key)
            failures = previous[0] + 1 if previous and previous[1] > now - LOGIN_WINDOW_SECONDS else 1
            blocked_until = now + LOGIN_LOCK_SECONDS if failures >= LOGIN_LIMIT else 0.0
            self._records[key] = (failures, now, blocked_until)

    def succeeded(self, account: str) -> None:
        with self._lock:
            self._records.pop(hash_secret(account), None)


class DemoLoginLimiter:
    """Global process-local limit for an intentionally public demo endpoint."""

    def __init__(self):
        self._attempts: deque[float] = deque()
        self._lock = threading.Lock()

    def allowed(self) -> bool:
        now = time.monotonic()
        with self._lock:
            while self._attempts and self._attempts[0] <= now - DEMO_LOGIN_WINDOW_SECONDS:
                self._attempts.popleft()
            if len(self._attempts) >= DEMO_LOGIN_LIMIT:
                return False
            self._attempts.append(now)
            return True


LOGIN_LIMITER = LoginLimiter()
DEMO_LOGIN_LIMITER = DemoLoginLimiter()


class IngestSizeLimitMiddleware:
    """Bound buffered ingest payloads before Pydantic parses their JSON."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] not in {"/api/ingest", "/api/auth/login"}:
            await self.app(scope, receive, send)
            return

        messages = []
        size = 0
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.request":
                size += len(message.get("body", b""))
                if size > MAX_INGEST_BYTES:
                    await JSONResponse({"detail": "ingest request body is too large"}, status_code=413)(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                break

        index = 0

        async def replay():
            nonlocal index
            if index < len(messages):
                message = messages[index]
                index += 1
                return message
            return {"type": "http.disconnect"}

        await self.app(scope, replay, send)


def _date_range(start: str | None, end: str | None) -> tuple[date, date]:
    try:
        if (start is not None and not DATE_PATTERN.fullmatch(start)) or (end is not None and not DATE_PATTERN.fullmatch(end)):
            raise ValueError
        start_date = date.fromisoformat(start) if start else utcnow().date()
        end_date = date.fromisoformat(end) if end else start_date
    except ValueError as exc:
        raise HTTPException(422, "start and end must be YYYY-MM-DD") from exc
    if end_date < start_date or (end_date - start_date).days > 3660:
        raise HTTPException(422, "invalid date range")
    return start_date, end_date


def _bounds(start: date, end: date) -> tuple[str, str]:
    if end == date.max:
        raise HTTPException(422, "end date is outside the supported range")
    begin = datetime.combine(start, datetime.min.time(), UTC)
    finish = datetime.combine(end + timedelta(days=1), datetime.min.time(), UTC)
    return iso(begin), iso(finish)


def _decimal(micro: int) -> str:
    return format(Decimal(micro) / Decimal(1_000_000), ".6f")


def _metric_value(row: sqlite3.Row | None, key: str) -> dict:
    label, unit, _, _ = METRICS[key]
    if row is None:
        return {"key": key, "label": label, "value": None, "unit": unit, "observed_at": None,
                "status": "missing", "source": "telemetry", "explanation": "Показатель не поступал.",
                "norm": None}
    observed = datetime.fromisoformat(row["observed_at"].replace("Z", "+00:00"))
    status = "fresh" if utcnow() - observed <= FRESH_TTL else "stale"
    return {"key": key, "label": label, "value": row["value"], "unit": row["unit"],
            "observed_at": row["observed_at"], "status": status, "source": "telemetry",
            "explanation": "Норматив не задан: он зависит от конкретной машины, узла и документации.",
            "norm": None}


def _machine_payload(conn: sqlite3.Connection, organization_id: str, machine: sqlite3.Row) -> dict:
    latest: dict[str, sqlite3.Row] = {}
    for row in conn.execute(
        "SELECT * FROM measurements WHERE machine_id=? ORDER BY observed_at DESC, event_id DESC",
        (machine["id"],),
    ):
        latest.setdefault(row["metric_key"], row)
    position = conn.execute("SELECT * FROM positions WHERE machine_id=? ORDER BY observed_at DESC LIMIT 1", (machine["id"],)).fetchone()
    seen = conn.execute("SELECT MAX(occurred_at) AS value FROM events WHERE machine_id=?", (machine["id"],)).fetchone()["value"]
    position_payload = None
    if position:
        observed = datetime.fromisoformat(position["observed_at"].replace("Z", "+00:00"))
        position_payload = {"latitude": position["latitude"], "longitude": position["longitude"],
                            "observed_at": position["observed_at"], "status": "fresh" if utcnow() - observed <= FRESH_TTL else "stale"}
    connection_status = "fresh" if seen and utcnow() - datetime.fromisoformat(seen.replace("Z", "+00:00")) <= FRESH_TTL else ("stale" if seen else "missing")
    return {"id": machine["id"], "name": machine["name"], "model": machine["model"], "head": machine["head"],
            "computer": machine["computer"], "connection_status": connection_status,
            "metrics": [_metric_value(latest.get(key), key) for key in METRICS], "position": position_payload,
            "last_seen": seen}


def _totals(conn: sqlite3.Connection, organization_id: str, start: date, end: date, machine_id: str | None = None) -> list[dict]:
    begin, finish = _bounds(start, end)
    where = "e.organization_id=? AND p.occurred_at>=? AND p.occurred_at<?"
    values: list[str] = [organization_id, begin, finish]
    if machine_id:
        where += " AND p.machine_id=?"
        values.append(machine_id)
    rows = conn.execute(f"""SELECT p.basis, COALESCE(SUM(p.volume_micro_m3),0) volume, COUNT(*) records,
                                   GROUP_CONCAT(DISTINCT p.source) sources,
                                   GROUP_CONCAT(DISTINCT p.method) methods,
                                   GROUP_CONCAT(DISTINCT p.method_version) method_versions,
                                   GROUP_CONCAT(DISTINCT p.calibration_ref) calibration_refs
                            FROM production p JOIN events e ON e.event_id=p.event_id
                            WHERE {where} GROUP BY p.basis ORDER BY p.basis""", values).fetchall()
    results = []
    for row in rows:
        provenance = {
            "sources": sorted((row["sources"] or "").split(",") if row["sources"] else []),
            "methods": sorted((row["methods"] or "").split(",") if row["methods"] else []),
            "method_versions": sorted((row["method_versions"] or "").split(",") if row["method_versions"] else []),
            "calibration_refs": sorted((row["calibration_refs"] or "").split(",") if row["calibration_refs"] else []),
        }
        warnings = []
        if "unknown" in provenance["method_versions"]:
            warnings.append("Есть записи с неизвестной версией метода; они не подтверждают физическую точность объёма.")
        if len(provenance["methods"]) > 1 or len(provenance["method_versions"]) > 1:
            warnings.append("В итоге смешаны методы или версии расчёта. Сумма арифметическая; сопоставимость методик не подтверждена.")
        results.append({"basis": row["basis"], "volume_m3": _decimal(row["volume"]), "records": row["records"],
                        "provenance": provenance, "warnings": warnings})
    return results


def _engine_hours_for_period(conn: sqlite3.Connection, machine_id: str, start: date, end: date) -> float | None:
    begin, finish = _bounds(start, end)
    rows = conn.execute(
        """SELECT value FROM measurements WHERE machine_id=? AND metric_key='engine_hours_total'
           AND observed_at>=? AND observed_at<? ORDER BY observed_at, event_id""",
        (machine_id, begin, finish),
    ).fetchall()
    if len(rows) < 2:
        return None
    values = [float(row["value"]) for row in rows]
    if any(current < previous for previous, current in zip(values, values[1:])):
        return None
    return values[-1] - values[0]


def _has_engine_hour_reset(conn: sqlite3.Connection, organization_id: str) -> bool:
    rows = conn.execute(
        """SELECT m.machine_id,m.value FROM measurements m JOIN machines machine ON machine.id=m.machine_id
           WHERE machine.organization_id=? AND m.metric_key='engine_hours_total'
           ORDER BY m.machine_id,m.observed_at,m.event_id""",
        (organization_id,),
    ).fetchall()
    latest_by_machine: dict[str, float] = {}
    for row in rows:
        previous = latest_by_machine.get(row["machine_id"])
        current = float(row["value"])
        if previous is not None and current < previous:
            return True
        latest_by_machine[row["machine_id"]] = current
    return False


def create_app(db_path: str | None = None) -> FastAPI:
    app = FastAPI(title="ITles telemetry API", version="1.0", docs_url=None, redoc_url=None)
    app.add_middleware(IngestSizeLimitMiddleware)
    app.state.db_path = db_path or default_db_path()
    init_lock = threading.Lock()
    initialized = False

    @contextmanager
    def db() -> Iterator[sqlite3.Connection]:
        nonlocal initialized
        with init_lock:
            if not initialized:
                connection = connect(app.state.db_path)
                try:
                    initialize(connection)
                finally:
                    connection.close()
                initialized = True
        current = connect(app.state.db_path)
        try:
            yield current
            current.commit()
        except Exception:
            current.rollback()
            raise
        finally:
            current.close()

    def audit(conn: sqlite3.Connection, org: str, machine: str | None, status: str, reason: str | None = None) -> None:
        conn.execute("INSERT INTO ingest_audit(organization_id,machine_id,received_at,status,reason) VALUES(?,?,?,?,?)",
                     (org, machine, iso(utcnow()), status, reason))

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, _exc: RequestValidationError):
        # Never echo rejected payloads: they may contain data that must not be retained or exposed.
        if request.url.path == "/api/ingest":
            authorization = request.headers.get("authorization", "")
            if authorization.startswith("Bearer "):
                token = authorization.removeprefix("Bearer ").strip()
                if token and len(token) <= 512:
                    with db() as conn:
                        identity = conn.execute(
                            "SELECT organization_id,machine_id FROM device_tokens WHERE token_hash=?",
                            (hash_secret(token),),
                        ).fetchone()
                        if identity:
                            audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "invalid_schema")
            return JSONResponse({"detail": "invalid ingest schema"}, status_code=422)
        return JSONResponse({"detail": "invalid request"}, status_code=422)

    def current_session(itles_session: str | None = Cookie(default=None)) -> dict:
        if not itles_session:
            raise HTTPException(401, "authentication required")
        with db() as conn:
            row = conn.execute("""SELECT o.id,o.name,o.is_demo,s.expires_at FROM sessions s JOIN organizations o ON o.id=s.organization_id
                                  WHERE s.token_hash=?""", (hash_secret(itles_session),)).fetchone()
            if not row or row["expires_at"] <= iso(utcnow()):
                raise HTTPException(401, "authentication required")
            return dict(row)

    def device_identity(authorization: str | None = Header(default=None)) -> dict:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "device bearer token required")
        token = authorization.removeprefix("Bearer ").strip()
        if not token or len(token) > 512:
            raise HTTPException(401, "device bearer token required")
        with db() as conn:
            row = conn.execute("SELECT organization_id,machine_id FROM device_tokens WHERE token_hash=?", (hash_secret(token),)).fetchone()
            if not row:
                raise HTTPException(401, "invalid device token")
            return dict(row)

    def set_session(response: Response, org_id: str, *, is_demo: bool) -> None:
        token = secrets.token_urlsafe(32)
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE expires_at<=?", (iso(utcnow()),))
            conn.execute("INSERT INTO sessions(token_hash,organization_id,expires_at) VALUES(?,?,?)",
                         (hash_secret(token), org_id, iso(utcnow() + timedelta(days=7))))
            if is_demo:
                excess = conn.execute("SELECT COUNT(*) count FROM sessions WHERE organization_id=?", (org_id,)).fetchone()["count"] - DEMO_SESSION_CAP
                if excess > 0:
                    conn.execute("DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE organization_id=? ORDER BY rowid ASC LIMIT ?)", (org_id, excess))
        response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="strict",
                            secure=os.getenv("ITLES_COOKIE_SECURE", "1") == "1", max_age=7 * 86400, path="/")

    def session_payload(row: dict | sqlite3.Row) -> dict:
        result = {"organization": {"id": row["id"], "name": row["name"]}, "demo": bool(row["is_demo"])}
        if row["is_demo"]:
            with db() as conn:
                period = conn.execute("SELECT MIN(occurred_at) first,MAX(occurred_at) last FROM events WHERE organization_id=?", (row["id"],)).fetchone()
            if period["first"]:
                result["data_period"] = {"start": period["first"][:10], "end": period["last"][:10]}
        return result

    @app.get("/api/health")
    def health():
        with db() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"status": "ok"}

    @app.post("/api/auth/login")
    def login(payload: LoginRequest, response: Response):
        if not LOGIN_LIMITER.allowed(payload.account):
            raise HTTPException(429, "too many login attempts; try again later")
        with db() as conn:
            row = conn.execute("SELECT id,name,is_demo,password_hash FROM organizations WHERE account=? AND is_demo=0", (payload.account,)).fetchone()
        # An unknown account gets the same expensive password operation as a known one.
        valid_password = password_matches(payload.password, row["password_hash"] if row else DUMMY_PASSWORD_HASH)
        if not row or not valid_password:
            LOGIN_LIMITER.failed(payload.account)
            raise HTTPException(401, "invalid account or password")
        LOGIN_LIMITER.succeeded(payload.account)
        set_session(response, row["id"], is_demo=False)
        return session_payload(row)

    @app.post("/api/auth/demo")
    def demo_login(response: Response):
        if os.getenv("ITLES_DEMO_ENABLED", "0").lower() not in {"1", "true", "yes"}:
            raise HTTPException(404, "demo is disabled")
        if not DEMO_LOGIN_LIMITER.allowed():
            raise HTTPException(429, "demo session limit reached; try again later")
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            org_id = seed_demo(conn)
            row = conn.execute("SELECT id,name,is_demo FROM organizations WHERE id=?", (org_id,)).fetchone()
        set_session(response, org_id, is_demo=True)
        return session_payload(row)

    @app.get("/api/auth/me")
    def me(session: dict = Depends(current_session)):
        return session_payload(session)

    @app.post("/api/auth/logout")
    def logout(response: Response, itles_session: str | None = Cookie(default=None)):
        if itles_session:
            with db() as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (hash_secret(itles_session),))
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @app.get("/api/machines")
    def machines(session: dict = Depends(current_session)):
        with db() as conn:
            rows = conn.execute("SELECT * FROM machines WHERE organization_id=? ORDER BY name", (session["id"],)).fetchall()
            return {"machines": [_machine_payload(conn, session["id"], row) for row in rows], "demo": bool(session["is_demo"])}

    @app.get("/api/fleet")
    def fleet(start: str | None = Query(None), end: str | None = Query(None), session: dict = Depends(current_session)):
        start_date, end_date = _date_range(start, end)
        begin, finish = _bounds(start_date, end_date)
        with db() as conn:
            machine_rows = conn.execute("SELECT * FROM machines WHERE organization_id=? ORDER BY name", (session["id"],)).fetchall()
            data = []
            for row in machine_rows:
                data.append({"id": row["id"], "name": row["name"], "totals": _totals(conn, session["id"], start_date, end_date, row["id"]),
                             "engine_hours": _engine_hours_for_period(conn, row["id"], start_date, end_date)})
            count = conn.execute("""SELECT COUNT(*) value FROM production p JOIN events e ON e.event_id=p.event_id
                                   WHERE e.organization_id=? AND p.occurred_at>=? AND p.occurred_at<?""", (session["id"], begin, finish)).fetchone()["value"]
            return {"period": {"start": start_date.isoformat(), "end": end_date.isoformat()}, "totals": _totals(conn, session["id"], start_date, end_date),
                    "machines": data, "record_count": count}

    @app.get("/api/machines/{machine_id}")
    def machine(machine_id: str, start: str | None = Query(None), end: str | None = Query(None), session: dict = Depends(current_session)):
        start_date, end_date = _date_range(start, end)
        begin, finish = _bounds(start_date, end_date)
        with db() as conn:
            row = conn.execute("SELECT * FROM machines WHERE id=? AND organization_id=?", (machine_id, session["id"])).fetchone()
            if not row:
                raise HTTPException(404, "machine not found")
            result = _machine_payload(conn, session["id"], row)
            production = conn.execute("""SELECT p.* FROM production p JOIN events e ON e.event_id=p.event_id WHERE e.organization_id=?
                                      AND p.machine_id=? AND p.occurred_at>=? AND p.occurred_at<? ORDER BY p.occurred_at""", (session["id"], machine_id, begin, finish)).fetchall()
            track = conn.execute("SELECT latitude,longitude,observed_at FROM positions WHERE machine_id=? AND observed_at>=? AND observed_at<? ORDER BY observed_at", (machine_id, begin, finish)).fetchall()
            result.update({"production": [{"event_id": x["event_id"], "occurred_at": x["occurred_at"], "volume_m3": _decimal(x["volume_micro_m3"]), "basis": x["basis"], "source": x["source"], "method": x["method"], "method_version": x["method_version"], "calibration_ref": x["calibration_ref"]} for x in production],
                           "totals": _totals(conn, session["id"], start_date, end_date, machine_id), "track": [dict(x) for x in track],
                           "engine_hours": _engine_hours_for_period(conn, machine_id, start_date, end_date)})
            return result

    @app.post("/api/ingest")
    def ingest(batch: IngestBatch, identity: dict = Depends(device_identity)):
        # Pydantic already rejects unrecognized fields before any data reaches storage.
        if any(event.machine_id != identity["machine_id"] for event in batch.events):
            with db() as conn:
                audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "token_machine_mismatch")
            raise HTTPException(403, "device token is scoped to one machine")
        normalized = batch.model_dump(mode="json")
        batch_hash, _ = canonical_hash(normalized)
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            batch_row = conn.execute("SELECT payload_hash FROM ingest_batches WHERE organization_id=? AND machine_id=? AND batch_id=?", (identity["organization_id"], identity["machine_id"], str(batch.batch_id))).fetchone()
            if batch_row:
                if batch_row["payload_hash"] != batch_hash:
                    audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "batch_id_conflict")
                    return JSONResponse({"detail": "batch_id was already submitted with a different payload"}, status_code=409)
                audit(conn, identity["organization_id"], identity["machine_id"], "duplicates", "repeat_batch")
                return {"batch_id": str(batch.batch_id), "accepted": 0, "duplicates": len(batch.events), "rejected": 0}
            event_hashes = [(event, *canonical_hash(event.model_dump(mode="json"))) for event in batch.events]
            for event, digest, _ in event_hashes:
                prior = conn.execute("SELECT organization_id,payload_hash FROM events WHERE event_id=?", (str(event.event_id),)).fetchone()
                if prior and prior["organization_id"] != identity["organization_id"]:
                    audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "event_id_unavailable")
                    return JSONResponse({"detail": "event_id is unavailable"}, status_code=409)
                if prior and prior["payload_hash"] != digest:
                    audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "event_id_conflict")
                    return JSONResponse({"detail": "event_id was already submitted with a different payload"}, status_code=409)
            accepted = 0
            duplicates = 0
            for event, digest, canonical in event_hashes:
                if conn.execute("SELECT 1 FROM events WHERE event_id=?", (str(event.event_id),)).fetchone():
                    duplicates += 1
                    continue
                event_id = str(event.event_id)
                occurred = iso(event.occurred_at)
                conn.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)", (event_id, identity["organization_id"], event.machine_id, occurred, event.kind, digest, canonical, iso(utcnow())))
                if event.kind == "telemetry":
                    conn.executemany("INSERT INTO measurements VALUES(?,?,?,?,?,?)", [(event_id, event.machine_id, item.key, float(item.value), item.unit, occurred) for item in event.measurements])
                    if event.position:
                        conn.execute("INSERT INTO positions VALUES(?,?,?,?,?)", (event_id, event.machine_id, event.position.latitude, event.position.longitude, occurred))
                else:
                    micro = int(event.volume_m3 * Decimal(1_000_000))
                    conn.execute(
                        "INSERT INTO production VALUES(?,?,?,?,?,?,?,?,?)",
                        (event_id, event.machine_id, occurred, micro, event.basis, event.source, event.method,
                         event.method_version, event.calibration_ref),
                    )
                accepted += 1
            conn.execute("INSERT INTO ingest_batches VALUES(?,?,?,?,?)", (identity["organization_id"], identity["machine_id"], str(batch.batch_id), batch_hash, iso(utcnow())))
            audit(conn, identity["organization_id"], identity["machine_id"], "accepted" if accepted else "duplicates", None)
            return {"batch_id": str(batch.batch_id), "accepted": accepted, "duplicates": duplicates, "rejected": 0}

    @app.get("/api/exports/ledger.csv")
    def ledger(start: str | None = Query(None), end: str | None = Query(None), session: dict = Depends(current_session)):
        start_date, end_date = _date_range(start, end)
        begin, finish = _bounds(start_date, end_date)
        with db() as conn:
            rows = conn.execute("""SELECT p.event_id,p.machine_id,p.occurred_at,p.volume_micro_m3,p.basis,p.source,p.method,p.method_version,p.calibration_ref FROM production p
                JOIN events e ON e.event_id=p.event_id WHERE e.organization_id=? AND p.occurred_at>=? AND p.occurred_at<? ORDER BY p.occurred_at""", (session["id"], begin, finish)).fetchall()
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(["event_id", "machine_id", "occurred_at_utc", "volume_m3", "basis", "source", "method", "method_version", "calibration_ref"])
        for row in rows:
            writer.writerow([row["event_id"], row["machine_id"], row["occurred_at"], _decimal(row["volume_micro_m3"]), row["basis"], row["source"], row["method"], row["method_version"], row["calibration_ref"] or ""])
        return StreamingResponse(iter([output.getvalue()]), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": "attachment; filename=itles-ledger.csv"})

    @app.get("/api/quality")
    def quality(session: dict = Depends(current_session)):
        with db() as conn:
            rows = conn.execute("SELECT status,COUNT(*) count FROM ingest_audit WHERE organization_id=? GROUP BY status", (session["id"],)).fetchall()
            counts = {"accepted": 0, "duplicates": 0, "rejected": 0}
            counts.update({r["status"]: r["count"] for r in rows})
            recent = conn.execute("SELECT received_at,status,reason,machine_id FROM ingest_audit WHERE organization_id=? ORDER BY id DESC LIMIT 50", (session["id"],)).fetchall()
            has_engine_hour_reset = _has_engine_hour_reset(conn, session["id"])
        limitations = [
            "Приём данных не подтверждает исправность штатных датчиков или достоверность первичного измерения.",
            "Объём хранится как дельта события и не заменяет сверку с приёмкой и калибровкой машины.",
            "Класс метода не является расчётной формулой: для физических выводов обязательна известная версия метода; unknown исключает такие утверждения.",
            "CSV — нормализованный журнал, а не заявленная интеграция с конкретной конфигурацией 1С.",
        ]
        if has_engine_hour_reset:
            limitations.append("Зафиксировано уменьшение счётчика моточасов: наработка за затронутый период показана как недоступная до проверки сброса или замены счётчика.")
        return {"counts": counts, "recent": [dict(row) for row in recent], "limitations": limitations}

    @app.get("/api/methodology")
    def methodology(session: dict = Depends(current_session)):
        return {"production": {"model": "per_item_delta", "storage": "integer micro m³", "bases": ["under_bark", "over_bark", "unknown"],
                               "provenance_categories": {"source": ["onboard_measurement", "operator_export", "accounting_import"], "method": ["harvester_onboard", "merchantable_log", "manual_ledger"]},
                               "method_version": "Обязательный технический идентификатор версии расчёта или конфигурации. Класс method не является формулой; unknown допустим, но не поддерживает физические заявления о точности.",
                               "limitations": "Метод и источник — только категории происхождения данных, не версия OEM-методики и не подтверждение калибровки. Точность определяется документацией, калибровкой и полевой сверкой конкретной машины."},
                "telemetry": {"out_of_order": "Поздние события сохраняются в журнале, но последние значения выбираются по времени наблюдения.",
                              "norms": "Универсальные нормы не задаются без подтверждённой документации модели и узла."}}

    return app
