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
                    patch.object(config, "has_terminal", return_value=False), \
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
                    patch.object(config, "has_terminal", return_value=False), \
                    patch.object(config.sys, "argv", args), contextlib.redirect_stdout(io.StringIO()):
                config.main()
                existing.write_bytes(output.read_bytes())
                original = output.read_bytes()
                os.environ["APP_IMAGE"] = "plaingym:v0.1.0"
                config.main()
            self.assertEqual(original, output.read_bytes())
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotEqual(config.read_env(output)["APP_PASSWORD"], config.read_env(output)["MAINTENANCE_PASSWORD"])


KEY, SECRET = "sk_test_FAKEKEY123", "whsec_FAKESECRET456"


class BillingInputTests(unittest.TestCase):
    """Fake terminal and environment only; no real Stripe key, not even a test one."""

    def run_main(self, directory, env=None, answers=(), terminal=True, existing=True):
        saved = Path(directory) / ".env"
        output = Path(directory) / "next"
        asked = []
        replies = list(answers)

        def prompt(label, secret=False):
            asked.append((label, secret))
            return replies.pop(0)
        args = ["config.py", "--existing", str(saved if existing else Path(directory) / "none"), "--output", str(output)]
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {**inputs(), **(env or {})}, clear=True), patch.object(config, "dns_check"), \
                patch.object(config, "cloudflare_check"), patch.object(config, "s3_check"), \
                patch.object(config, "prompt", prompt), patch.object(config, "has_terminal", return_value=terminal), \
                patch.object(config.sys, "argv", args), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                config.main()
            finally:
                self.output = out.getvalue() + err.getvalue()
        return output, asked

    def install(self, directory, output):
        (Path(directory) / ".env").write_bytes(output.read_bytes())

    def assertQuiet(self):
        for value in (KEY, SECRET):
            self.assertNotIn(value, self.output)

    def test_run_without_billing_asks_once_and_writes_no_values(self):
        with tempfile.TemporaryDirectory() as directory:
            output, asked = self.run_main(directory, answers=["n"], existing=False)
            self.assertEqual(asked, [("Set up demo billing with a Stripe test key? [y/N]", False)])
            self.assertNotIn("DEMO_STRIPE", output.read_text())

    def test_unattended_run_without_billing_never_prompts(self):
        with tempfile.TemporaryDirectory() as directory:
            output, asked = self.run_main(directory, terminal=False, existing=False)
            self.assertEqual(asked, [])
            self.assertNotIn("DEMO_STRIPE", output.read_text())

    def test_billing_variables_in_the_environment_answer_the_question(self):
        # A scripted run with a terminal (an SSH session, test-local.sh) sets the variables, empty to skip billing.
        for env in ({"DEMO_STRIPE_TEST_KEY": ""}, {"DEMO_STRIPE_TEST_KEY": "", "DEMO_STRIPE_WEBHOOK_SECRET": ""}):
            with self.subTest(env=env), tempfile.TemporaryDirectory() as directory:
                output, asked = self.run_main(directory, env=env, existing=False)
                self.assertEqual(asked, [])
                self.assertNotIn("DEMO_STRIPE", output.read_text())

    def test_chosen_billing_with_nothing_entered_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError) as caught:
                self.run_main(directory, answers=["y", "", ""], existing=False)
            self.assertIn("no key or secret was entered", str(caught.exception))
            self.assertFalse((Path(directory) / "next").exists())

    def test_prompts_read_both_values_hidden(self):
        with tempfile.TemporaryDirectory() as directory:
            output, asked = self.run_main(directory, answers=["y", KEY, SECRET], existing=False)
            self.assertEqual([secret for _, secret in asked], [False, True, True])
            written = config.read_env(output)
            self.assertEqual((written["DEMO_STRIPE_TEST_KEY"], written["DEMO_STRIPE_WEBHOOK_SECRET"]), (KEY, SECRET))
            self.assertQuiet()

    def test_environment_supplies_both_without_prompting(self):
        with tempfile.TemporaryDirectory() as directory:
            output, asked = self.run_main(directory, env={"DEMO_STRIPE_TEST_KEY": "rk_test_FAKE9", "DEMO_STRIPE_WEBHOOK_SECRET": SECRET},
                                          terminal=False, existing=False)
            self.assertEqual(asked, [])
            self.assertEqual(config.read_env(output)["DEMO_STRIPE_TEST_KEY"], "rk_test_FAKE9")
            self.assertQuiet()

    def test_live_key_is_refused_with_nothing_written_or_echoed(self):
        live = "sk_live_FAKELIVE789"
        for env, answers in (({"DEMO_STRIPE_TEST_KEY": live, "DEMO_STRIPE_WEBHOOK_SECRET": SECRET}, []),
                             ({}, ["y", live, SECRET])):
            with self.subTest(env=bool(env)), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError) as caught:
                    self.run_main(directory, env=env, answers=answers, existing=False)
                self.assertFalse((Path(directory) / "next").exists())
                self.assertNotIn(live, str(caught.exception) + self.output)

    def test_missing_or_malformed_secret_is_refused(self):
        for secret in ("", "whsec_", "not-a-secret", "whsec_bad value", "sk_test_FAKEKEY123"):
            with self.subTest(secret=secret), tempfile.TemporaryDirectory() as directory:
                env = {"DEMO_STRIPE_TEST_KEY": KEY, "DEMO_STRIPE_WEBHOOK_SECRET": secret}
                with self.assertRaises(ValueError) as caught:
                    self.run_main(directory, env=env, terminal=False, existing=False)
                self.assertFalse((Path(directory) / "next").exists())
                if len(secret) > len("whsec_"):
                    self.assertNotIn(secret, str(caught.exception))
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            self.run_main(directory, env={"DEMO_STRIPE_WEBHOOK_SECRET": SECRET}, terminal=False, existing=False)
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            self.run_main(directory, env={"DEMO_STRIPE_TEST_KEY": "pk_test_FAKE"}, terminal=False, existing=False)

    @unittest.skipUnless(os.name == "posix", "POSIX file permissions require Linux/WSL.")
    def test_rerun_keeps_saved_values_and_does_not_ask(self):
        with tempfile.TemporaryDirectory() as directory:
            output, _ = self.run_main(directory, answers=["y", KEY, SECRET], existing=False)
            self.install(directory, output)
            original = output.read_bytes()
            env = {"DEMO_STRIPE_TEST_KEY": "sk_test_OTHER", "DEMO_STRIPE_WEBHOOK_SECRET": "whsec_OTHER"}
            output, asked = self.run_main(directory, env=env)
            self.assertEqual(asked, [])
            self.assertEqual(original, output.read_bytes())
            self.assertQuiet()

    @unittest.skipUnless(os.name == "posix", "POSIX file permissions require Linux/WSL.")
    def test_rerun_without_billing_can_add_it(self):
        with tempfile.TemporaryDirectory() as directory:
            output, _ = self.run_main(directory, answers=["n"], existing=False)
            self.install(directory, output)
            before = config.read_env(output)
            output, _ = self.run_main(directory, answers=["y", KEY, SECRET])
            after = config.read_env(output)
            self.assertEqual((after["DEMO_STRIPE_TEST_KEY"], after["DEMO_STRIPE_WEBHOOK_SECRET"]), (KEY, SECRET))
            self.assertEqual({k: v for k, v in after.items() if not k.startswith("DEMO_STRIPE")}, before)
            self.assertQuiet()

    def test_closed_terminal_at_a_hidden_prompt_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            error = io.StringIO()
            args = ["config.py", "--existing", str(Path(directory) / "none"), "--output", str(Path(directory) / "next")]
            answers = iter(["y"])

            def prompt(label, secret=False):
                try:
                    return next(answers)
                except StopIteration:
                    raise EOFError from None
            with patch.dict(os.environ, inputs(), clear=True), patch.object(config, "prompt", prompt), \
                    patch.object(config, "has_terminal", return_value=True), patch.object(config.sys, "argv", args), \
                    contextlib.redirect_stderr(error), self.assertRaises(SystemExit):
                config.cli()
            self.assertIn("Demo preflight failed: EOFError", error.getvalue())
            self.assertFalse((Path(directory) / "next").exists())

    def test_check_only_never_prompts(self):
        with tempfile.TemporaryDirectory() as directory:
            asked = []
            args = ["config.py", "--existing", str(Path(directory) / "none"), "--check-only"]
            with patch.dict(os.environ, inputs(), clear=True), patch.object(config, "dns_check"), \
                    patch.object(config, "cloudflare_check"), patch.object(config, "s3_check"), \
                    patch.object(config, "prompt", lambda *a, **k: asked.append(a)), patch.object(config, "has_terminal", return_value=True), \
                    patch.object(config.sys, "argv", args), contextlib.redirect_stdout(io.StringIO()):
                config.main()
            self.assertEqual(asked, [])


if __name__ == "__main__":
    unittest.main()
