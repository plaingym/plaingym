#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
import copy
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent
COMPOSE_FILES = (DEPLOY / "compose.yaml", HERE / "compose.yaml", DEPLOY.parent / "e2e" / "compose.yaml")
# Keys of the app's service that its one-shot migrate steps differ on, each with the reason. Every
# other key the app renders must match, so a new `user:` or `ulimits:` on the app fails the test.
EXPECTED_DIFFERENCES = {
    "image": "the demo overlay and End-to-end set their own image variables",
    "entrypoint": "the one-shot step runs database.sh instead of the server",
    "command": "the app's command does not apply to the one-shot step",
    "restart": "the app restarts; the one-shot step exits",
    "healthcheck": "the one-shot step exits before the image's server healthcheck could apply",
    "environment": "only the one-shot step holds the maintenance role",
    "depends_on": "each step waits for its own database service",
    "networks": "the steps join only the database network",
    "ports": "the app publishes none to the host in the demo, and the step has none",
    "volumes": "the app mounts its data; the step has no state",
    "labels": "the step does not carry the app's labels",
}
DEMO_ENV = dict(APP_IMAGE="plaingym:v0.0.0-test", CADDY_IMAGE="plaingym-caddy:v0.0.0-test", POSTGRES_PASSWORD="x",
                APP_PASSWORD="x", MAINTENANCE_PASSWORD="x", APP_ENCRYPTION_KEY="x", AUTH_SECRET="x", SETUP_TOKEN="x",
                GYM_HOSTNAME="demo.example.test", ACME_EMAIL="test@example.test", CLOUDFLARE_API_TOKEN="x",
                UPLOADS_S3_ENDPOINT="https://s3.example.test", UPLOADS_S3_BUCKET="b", UPLOADS_S3_ACCESS_KEY_ID="x",
                UPLOADS_S3_SECRET_ACCESS_KEY="x")
E2E_ENV = dict(E2E_IMAGE="plaingym:v0.0.0-test", E2E_POSTGRES_PASSWORD="x", E2E_APP_PASSWORD="x", E2E_MAINTENANCE_PASSWORD="x",
               E2E_AUTH_SECRET="x", E2E_ENCRYPTION_KEY="x", E2E_SETUP_TOKEN="x", E2E_S3_SECRET="x", E2E_STRIPE_KEY="x",
               E2E_STRIPE_WEBHOOK_SECRET="x")


def unexpected_differences(app, step, also=()):
    """Keys on which the one-shot step's rendered service differs from the app's, outside the expected list."""
    return {key: (app.get(key), step.get(key)) for key in sorted(set(app) | set(step))
            if key not in EXPECTED_DIFFERENCES and key not in also and app.get(key) != step.get(key)}


