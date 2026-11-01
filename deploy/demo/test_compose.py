#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent
# Keys the app's hardening sets in deploy/compose.yaml; the one-shot migrate steps must carry the same.
HARDENING = ("init", "read_only", "cap_drop", "security_opt", "mem_limit", "pids_limit", "tmpfs")
DEMO_ENV = dict(APP_IMAGE="plaingym:v0.0.0-test", CADDY_IMAGE="plaingym-caddy:v0.0.0-test", POSTGRES_PASSWORD="x",
                APP_PASSWORD="x", MAINTENANCE_PASSWORD="x", APP_ENCRYPTION_KEY="x", AUTH_SECRET="x", SETUP_TOKEN="x",
                GYM_HOSTNAME="demo.example.test", ACME_EMAIL="test@example.test", CLOUDFLARE_API_TOKEN="x",
                UPLOADS_S3_ENDPOINT="https://s3.example.test", UPLOADS_S3_BUCKET="b", UPLOADS_S3_ACCESS_KEY_ID="x",
                UPLOADS_S3_SECRET_ACCESS_KEY="x")
E2E_ENV = dict(E2E_IMAGE="plaingym:v0.0.0-test", E2E_POSTGRES_PASSWORD="x", E2E_APP_PASSWORD="x", E2E_MAINTENANCE_PASSWORD="x",
               E2E_AUTH_SECRET="x", E2E_ENCRYPTION_KEY="x", E2E_SETUP_TOKEN="x", E2E_S3_SECRET="x", E2E_STRIPE_KEY="x",
               E2E_STRIPE_WEBHOOK_SECRET="x")


@unittest.skipUnless(os.name == "posix", "POSIX shell test")
class ComposeVersionTests(unittest.TestCase):
    def run_host(self, reported):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "demo").mkdir()
            (root / "bin").mkdir()
            shutil.copy(HERE / "host.sh", root / "demo" / "host.sh")
            shutil.copy(DEPLOY / "lib.sh", root / "lib.sh")
            # The shared host setup needs root and apt; this stands in for it, and for docker.
            (root / "host.sh").write_text("#!/bin/sh\nexit 0\n")
            docker = root / "bin" / "docker"
            docker.write_text(f"#!/bin/sh\n[ \"$*\" = 'compose version --short' ] || exit 2\n[ -n '{reported}' ] || exit 1\nprintf '%s\\n' '{reported}'\n")
            docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
            return subprocess.run(["sh", str(root / "demo" / "host.sh")], capture_output=True, text=True,
                                  env={**os.environ, "PATH": f"{root / 'bin'}{os.pathsep}{os.environ['PATH']}"})

    def test_accepts_compose_2_24_and_later(self):
        for version in ("2.24.0", "v2.24.6", "2.38.2", "2.100.0", "v5.6.0", "2.24.0-rc.1"):
            with self.subTest(version=version):
                result = self.run_host(version)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_stops_below_2_24_and_on_a_version_it_cannot_read(self):
        for version, message in (("2.23.3", "too old"), ("v2.9.0", "too old"), ("1.29.2", "too old"),
                                 ("2", "Could not read"), ("dev", "Could not read"), ("2.x.1", "Could not read"), ("", "not installed")):
            with self.subTest(version=version):
                result = self.run_host(version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


@unittest.skipUnless(shutil.which("docker"), "needs docker compose")
class HardeningTests(unittest.TestCase):
    def render(self, files, env):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("".join(f"{key}={value}\n" for key, value in env.items()))
            command = ["docker", "compose", "--env-file", str(env_file)]
            for file in files:
                command += ["-f", str(file)]
            result = subprocess.run(command + ["config", "--format", "json"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)["services"]

    def hardening(self, service, keys=HARDENING):
        return {key: service.get(key) for key in keys}

    def test_demo_migrate_step_is_hardened_like_the_app(self):
        services = self.render([DEPLOY / "compose.yaml", HERE / "compose.yaml"], DEMO_ENV)
        keys = HARDENING + ("logging",)
        self.assertEqual(self.hardening(services["migrate"], keys), self.hardening(services["app"], keys))
        self.assertTrue(services["migrate"]["read_only"])
        self.assertEqual(services["migrate"]["cap_drop"], ["ALL"])

    def test_end_to_end_migrate_step_is_hardened_like_the_app(self):
        app = self.render([DEPLOY / "compose.yaml", HERE / "compose.yaml"], DEMO_ENV)["app"]
        services = self.render([DEPLOY.parent / "e2e" / "compose.yaml"], E2E_ENV)
        self.assertEqual(self.hardening(services["demo-migrate"]), self.hardening(app))
        # The app services themselves are not hardened in End-to-end.
        self.assertNotIn("read_only", services["demo"])


if __name__ == "__main__":
    unittest.main()
