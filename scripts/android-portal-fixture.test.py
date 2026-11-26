#!/usr/bin/env python3
"""The loopback portal fixture behaves as the Android trust test relies on (host side, no Android).

Run: python3 scripts/android-portal-fixture.test.py
"""

import http.client
import json
import socket
import ssl
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
fixture_module = SourceFileLoader(
    "android_portal_fixture", str(ROOT / "scripts/android-portal-fixture.py")
).load_module()
Fixture = fixture_module.Fixture


def trusting(root: bool) -> ssl.SSLContext:
    context = ssl.create_default_context()
    if root:
        context.load_verify_locations(cadata=fixture_module.root_pem())
    return context


def post(port: int, context: ssl.SSLContext, host: str = "localhost", path: str = "/api/mycarlos/x"):
    connection = http.client.HTTPSConnection(host, port, context=context, timeout=10)
    try:
        connection.request("POST", path, body=b'{"fake":"body"}', headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, response.getheader("Location"), response.read()
    finally:
        connection.close()


def events(log: Path) -> list[dict]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines()]


class Fake(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.log = Path(self.directory.name) / "log.jsonl"

    def fixture(self, mode: str, **options) -> Fixture:
        fixture = Fixture(mode, log=self.log, **options).start()
        self.addCleanup(fixture.stop)
        return fixture

    def test_a_client_that_trusts_the_test_root_reads_the_refusal_for_both_names(self):
        fixture = self.fixture("trusted")
        for host in ("localhost", "127.0.0.1"):
            status, _, body = post(fixture.port, trusting(True), host)
            self.assertEqual((status, json.loads(body)), (403, {"code": "link_code_invalid"}), host)

    def test_a_client_that_does_not_trust_the_root_fails_the_handshake_and_nothing_is_logged(self):
        fixture = self.fixture("trusted")
        with self.assertRaises(ssl.SSLCertVerificationError):
            post(fixture.port, trusting(False))
        self.assertEqual(events(self.log), [])

    def test_a_certificate_for_another_name_is_refused_even_by_a_client_that_trusts_the_root(self):
        fixture = self.fixture("other")
        with self.assertRaises(ssl.SSLCertVerificationError) as failure:
            post(fixture.port, trusting(True))
        self.assertIn("mismatch", str(failure.exception).lower())
        self.assertEqual(events(self.log), [])

    def test_a_redirect_is_answered_and_a_client_that_does_not_follow_it_makes_one_request(self):
        fixture = self.fixture("redirect")
        status, location, _ = post(fixture.port, trusting(True))
        self.assertEqual(status, 302)
        self.assertEqual(location, f"https://localhost:{fixture.port}/redirected")
        self.assertEqual([e["path"] for e in events(self.log)], ["/api/mycarlos/x"])
        # A client that did follow it would show as a second request.
        post(fixture.port, trusting(True), path="/redirected")
        self.assertEqual(
            [e["path"] for e in events(self.log)], ["/api/mycarlos/x", "/redirected"]
        )

    def test_the_log_holds_method_path_and_length_never_the_body_or_a_header(self):
        fixture = self.fixture("trusted")
        post(fixture.port, trusting(True))
        [event] = events(self.log)
        self.assertEqual(
            event, {"bytes": len(b'{"fake":"body"}'), "event": "request", "method": "POST", "path": "/api/mycarlos/x"}
        )
        self.assertNotIn("fake", self.log.read_text())
        self.assertNotIn("Content-Type", self.log.read_text())

    def test_a_content_length_that_is_not_a_number_is_a_request_without_a_body(self):
        fixture = self.fixture("trusted")
        context = trusting(True)
        with socket.create_connection(("127.0.0.1", fixture.port), timeout=5) as raw:
            with context.wrap_socket(raw, server_hostname="localhost") as tls:
                tls.sendall(
                    b"POST /api/mycarlos/x HTTP/1.1\r\nHost: localhost\r\n"
                    b"Content-Length: abc\r\n\r\n"
                )
                reply = tls.recv(4096)
        self.assertTrue(reply.startswith(b"HTTP/1.1 403"))
        [event] = events(self.log)
        self.assertEqual((event["path"], event["bytes"]), ("/api/mycarlos/x", 0))

    def test_the_plain_listener_logs_that_someone_connected_and_nothing_else(self):
        fixture = self.fixture("trusted", plain_port=0)
        self.assertEqual(events(self.log), [])
        with socket.create_connection(("127.0.0.1", fixture.plain_port), timeout=5) as sock:
            sock.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        fixture.stop()  # joins the handler threads
        self.assertEqual(events(self.log), [{"event": "plain_connection"}])

    def test_the_certificates_are_the_throwaway_test_ones_and_a_bad_mode_is_refused(self):
        self.assertIn("FAKE", (ROOT / "src-tauri/tests/fixtures/portal-test-pki/README.md").read_text())
        with self.assertRaises(ValueError):
            Fixture("nonsense")
        with self.assertRaises(ValueError):
            fixture_module.pem("CERTIFICATE", "not base64 !!!")

    def test_no_pem_text_is_left_behind_in_the_temporary_directory(self):
        before = set(Path(tempfile.gettempdir()).glob("portal-fixture-*"))
        fixture = self.fixture("trusted")
        post(fixture.port, trusting(True))
        self.assertEqual(set(Path(tempfile.gettempdir()).glob("portal-fixture-*")), before)


if __name__ == "__main__":
    unittest.main()
