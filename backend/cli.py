import argparse
import getpass
import re
import secrets
import sys

from .db import connect, default_db_path, hash_secret, initialize, new_id, password_hash, iso, utcnow


CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{2,80}$")
EMAIL_PATTERN = re.compile(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b")


def validate_label(parser: argparse.ArgumentParser, value: str | None, field: str) -> None:
    if value is None:
        return
    if not 1 <= len(value) <= 160 or any(ord(char) < 32 for char in value):
        parser.error(f"{field} must contain 1–160 printable characters")
    if EMAIL_PATTERN.search(value):
        print(f"warning: {field} looks like contact data; do not store personal data in labels", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="ITles local provisioning; do not use personal identifiers.")
    parser.add_argument("--db", default=default_db_path())
    commands = parser.add_subparsers(dest="command", required=True)
    org = commands.add_parser("create-organization")
    org.add_argument("--account", required=True)
    org.add_argument("--name", required=True)
    org.add_argument("--password")
    machine = commands.add_parser("create-machine")
    machine.add_argument("--organization-id", required=True)
    machine.add_argument("--id", required=True)
    machine.add_argument("--name", required=True)
    machine.add_argument("--model")
    machine.add_argument("--head")
    machine.add_argument("--computer")
    args = parser.parse_args()
    conn = connect(args.db)
    initialize(conn)
    try:
        if args.command == "create-organization":
            if not CODE_PATTERN.fullmatch(args.account):
                parser.error("account must be a 2–80 character organization code")
            validate_label(parser, args.name, "name")
            password = args.password or getpass.getpass("Organization secret: ")
            if len(password) < 12:
                parser.error("password must be at least 12 characters")
            org_id = new_id()
            conn.execute("INSERT INTO organizations(id,name,account,password_hash,is_demo) VALUES(?,?,?,?,0)", (org_id, args.name, args.account, password_hash(password)))
            conn.commit()
            print(f"organization_id={org_id}")
        else:
            if not conn.execute("SELECT 1 FROM organizations WHERE id=?", (args.organization_id,)).fetchone():
                parser.error("organization_id does not exist")
            if not CODE_PATTERN.fullmatch(args.id):
                parser.error("id must be a 2–80 character machine code")
            validate_label(parser, args.name, "name")
            validate_label(parser, args.model, "model")
            validate_label(parser, args.head, "head")
            validate_label(parser, args.computer, "computer")
            token = secrets.token_urlsafe(32)
            conn.execute("INSERT INTO machines VALUES(?,?,?,?,?,?)", (args.id, args.organization_id, args.name, args.model, args.head, args.computer))
            conn.execute("INSERT INTO device_tokens VALUES(?,?,?,?)", (hash_secret(token), args.organization_id, args.id, iso(utcnow())))
            conn.commit()
            print(f"device_token={token}")  # Deliberately the only time a device credential is revealed.
    finally:
        conn.close()


if __name__ == "__main__":
    main()
