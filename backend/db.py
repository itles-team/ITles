import hashlib
import json
import os
import secrets
import sqlite3
from datetime import UTC, datetime
from pathlib import Path


def utcnow() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def connect(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    if path != ":memory:" and not path.startswith("file:"):
        os.chmod(path, 0o600)
    return conn


def initialize(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL UNIQUE,
          password_hash TEXT, is_demo INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS machines (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          name TEXT NOT NULL, model TEXT, head TEXT, computer TEXT
        );
        CREATE TABLE IF NOT EXISTS device_tokens (
          token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          machine_id TEXT NOT NULL REFERENCES machines(id), created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ingest_batches (
          organization_id TEXT NOT NULL, machine_id TEXT NOT NULL, batch_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL, received_at TEXT NOT NULL,
          PRIMARY KEY (organization_id, machine_id, batch_id)
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, machine_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL,
          canonical_payload TEXT NOT NULL, received_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS measurements (
          event_id TEXT NOT NULL REFERENCES events(event_id), machine_id TEXT NOT NULL,
          metric_key TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS measurements_latest ON measurements(machine_id, metric_key, observed_at DESC);
        CREATE TABLE IF NOT EXISTS positions (
          event_id TEXT PRIMARY KEY REFERENCES events(event_id), machine_id TEXT NOT NULL,
          latitude REAL NOT NULL, longitude REAL NOT NULL, observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS positions_track ON positions(machine_id, observed_at);
        CREATE TABLE IF NOT EXISTS production (
          event_id TEXT PRIMARY KEY REFERENCES events(event_id), machine_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL, volume_micro_m3 INTEGER NOT NULL, basis TEXT NOT NULL,
          source TEXT NOT NULL, method TEXT NOT NULL, method_version TEXT NOT NULL,
          calibration_ref TEXT
        );
        CREATE INDEX IF NOT EXISTS production_period ON production(machine_id, occurred_at);
        CREATE TABLE IF NOT EXISTS ingest_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, machine_id TEXT,
          received_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT
        );
        """
    )
    production_columns = {row["name"] for row in conn.execute("PRAGMA table_info(production)")}
    if "method_version" not in production_columns:
        conn.execute("ALTER TABLE production ADD COLUMN method_version TEXT NOT NULL DEFAULT 'unknown'")
    if "calibration_ref" not in production_columns:
        conn.execute("ALTER TABLE production ADD COLUMN calibration_ref TEXT")
    # Fixed precision keeps chronological TEXT ordering valid across old and new rows.
    for table, columns in {
        "device_tokens": ("created_at",), "sessions": ("expires_at",),
        "ingest_batches": ("received_at",), "events": ("occurred_at", "received_at"),
        "measurements": ("observed_at",), "positions": ("observed_at",),
        "production": ("occurred_at",), "ingest_audit": ("received_at",),
    }.items():
        for column in columns:
            conn.execute(f"UPDATE {table} SET {column}=substr({column},1,19)||'.000000Z' WHERE length({column})=20 AND {column} LIKE '%Z'")
    conn.commit()


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 310_000)
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def password_matches(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, salt, digest = stored.split("$", 2)
    except ValueError:
        return False
    return secrets.compare_digest(password_hash(password, salt), stored)


def canonical_hash(value: object) -> tuple[str, str]:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest(), canonical


def new_id() -> str:
    return secrets.token_urlsafe(18)


def default_db_path() -> str:
    return os.getenv("ITLES_DB_PATH", ".local/itles.sqlite3")
