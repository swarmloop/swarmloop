#!/usr/bin/env python3
"""One refresh for every container that shares /codex-auth/auth.json."""

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

UPSTREAM = sys.argv[2] if len(sys.argv) > 2 else "https://auth.openai.com/oauth/token"
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8765
AUTH = sys.argv[1]
LOCK = os.path.join(os.path.dirname(AUTH), "refresh.lock")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode())
            asked = body.get("refresh_token")
        except Exception:
            self.respond(400, b'{"error":"invalid refresh request"}')
            return
        if not isinstance(asked, str) or asked == "":
            self.respond(400, b'{"error":"invalid refresh request"}')
            return
        try:
            acquire()
        except TimeoutError:
            self.respond(503, b'{"error":"refresh lock timed out"}')
            return
        try:
            current = json.loads(open(AUTH, encoding="utf-8").read())
            tokens = current.get("tokens") or {}
            stored = tokens.get("refresh_token")
            if isinstance(stored, str) and stored != "" and stored != asked:
                self.respond(200, json.dumps(token_body(tokens)).encode())
                return
            request = Request(UPSTREAM, data=raw, headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urlopen(request, timeout=30) as response:
                    payload = response.read()
                    status = response.status
            except HTTPError as error:
                self.respond(error.code, error.read())
                return
            if status == 200:
                save(current, payload)
            self.respond(status, payload)
        finally:
            release()

    def respond(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        return


def token_body(tokens):
    body = {}
    for key in ("id_token", "access_token", "refresh_token"):
        value = tokens.get(key)
        if isinstance(value, str) and value != "":
            body[key] = value
    return body


def save(current, payload):
    fresh = json.loads(payload.decode())
    tokens = current.setdefault("tokens", {})
    for key in ("id_token", "access_token", "refresh_token"):
        value = fresh.get(key)
        if isinstance(value, str) and value != "":
            tokens[key] = value
    current["last_refresh"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    temporary = AUTH + ".tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(current, handle)
    os.rename(temporary, AUTH)


def acquire():
    deadline = time.time() + 60
    while True:
        try:
            os.mkdir(LOCK)
            return
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(LOCK) > 30:
                    os.rmdir(LOCK)
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                raise TimeoutError
            time.sleep(0.05)


def release():
    try:
        os.rmdir(LOCK)
    except OSError:
        pass


if __name__ == "__main__":
    os.makedirs(os.path.dirname(AUTH), exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)

    def ready():
        time.sleep(0.05)
        with open("/tmp/codex-auth-proxy.ready", "w", encoding="utf-8"):
            pass

    threading.Thread(target=ready, daemon=True).start()
    server.serve_forever()
