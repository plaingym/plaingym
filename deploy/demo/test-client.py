#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""HTTPS smoke client with real SNI, host-only cookies and a trusted local CA."""
import http.client
import json
import os
from pathlib import Path
import socket
import ssl
import sys
import urllib.parse
import uuid


class Client:
    def __init__(self, host, port, ca):
        self.host, self.port, self.ca, self.cookie = host, port, ca, ""

    def request(self, path, method="GET", body=None, expected=200):
        connection = http.client.HTTPSConnection(self.host, context=self.ca, timeout=90)
        connection.sock = self.ca.wrap_socket(socket.create_connection(("127.0.0.1", self.port), timeout=90), server_hostname=self.host)
        payload = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, payload, {"Host": self.host, "Origin": "https://" + self.host,
                                                  "Cookie": self.cookie, "Content-Type": "application/json",
                                                  "Accept": "application/json" if path.startswith("/api/") else "text/html"})
        response = connection.getresponse()
        data = response.read()
        assert response.status == expected, (method, path, response.status, data[:300])
        if path == "/api/demo/login":
            cookies = [value.split(";", 1)[0] for name, value in response.getheaders() if name.lower() == "set-cookie"]
            self.cookie = "; ".join(cookies)
            assert self.cookie
            assert all("Secure" in value or "secure" in value for name, value in response.getheaders() if name.lower() == "set-cookie")
        connection.close()
        return json.loads(data) if data.startswith(b"{") else data


def main():
    port = int(os.environ["DEMO_TEST_HTTPS_PORT"])
    ca = ssl.create_default_context(cafile=os.environ["DEMO_TEST_CA"])
    install = Client("demo.localhost", port, ca)
    install.request("/", expected=302)
    install.request("/demo")
    assert install.request("/api/demo")["data"]["enabled"]
    preserved = len(sys.argv) > 1 and sys.argv[1] == "preserved"
    if preserved:
        sandbox = json.loads(Path(os.environ["DEMO_TEST_FIXTURE"]).read_text())
    else:
        sandbox = install.request("/api/demo/sandboxes", "POST", expected=201)["data"]
        Path(os.environ["DEMO_TEST_FIXTURE"]).write_text(json.dumps(sandbox))
    host = urllib.parse.urlsplit(sandbox["origin"]).hostname
    owner = Client(host, port, ca)
    owner.cookie = sandbox.get("ownerCookie", "")
    owner.request("/admin")
    if not preserved:
        owner.request("/api/demo/login", "POST", {"role": "owner"})
    people = owner.request("/api/members?limit=100")["data"]
    assert len(people) >= 22
    assert len(owner.request("/api/staff/profiles")["data"]) == 4
    assert len(owner.request("/api/schedule/templates")["data"]) >= 15
    dashboard = owner.request("/api/dashboard")["data"]["widgets"]
    assert next(widget for widget in dashboard if widget["id"] == "promotion_ready")["count"] > 0
    recipient = "local-check-" + uuid.uuid4().hex + "@example.invalid"
    owner.request("/api/staff/invitations", "POST", {"email": recipient, "role": "coach", "delivery": "email"})
    assert any(row["recipient"] == recipient for row in owner.request("/api/demo/outbox")["data"])
    coach = Client(host, port, ca)
    coach.cookie = sandbox.get("coachCookie", "")
    if not preserved:
        coach.request("/api/demo/login", "POST", {"role": "coach"})
    coach.request("/admin/schedule")
    coach.request("/api/schedule/templates")
    coach.request("/api/staff/profiles", expected=403)
    coach.request("/api/settings/go-live", expected=403)
    owner.request("/api/setup", expected=404)
    sandbox.update(ownerCookie=owner.cookie, coachCookie=coach.cookie)
    Path(os.environ["DEMO_TEST_FIXTURE"]).write_text(json.dumps(sandbox))
    print("PASS: trusted HTTPS, wildcard sandbox, owner/coach logins, mat data, coach permissions and demo outbox.")


if __name__ == "__main__":
    main()
