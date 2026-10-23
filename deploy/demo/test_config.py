#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import config


def inputs():
    return dict(GYM_HOSTNAME="demo.plaingym.app", ACME_EMAIL="test@example.invalid",
                APP_IMAGE="plaingym:v0.0.0-local", CADDY_IMAGE="plaingym-caddy:v2.11.7-cf0.2.4",
                CLOUDFLARE_API_TOKEN="private-token", UPLOADS_S3_ENDPOINT="https://s3.example.test",
                UPLOADS_S3_BUCKET="demo-test", UPLOADS_S3_REGION="auto", UPLOADS_S3_ACCESS_KEY_ID="test-access",
                UPLOADS_S3_SECRET_ACCESS_KEY="private-secret", DEMO_LOCAL_TEST="false",
                ACME_CA="https://acme-v02.api.letsencrypt.org/directory")


class PreflightTests(unittest.TestCase):
    def test_validation_rejects_interpolation_live_test_domains_and_unpinned_images(self):
        config.validate(inputs())
        for key, value in (("APP_IMAGE", "example:latest"), ("CADDY_IMAGE", "example:edge"),
                           ("GYM_HOSTNAME", "https://demo.example.com"), ("CLOUDFLARE_API_TOKEN", "bad\nAPP_IMAGE=evil"),
                           ("UPLOADS_S3_SECRET_ACCESS_KEY", "$injected"), ("UPLOADS_S3_ENDPOINT", "https://user:pass@host"),
                           ("UPLOADS_S3_ENDPOINT", "http://s3.example.com"), ("UPLOADS_S3_BUCKET", "../bucket"),
                           ("DEMO_LOCAL_TEST", "true"), ("ACME_EMAIL", "invalid")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                config.validate({**inputs(), key: value})

    def test_cloudflare_performs_scoped_write_and_cleanup(self):
        calls = []

        def api(url, method="GET", body=None, headers=None):
            calls.append((url, method, body, headers))
            if "/zones?name=" in url:
                result = [{"id": "zone1"}] if url.endswith("name=plaingym.app") else []
            else:
                result = {"id": "record1"}
            return json.dumps({"success": True, "result": result}).encode()
        with patch.object(config, "request", api):
            config.cloudflare_check(inputs())
        self.assertEqual([call[1] for call in calls], ["GET", "GET", "POST", "DELETE"])
        self.assertTrue(calls[-1][0].endswith("/zones/zone1/dns_records/record1"))
        self.assertEqual(json.loads(calls[-2][2])["type"], "TXT")
        self.assertEqual(calls[-2][3]["Authorization"], "Bearer private-token")

    def test_read_only_cloudflare_token_fails(self):
        def api(url, method="GET", body=None, headers=None):
            return json.dumps({"success": method == "GET", "result": [{"id": "zone"}]}).encode()
        with patch.object(config, "request", api), self.assertRaises(ValueError):
            config.cloudflare_check(inputs())

    def test_dns_checks_base_wildcard_and_rejects_stale_ipv6(self):
        interfaces = json.dumps([{"addr_info": [{"local": "8.8.8.8"}]}])
        resolved = [(None, None, None, None, ("8.8.8.8", 443))]
        with patch.object(config.subprocess, "check_output", return_value=interfaces), \
                patch.object(config, "request", return_value=b"8.8.8.8"), \
                patch.object(config.socket, "getaddrinfo", return_value=resolved) as dns:
            config.dns_check(inputs())
            self.assertEqual(dns.call_count, 2)
            dns.return_value = [*resolved, (None, None, None, None, ("2606:4700::1111", 443))]
            with self.assertRaises(ValueError):
                config.dns_check(inputs())

    def test_s3_cleanup_after_failed_read(self):
        methods = []

        def s3(conf, method, key, body=b""):
            methods.append(method)
            if method == "GET":
                raise OSError("read failed")
        with patch.object(config, "s3_request", s3), self.assertRaises(OSError):
            config.s3_check(inputs())
        self.assertEqual(methods, ["PUT", "GET", "DELETE"])

    def test_failed_preflight_never_publishes_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / ".env"
            with patch.dict(os.environ, inputs(), clear=True), patch.object(config, "dns_check", side_effect=ValueError("DNS failed")), \
                    patch.object(config.sys, "argv", ["config.py", "--existing", str(output), "--output", str(output)]), \
                    self.assertRaises(ValueError):
                config.main()
            self.assertFalse(output.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX file permissions require Linux/WSL; Windows does not implement mode 0600.")
    def test_rerun_preserves_every_secret_and_image_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            existing, output = Path(directory) / ".env", Path(directory) / "next"
            args = ["config.py", "--existing", str(existing), "--output", str(output)]
            with patch.dict(os.environ, inputs(), clear=True), patch.object(config, "dns_check"), \
                    patch.object(config, "cloudflare_check"), patch.object(config, "s3_check"), \
                    patch.object(config.sys, "argv", args), contextlib.redirect_stdout(io.StringIO()):
                config.main()
                existing.write_bytes(output.read_bytes())
                original = output.read_bytes()
                os.environ["APP_IMAGE"] = "plaingym:v0.1.0"
                config.main()
            self.assertEqual(original, output.read_bytes())
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotEqual(config.read_env(output)["APP_PASSWORD"], config.read_env(output)["MAINTENANCE_PASSWORD"])


if __name__ == "__main__":
    unittest.main()
