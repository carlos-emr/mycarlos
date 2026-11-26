#!/usr/bin/env python3
"""A loopback HTTPS "portal" for testing how the app trusts a portal (FAKE data only).

It answers every POST with a fixed refusal, never a real portal answer, so a run proves only that
the TLS handshake and the HTTP exchange worked (or were refused), not any portal logic:

- `trusted`:  a certificate for `127.0.0.1` and `localhost` made under the test root of
  `src-tauri/tests/fixtures/portal-test-pki`, answering `403 {"code":"link_code_invalid"}`. A client
  that trusts the test root reads that as "the portal did not accept that code"; one that does not
  trust it fails the handshake ("the portal request could not be completed").
- `other`:    the same answer behind a certificate for `other.example` only: a client that trusts the
  root still refuses it (wrong name).
- `redirect`: `302` to another path on this server; a client that follows it makes a second request,
  which is logged.

A second, plain-HTTP listener (`--plain-port`) only logs that someone connected, so a test can show
that a clear-text address was refused before any connection was made.

The log (`--log`, JSON lines) holds the method, the path and the body's length of each request and
the fact of a plain connection. The PATH is logged as it was sent, so it may carry opaque ids from the
app's request (a link id, a request id); it never holds a body, a header or an address of the caller.

The certificates and keys are throwaway test keys (see that folder's README); they are written to a
private temporary directory only long enough to be loaded and are never added to any trust store.

Usage: android-portal-fixture.py --mode trusted --port 8443 [--plain-port 8080] [--log fixture.jsonl]
It prints one line of JSON, {"port": N, "plain_port": N|null}, when it is ready, and runs until
it is stopped.
"""

from __future__ import annotations

import argparse
import base64
import http.server
import json
import socketserver
import ssl
import sys
import tempfile
import threading
from pathlib import Path

PKI = Path(__file__).resolve().parents[1] / "src-tauri/tests/fixtures/portal-test-pki"
MODES = ("trusted", "other", "redirect")
# The most of a request body that is read (the app's signed link request is far smaller).
MAX_BODY = 64 * 1024
REFUSAL = b'{"code":"link_code_invalid"}'


def pem(label: str, b64_der: str) -> str:
    """The base64 DER text of a test file as PEM."""
    body = "".join(b64_der.split())
    base64.b64decode(body, validate=True)
    lines = [body[i : i + 64] for i in range(0, len(body), 64)]
    return f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----\n"


def read_pki(name: str, pki: Path = PKI) -> str:
    return (pki / name).read_text(encoding="ascii")


def root_pem(pki: Path = PKI) -> str:
    """The test root, for a client that is to trust it."""
    return pem("CERTIFICATE", read_pki("ca.der.b64", pki))


class Log:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.lock = threading.Lock()

    def write(self, **event: object) -> None:
        if self.path is None:
            return
        with self.lock, self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, sort_keys=True) + "\n")


class Fixture:
    """The HTTPS fixture (and the optional plain listener), started and stopped by the caller."""

    def __init__(
        self,
        mode: str,
        *,
        port: int = 0,
        plain_port: int | None = None,
        log: Path | None = None,
        pki: Path = PKI,
    ) -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {', '.join(MODES)}")
        self.mode = mode
        self.log = Log(log)
        leaf, key = ("other.der.b64", "other.pkcs8.b64") if mode == "other" else (
            "leaf.der.b64",
            "leaf.pkcs8.b64",
        )
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        with tempfile.TemporaryDirectory(prefix="portal-fixture-") as directory:
            chain = Path(directory) / "chain.pem"
            private = Path(directory) / "key.pem"
            chain.write_text(pem("CERTIFICATE", read_pki(leaf, pki)), encoding="ascii")
            private.write_text(pem("PRIVATE KEY", read_pki(key, pki)), encoding="ascii")
            private.chmod(0o600)
            context.load_cert_chain(chain, private)
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle_any(self) -> None:
                try:
                    length = max(0, int(self.headers.get("Content-Length") or 0))
                except ValueError:
                    length = 0  # not a number: no body is read, and the request is still answered
                remaining = min(length, MAX_BODY)
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 8192))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                fixture.log.write(event="request", method=self.command, path=self.path, bytes=length)
                if fixture.mode == "redirect" and self.path != "/redirected":
                    self.send_response(302)
                    self.send_header("Location", f"https://localhost:{fixture.port}/redirected")
                    self.send_header("Content-Length", "0")
                else:
                    self.send_response(403)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(REFUSAL)))
                self.send_header("Connection", "close")
                self.end_headers()
                if not (fixture.mode == "redirect" and self.path != "/redirected"):
                    self.wfile.write(REFUSAL)

            do_POST = do_GET = handle_any

            def log_message(self, *args: object) -> None:  # nothing on stderr
                return

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

            def get_request(self):
                # The handshake happens on the connection's own thread (on its first read), so a
                # client that stalls in it never holds up the next one.
                sock, address = super().get_request()
                return (
                    context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False),
                    address,
                )

            def handle_error(self, request, client_address) -> None:
                return  # a failed handshake or a reset: the client's side says so

        self.server = Server(("127.0.0.1", port), Handler)
        self.port = self.server.server_address[1]
        self.plain = None
        self.plain_port: int | None = None
        if plain_port is not None:

            class Plain(socketserver.BaseRequestHandler):
                def handle(self) -> None:
                    fixture.log.write(event="plain_connection")

            self.plain = socketserver.ThreadingTCPServer(("127.0.0.1", plain_port), Plain)
            self.plain.daemon_threads = True
            self.plain_port = self.plain.server_address[1]
        self.threads: list[threading.Thread] = []

    def start(self) -> "Fixture":
        for server in (self.server, self.plain):
            if server is not None:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                self.threads.append(thread)
        return self

    def stop(self) -> None:
        for server in (self.server, self.plain):
            if server is not None:
                server.shutdown()
                server.server_close()
        for thread in self.threads:
            thread.join(timeout=5)

    def __enter__(self) -> "Fixture":
        return self.start()

    def __exit__(self, *args: object) -> None:
        self.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--mode", choices=MODES, required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--plain-port", type=int, default=None)
    parser.add_argument("--log", type=Path, default=None)
    args = parser.parse_args(argv)
    with Fixture(args.mode, port=args.port, plain_port=args.plain_port, log=args.log) as fixture:
        print(json.dumps({"port": fixture.port, "plain_port": fixture.plain_port}), flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
