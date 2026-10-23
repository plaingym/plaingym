#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Loopback-only trusted HTTPS fixture; called only by POSIX deployment tests."""
from contextlib import contextmanager
import functools
import http.server
import os
import ssl
import subprocess
import threading


@contextmanager
def https_directory(directory):
    cert, key = directory / "cert.pem", directory / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
                    "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(directory)))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"https://127.0.0.1:{server.server_port}", {**os.environ, "CURL_CA_BUNDLE": str(cert), "NO_PROXY": "127.0.0.1"}
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