def stub(path, body):
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@unittest.skipUnless(os.name == "posix", "POSIX shell test")
class ComposeVersionTests(unittest.TestCase):
    """install.sh and update.sh refuse an old or unreadable Compose before anything on the host changes."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls.log"
        self.install_root = self.root / "install"
        # A host command that runs after the check would show up here; the fakes below record every call.
        for name in ("python3", "apt-get", "install", "flock", "mktemp", "systemctl", "ufw", "dpkg", "curl", "cp", "mv", "tar"):
            stub(self.bin / name, f"echo \"{name} $*\" >> '{self.log}'\nexit 0")

    def docker(self, reported, plugin=True):
        """A fake docker whose `compose version --short` prints `reported` (and exits 1 when it is empty)."""
        stub(self.bin / "docker", f"echo \"docker $*\" >> '{self.log}'\n"
             + ("exit 1\n" if not plugin else
                "case \"$*\" in 'compose version') exit 0 ;; 'compose version --short') ;; *) exit 2 ;; esac\n"
                f"[ -n '{reported}' ] || exit 0\nprintf '%s\\n' '{reported}'"))

    def env(self):
        return {**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}"}

    def run_install(self, *args, existing=False):
        if existing:
            self.install_root.mkdir()
            (self.install_root / ".env").write_text("APP_IMAGE=x\n")
        return subprocess.run(["sh", str(HERE / "install.sh"), "--directory", str(self.install_root), *args],
                              capture_output=True, text=True, env=self.env())

    def run_update(self):
        shutil.copy(HERE / "update.sh", self.install_root / "update.sh")
        shutil.copy(HERE / "lib.sh", self.install_root / "lib.sh")
        shutil.copy(DEPLOY / "lib.sh", self.install_root / "base-lib.sh")
        return subprocess.run(["bash", str(self.install_root / "update.sh")], capture_output=True, text=True, env=self.env())

    def host_calls(self):
        return [line for line in (self.log.read_text().splitlines() if self.log.exists() else [])
                if not line.startswith("docker compose version")]

    def test_install_reinstall_and_update_refuse_before_touching_the_host(self):
        for version, message in (("2.23.3", "too old"), ("v2.9.0", "too old"), ("1.29.2", "too old"),
                                 ("2", "Could not read"), ("dev", "Could not read"), ("2.x.1", "Could not read"),
                                 ("", "Could not read")):
            for mode in ("install", "reinstall", "local-test", "update"):
                with self.subTest(version=version, mode=mode):
                    shutil.rmtree(self.install_root, ignore_errors=True)
                    self.log.unlink(missing_ok=True)
                    self.docker(version)
                    if mode == "update":
                        self.install_root.mkdir()
                        result = self.run_update()
                    else:
                        result = self.run_install(*(("--local-test",) if mode == "local-test" else ()),
                                                  existing=mode == "reinstall")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr)
                    self.assertIn("Nothing was changed", result.stderr)
                    if message == "too old":
                        self.assertIn("docker-compose-plugin", result.stderr)
                    self.assertEqual(self.host_calls(), [])
                    if mode == "install":
                        self.assertFalse(self.install_root.exists())
                    if mode == "reinstall":
                        self.assertEqual(os.listdir(self.install_root), [".env"])

    def test_names_the_version_found_and_the_version_needed(self):
        self.docker("v2.23.3")
        result = self.run_install()
        self.assertIn("Docker Compose 2.23.3 is too old", result.stderr)
        self.assertIn("2.24 or later", result.stderr)
        self.docker("dev")
        self.assertIn("'dev'", self.run_install().stderr)

    def test_passes_on_compose_2_24_and_later(self):
        for version in ("2.24.0", "v2.24.6", "2.38.2", "2.100.0", "v5.6.0", "2.24.0-rc.1"):
            for mode in ("install", "reinstall", "local-test", "update"):
                with self.subTest(version=version, mode=mode):
                    shutil.rmtree(self.install_root, ignore_errors=True)
                    self.log.unlink(missing_ok=True)
                    self.docker(version)
                    if mode == "update":
                        self.install_root.mkdir()
                        result = self.run_update()
                        # Past the check it stops at the first later step (root, or the missing image argument).
                        self.assertRegex(result.stderr, r"Run update\.sh as root|Usage: update\.sh")
                    else:
                        result = self.run_install("--check-only", *(("--local-test",) if mode == "local-test" else ()),
                                                  existing=mode == "reinstall")
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIn("python3 ", self.log.read_text())
                    self.assertNotIn("Compose", result.stderr)

    def test_a_host_without_compose_goes_on_to_the_host_setup(self):
        # The host setup installs Docker and its Compose plugin, so there is nothing to check yet.
        self.docker("", plugin=False)
        result = self.run_install("--check-only")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_reinstall_and_local_test_refuse_without_compose(self):
        # Neither runs the host setup, so nothing would add the missing Compose.
        for mode in ("reinstall", "local-test"):
            with self.subTest(mode=mode):
                shutil.rmtree(self.install_root, ignore_errors=True)
                self.log.unlink(missing_ok=True)
                self.docker("", plugin=False)
                result = self.run_install(*(("--local-test",) if mode == "local-test" else ()), existing=mode == "reinstall")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Docker Compose is not installed", result.stderr)
                self.assertIn("Nothing was changed", result.stderr)
                self.assertEqual(self.host_calls(), [])

    def test_update_refuses_without_compose(self):
        self.docker("", plugin=False)
        self.install_root.mkdir()
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker Compose is not installed", result.stderr)
        self.assertEqual(self.host_calls(), [])


def compose_available():
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


@unittest.skipUnless(os.name == "posix", "POSIX shell test")
class ComposeAvailabilityTests(unittest.TestCase):
    def test_a_docker_without_the_compose_plugin_skips_the_hardening_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            stub(Path(directory) / "docker", "exit 1")
            with mock.patch.dict(os.environ, {"PATH": directory}):
                self.assertFalse(compose_available())
            stub(Path(directory) / "docker", "exit 0")
            with mock.patch.dict(os.environ, {"PATH": directory}):
                self.assertTrue(compose_available())


@unittest.skipUnless(compose_available(), "needs the docker compose plugin")
class HardeningTests(unittest.TestCase):
    @staticmethod
    def clean_environment():
        """The caller's environment without the variables the Compose files interpolate, so an exported
        APP_MEMORY_LIMIT or E2E_IMAGE cannot change the render; the tests pass what the render needs."""
        names = {name for file in COMPOSE_FILES for name in re.findall(r"\$\{(\w+)", file.read_text())}
        names |= {"COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_PROJECT_NAME", "COMPOSE_ENV_FILES"}
        return {key: value for key, value in os.environ.items() if key not in names}

    def render(self, files, env, caller=None):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("".join(f"{key}={value}\n" for key, value in env.items()))
            command = ["docker", "compose", "--env-file", str(env_file)]
            for file in files:
                command += ["-f", str(file)]
            result = subprocess.run(command + ["config", "--format", "json"], capture_output=True, text=True,
                                    env={**self.clean_environment(), **(caller or {})})
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)["services"]

    def demo_app(self, caller=None):
        return self.render([DEPLOY / "compose.yaml", HERE / "compose.yaml"], DEMO_ENV, caller)["app"]

    def test_demo_migrate_step_is_hardened_like_the_app(self):
        services = self.render([DEPLOY / "compose.yaml", HERE / "compose.yaml"], DEMO_ENV)
        self.assertEqual(unexpected_differences(services["app"], services["migrate"]), {})
        self.assertTrue(services["migrate"]["read_only"])
        self.assertEqual(services["migrate"]["cap_drop"], ["ALL"])

    def test_end_to_end_migrate_step_is_hardened_like_the_app(self):
        services = self.render([DEPLOY.parent / "e2e" / "compose.yaml"], E2E_ENV)
        # The throwaway End-to-end stack has no log rotation.
        self.assertEqual(unexpected_differences(self.demo_app(), services["demo-migrate"], also=("logging",)), {})
        # The app services themselves are not hardened in End-to-end.
        self.assertNotIn("read_only", services["demo"])

    def test_a_new_key_on_the_app_fails_the_comparison(self):
        services = self.render([DEPLOY / "compose.yaml", HERE / "compose.yaml"], DEMO_ENV)
        for key, value in (("user", "1000"), ("ulimits", {"nofile": 1024}), ("cap_add", ["NET_ADMIN"])):
            with self.subTest(key=key):
                app = {**copy.deepcopy(services["app"]), key: value}
                self.assertIn(key, unexpected_differences(app, services["migrate"]))

    def test_an_exported_memory_limit_does_not_change_the_render(self):
        expected = self.demo_app()
        with mock.patch.dict(os.environ, {"APP_MEMORY_LIMIT": "64m"}):
            # The caller's value is real (it changes a render that does not strip it), yet the test's render ignores it.
            self.assertNotIn("APP_MEMORY_LIMIT", self.clean_environment())
            self.assertEqual(self.demo_app(), expected)
            services = self.render([DEPLOY / "compose.yaml", HERE / "compose.yaml"], DEMO_ENV)
        self.assertEqual(unexpected_differences(services["app"], services["migrate"]), {})


if __name__ == "__main__":
    unittest.main()
