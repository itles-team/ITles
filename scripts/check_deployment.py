"""Check API routing without an organization password or raw response logging."""

import argparse
import sys

import httpx


class DeploymentError(RuntimeError):
    pass


def json_response(response, expected_status):
    if response.headers.get("content-type", "").split(";", 1)[0] != "application/json":
        raise DeploymentError(
            f"{response.request.method} {response.request.url.path}: "
            f"HTTP {response.status_code}, not JSON. Check that /api reaches Python, not static Nginx."
        )
    if response.status_code != expected_status:
        raise DeploymentError(f"{response.request.url.path}: HTTP {response.status_code}, expected {expected_status}")
    try:
        body = response.json()
    except ValueError as error:
        raise DeploymentError(f"{response.request.url.path}: invalid JSON") from error
    if not isinstance(body, dict):
        raise DeploymentError(f"{response.request.url.path}: expected a JSON object")
    return body


def check_deployment(client, *, demo=False):
    health = json_response(client.get("/api/health"), 200)
    if health.get("status") != "ok":
        raise DeploymentError("/api/health: status is not ok")
    json_response(client.get("/api/auth/me"), 401)
    json_response(client.post("/api/auth/login", json={}), 422)
    if demo:
        try:
            session = json_response(client.post("/api/auth/demo", json={}), 200)
            if session.get("demo") is not True:
                raise DeploymentError("/api/auth/demo: response is not marked as demo")
            json_response(client.get("/api/auth/me"), 200)
            machines = json_response(client.get("/api/machines"), 200)
            if not machines.get("machines"):
                raise DeploymentError("/api/machines: no demo machines")
        finally:
            json_response(client.post("/api/auth/logout", json={}), 200)
        json_response(client.get("/api/auth/me"), 401)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--demo", action="store_true")
    args = parser.parse_args()
    try:
        with httpx.Client(base_url=args.url, timeout=20, follow_redirects=False) as client:
            check_deployment(client, demo=args.demo)
    except (DeploymentError, httpx.HTTPError) as error:
        message = str(error) if isinstance(error, DeploymentError) else type(error).__name__
        print(f"FAIL: {message}", file=sys.stderr)
        return 1
    print("PASS: JSON API routing" + (", demo session, machines, logout" if args.demo else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
