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
    "labels": "the step does not carry the app's labels",
}
# Keys that differ legitimately but are checked on their own by `unsafe_step`, not exempted.
CHECKED_ON_THEIR_OWN = ("volumes", "networks", "ports", "depends_on")
DEMO_ENV = dict(APP_IMAGE="plaingym:v0.0.0-test", CADDY_IMAGE="plaingym-caddy:v0.0.0-test", POSTGRES_PASSWORD="x",
                APP_PASSWORD="x", MAINTENANCE_PASSWORD="x", APP_ENCRYPTION_KEY="x", AUTH_SECRET="x", SETUP_TOKEN="x",
                GYM_HOSTNAME="demo.example.test", ACME_EMAIL="test@example.test", CLOUDFLARE_API_TOKEN="x",
                UPLOADS_S3_ENDPOINT="https://s3.example.test", UPLOADS_S3_BUCKET="b", UPLOADS_S3_ACCESS_KEY_ID="x",
                UPLOADS_S3_SECRET_ACCESS_KEY="x")
E2E_ENV = dict(E2E_IMAGE="plaingym:v0.0.0-test", E2E_POSTGRES_PASSWORD="x", E2E_APP_PASSWORD="x", E2E_MAINTENANCE_PASSWORD="x",
               E2E_AUTH_SECRET="x", E2E_ENCRYPTION_KEY="x", E2E_SETUP_TOKEN="x", E2E_S3_SECRET="x", E2E_STRIPE_KEY="x",
               E2E_STRIPE_RESTRICTED_KEY="x", E2E_STRIPE_WEBHOOK_SECRET="x")


def unexpected_differences(app, step, also=()):
    """Keys on which the one-shot step's rendered service differs from the app's, outside the expected list."""
    return {key: (app.get(key), step.get(key)) for key in sorted(set(app) | set(step))
            if key not in EXPECTED_DIFFERENCES and key not in CHECKED_ON_THEIR_OWN and key not in also
            and app.get(key) != step.get(key)}


def unsafe_step(step, database, networks=("database",)):
    """What a rendered one-shot step must not have: any mount (it has no state, and a Docker socket or
    host path would be worse), a published port, a network besides `networks` (the app's public one
    in particular), or a dependency besides its database service."""
    problems = {}
    if step.get("volumes"):
        problems["volumes"] = step["volumes"]
    if step.get("ports"):
        problems["ports"] = step["ports"]
    extra = sorted(set(step.get("networks") or {}) - set(networks))
    if extra:
        problems["networks"] = extra
    others = sorted(set(step.get("depends_on") or {}) - {database})
    if others:
        problems["depends_on"] = others
    return problems


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
            shutil.copy(DEPLOY / "lib.sh", self.install_root / "base-lib.sh")
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
                        self.assertEqual(sorted(os.listdir(self.install_root)), [".env", "base-lib.sh"])

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

    def test_a_missing_base_lib_is_named_unless_the_installer_is_running(self):
        self.docker("2.30.0")
        # The installer copies base-lib.sh itself, so it runs again to restore a lost copy.
        self.assertEqual(self.run_install("--check-only", existing=True).returncode, 0)
        (self.install_root / "base-lib.sh").unlink()
        self.assertEqual(self.run_install("--check-only").returncode, 0)
        # Anything else that loads the installed lib.sh needs the copy beside it, even when the caller's
        # environment says DEMO_FIRST_INSTALL (the installer no longer sets it; nothing may skip the check).
        self.run_update()
        (self.install_root / "base-lib.sh").unlink()
        for extra in ({}, {"DEMO_FIRST_INSTALL": "true"}):
            with self.subTest(extra=extra):
                update = subprocess.run(["bash", str(self.install_root / "update.sh")], capture_output=True, text=True,
                                        env={**self.env(), **extra})
                self.assertNotEqual(update.returncode, 0)
                self.assertIn(f"{self.install_root}/base-lib.sh is missing", update.stderr)
                self.assertNotIn("not found", update.stderr)
        # A caller that does not say it is the installer gets the same message for a directory with no .env.
        shutil.rmtree(self.install_root)
        self.install_root.mkdir()
        shutil.copy(HERE / "update.sh", self.install_root / "update.sh")
        shutil.copy(HERE / "lib.sh", self.install_root / "lib.sh")
        bare = subprocess.run(["bash", str(self.install_root / "update.sh")], capture_output=True, text=True, env=self.env())
        self.assertNotEqual(bare.returncode, 0)
        self.assertIn("base-lib.sh is missing", bare.stderr)

    def bundle(self, after_host_setup):
        """A copy of the installer whose host.sh is a fake that records its run and then sets Compose to
        `after_host_setup` ('' installs nothing), with the OS check reading an Ubuntu 24.04 fixture."""
        bundle = self.root / "bundle"
        (bundle / "demo").mkdir(parents=True)
        shutil.copy(DEPLOY / "lib.sh", bundle / "lib.sh")
        shutil.copy(HERE / "lib.sh", bundle / "demo" / "lib.sh")
        release = self.root / "os-release"
        release.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        install = (HERE / "install.sh").read_text()
        self.assertIn(". /etc/os-release", install)
        (bundle / "demo" / "install.sh").write_text(install.replace(". /etc/os-release", f". '{release}'"))
        (bundle / "demo" / "host.sh").write_text(
            f"echo host.sh >> '{self.log}'\n"
            + (f"printf '%s\\n' '{after_host_setup}' > '{self.root / 'compose-version'}'\n" if after_host_setup else ""))
        return bundle / "demo" / "install.sh"

    def host_without_compose(self):
        """Root on Ubuntu with a docker that has Compose only once the fake host setup writes its version."""
        version = self.root / "compose-version"
        stub(self.bin / "docker", f"echo \"docker $*\" >> '{self.log}'\n[ -f '{version}' ] || exit 1\n"
             "case \"$*\" in 'compose version') exit 0 ;; 'compose version --short') cat " f"'{version}' ;; *) exit 2 ;; esac")
        stub(self.bin / "id", "echo 0")
        stub(self.bin / "dpkg", f"echo \"dpkg $*\" >> '{self.log}'\necho amd64")

    def test_the_install_refuses_after_a_host_setup_that_left_no_compose(self):
        self.host_without_compose()
        result = subprocess.run(["sh", str(self.bundle("")), "--directory", str(self.install_root)],
                                capture_output=True, text=True, env=self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker Compose is not installed", result.stderr)
        # The host setup has run, so the message no longer promises that nothing changed.
        self.assertNotIn("Nothing was changed", result.stderr)
        self.assert_stopped_after_the_host_setup()

    def test_the_install_refuses_after_a_host_setup_that_left_an_old_compose(self):
        self.host_without_compose()
        result = subprocess.run(["sh", str(self.bundle("2.23.3")), "--directory", str(self.install_root)],
                                capture_output=True, text=True, env=self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker Compose 2.23.3 is too old", result.stderr)
        self.assertNotIn("Nothing was changed", result.stderr)
        self.assert_stopped_after_the_host_setup()

    def assert_stopped_after_the_host_setup(self):
        calls = [line for line in self.log.read_text().splitlines() if not line.startswith("docker compose version")]
        self.assertIn("host.sh", calls)
        # Nothing was installed, locked or started afterwards: no directory, lock, image or container call.
        after = calls[calls.index("host.sh") + 1:]
        self.assertEqual(after, [])
        self.assertFalse(self.install_root.exists())


@unittest.skipUnless(os.name == "posix", "POSIX shell test")
class ReinstallRestoreTests(unittest.TestCase):
    """A re-install of an install whose base-lib.sh was lost: the copy comes back on success and goes away
    again on a failed refresh, along with the rest of the rollback. Docker and the host tools are fakes."""

    OLD_COMPOSE = "# previous compose file\n"

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name)
        self.bin, self.root, self.flag, self.calls = base / "bin", base / "install", base / "fail-up", base / "calls"
        self.bin.mkdir()
        self.root.mkdir()
        stub(self.bin / "python3", "exit 0")
        stub(self.bin / "flock", "exit 0")
        stub(self.bin / "id", "echo 0")
        stub(self.bin / "docker",
             f'printf \'%s\\n\' "$*" >> \'{self.calls}\'\n'
             'case "$*" in "compose version") exit 0 ;; "compose version --short") echo 2.30.0 ;; "image inspect"*) exit 0 ;;\n'
             f'  "run "*) echo dns.providers.cloudflare ;; *" up "*) [ ! -f \'{self.flag}\' ] ;; esac')
        (self.root / ".env").write_text("DEMO_INSTALL=1\nDEMO_LOCAL_TEST=true\nAPP_IMAGE=plaingym:v0.0.0-test\n"
                                        "CADDY_IMAGE=plaingym-caddy:v0.0.0-test\n")
        (self.root / "compose.yaml").write_text(self.OLD_COMPOSE)
        shutil.copy(HERE / "lib.sh", self.root / "lib.sh")

    def reinstall(self):
        return subprocess.run(["sh", str(HERE / "install.sh"), "--directory", str(self.root), "--local-test"],
                              capture_output=True, text=True,
                              env={**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}"})

    def test_a_successful_reinstall_restores_the_lost_copy(self):
        result = self.reinstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "base-lib.sh").read_text(), (DEPLOY / "lib.sh").read_text())
        self.assertNotEqual((self.root / "compose.yaml").read_text(), self.OLD_COMPOSE)

    def test_a_failed_reinstall_puts_back_what_was_there_including_the_missing_copy(self):
        self.flag.write_text("")
        result = self.reinstall()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("restoring the previous files", result.stderr)
        self.assertFalse((self.root / "base-lib.sh").exists())
        self.assertEqual((self.root / "compose.yaml").read_text(), self.OLD_COMPOSE)
        self.assertFalse((self.root / "demo.compose.yaml").exists())
        self.assertIn("APP_IMAGE=plaingym:v0.0.0-test", (self.root / ".env").read_text())

    def test_a_failed_rerun_of_an_install_that_stopped_after_writing_env_still_cleans_up(self):
        # The first run wrote .env and stopped before the deploy files: the rollback has no stack to start, and
        # still removes the files this run copied, its backup folder and the inputs file (which holds the secrets).
        (self.root / "compose.yaml").unlink()
        (self.root / "lib.sh").unlink()
        temporary = Path(self.directory.name) / "tmp"
        temporary.mkdir()
        self.flag.write_text("")
        result = subprocess.run(["sh", str(HERE / "install.sh"), "--directory", str(self.root), "--local-test"],
                                capture_output=True, text=True,
                                env={**os.environ, "TMPDIR": str(temporary), "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("restoring the previous files", result.stderr)
        self.assertNotIn("lib.sh", result.stderr)
        for name in ("lib.sh", "base-lib.sh", "compose.yaml", "demo.compose.yaml"):
            self.assertFalse((self.root / name).exists(), name)
        self.assertEqual(list(self.root.glob(".deploy.*")), [])
        self.assertEqual(list(temporary.iterdir()), [])
        self.assertIn("APP_IMAGE=plaingym:v0.0.0-test", (self.root / ".env").read_text())
        starts = [call for call in self.calls.read_text().splitlines() if " up -d --pull never --wait " in call]
        self.assertEqual(len(starts), 1, starts)

    def test_a_failed_refresh_of_an_older_install_still_brings_the_stack_back(self):
        # An install made before the helper check has a lib.sh that looks for DEMO_FIRST_INSTALL instead. The
        # rollback restores that copy, removes the restored base-lib.sh and loads it, then starts the stack again.
        current = (HERE / "lib.sh").read_text()
        older = current.replace("elif ! command -v read_env >/dev/null 2>&1; then", 'elif [ "${DEMO_FIRST_INSTALL:-}" != true ]; then')
        self.assertNotEqual(older, current)
        (self.root / "lib.sh").write_text(older)
        self.flag.write_text("")
        result = self.reinstall()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("is missing", result.stderr)
        self.assertEqual((self.root / "lib.sh").read_text(), older)
        self.assertFalse((self.root / "base-lib.sh").exists())
        starts = [call for call in self.calls.read_text().splitlines() if " up -d --pull never --wait " in call]
        self.assertEqual(len(starts), 2, starts)


@unittest.skipUnless(os.name == "posix", "POSIX shell test")
class MergeDemoBillingTests(unittest.TestCase):
    """The installer adds demo billing values to a saved .env on a re-run."""

    KEY, SECRET = "sk_test_FAKEKEY123", "whsec_FAKESECRET456"

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        shutil.copy(DEPLOY / "lib.sh", self.root / "base-lib.sh")
        self.inputs = self.root / "inputs"

    def merge(self, saved, given):
        (self.root / ".env").write_text(saved)
        (self.root / ".env").chmod(0o644)
        self.inputs.write_text(given)
        result = subprocess.run(["sh", "-c", f'umask 022; ROOT="{self.root}"; . "{HERE / "lib.sh"}"; merge_demo_billing "{self.inputs}"'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse((self.root / ".env.next").exists())
        return (self.root / ".env").read_text()

    def test_a_rerun_adds_both_values_keeps_every_other_line_and_leaves_0600(self):
        saved = "# comment\nAPP_IMAGE=plaingym:v0.0.0-test\nDEMO_STRIPE_TEST_KEY=\n\nCADDY_IMAGE=c:v1.0.0\n"
        result = self.merge(saved, f"GYM_HOSTNAME=x\nDEMO_STRIPE_TEST_KEY={self.KEY}\nDEMO_STRIPE_WEBHOOK_SECRET={self.SECRET}\n")
        lines = result.splitlines()
        self.assertEqual([line for line in lines if not line.startswith("DEMO_STRIPE") and line != ""],
                         ["# comment", "APP_IMAGE=plaingym:v0.0.0-test", "CADDY_IMAGE=c:v1.0.0"])
        self.assertEqual(sorted(line for line in lines if line.startswith("DEMO_STRIPE")),
                         [f"DEMO_STRIPE_TEST_KEY={self.KEY}", f"DEMO_STRIPE_WEBHOOK_SECRET={self.SECRET}"])
        self.assertEqual(stat.S_IMODE((self.root / ".env").stat().st_mode), 0o600)

    def test_a_saved_value_is_left_alone_and_only_the_missing_one_is_added(self):
        saved = f"APP_IMAGE=a:v1.0.0\nDEMO_STRIPE_TEST_KEY={self.KEY}\n"
        result = self.merge(saved, "DEMO_STRIPE_TEST_KEY=sk_test_OTHER\nDEMO_STRIPE_WEBHOOK_SECRET=whsec_NEW\n")
        self.assertIn(f"DEMO_STRIPE_TEST_KEY={self.KEY}\n", result)
        self.assertNotIn("sk_test_OTHER", result)
        self.assertEqual(result.count("DEMO_STRIPE_TEST_KEY"), 1)
        self.assertIn("DEMO_STRIPE_WEBHOOK_SECRET=whsec_NEW\n", result)
        self.assertEqual(stat.S_IMODE((self.root / ".env").stat().st_mode), 0o600)

    def test_a_key_added_now_brings_its_own_secret_in_place_of_a_saved_one(self):
        saved = "A=1\nDEMO_STRIPE_TEST_KEY=\nDEMO_STRIPE_WEBHOOK_SECRET=whsec_OLD\n"
        result = self.merge(saved, f"DEMO_STRIPE_TEST_KEY={self.KEY}\nDEMO_STRIPE_WEBHOOK_SECRET={self.SECRET}\n")
        self.assertEqual(sorted(line for line in result.splitlines() if line.startswith("DEMO_STRIPE")),
                         [f"DEMO_STRIPE_TEST_KEY={self.KEY}", f"DEMO_STRIPE_WEBHOOK_SECRET={self.SECRET}"])
        self.assertNotIn("whsec_OLD", result)
        self.assertIn("A=1\n", result)

    def test_nothing_changes_when_both_are_saved_or_none_is_given(self):
        both = f"A=1\nDEMO_STRIPE_TEST_KEY={self.KEY}\nDEMO_STRIPE_WEBHOOK_SECRET={self.SECRET}\n"
        self.assertEqual(self.merge(both, "DEMO_STRIPE_TEST_KEY=sk_test_X\nDEMO_STRIPE_WEBHOOK_SECRET=whsec_X\n"), both)
        self.assertEqual(stat.S_IMODE((self.root / ".env").stat().st_mode), 0o644)
        plain = "A=1\nDEMO_STRIPE_TEST_KEY=\n"
        self.assertEqual(self.merge(plain, "GYM_HOSTNAME=x\n"), plain)

    def test_the_caddy_pin_update_writes_the_same_way(self):
        (self.root / ".env").write_text("CADDY_IMAGE=old:v1.0.0\nA=1\n")
        (self.root / ".env").chmod(0o644)
        script = (f'umask 022; ROOT="{self.root}"; . "{HERE / "lib.sh"}"; '
                  f'printf "CADDY_IMAGE=new:v2.0.0\\nA=1\\n" | env_next; commit_env_next')
        self.assertEqual(subprocess.run(["sh", "-c", script], capture_output=True, text=True).returncode, 0)
        self.assertEqual((self.root / ".env").read_text(), "CADDY_IMAGE=new:v2.0.0\nA=1\n")
        self.assertEqual(stat.S_IMODE((self.root / ".env").stat().st_mode), 0o600)


def interpolated_names(text):
    """Names a Compose file interpolates, as `${NAME}`, `${NAME:-default}` or a bare `$NAME` (`$$` is a literal)."""
    # `$$` is consumed first, so a variable right after it (`$$$NAME`) is still found.
    return {name for name in re.findall(r"\$\$|\$\{?(\w+)", text) if name}


def clean_environment():
    """The caller's environment without the variables the Compose files interpolate (braced or bare) or
    that Compose and the Docker CLI read themselves (COMPOSE_*, DOCKER_*), so an exported
    APP_MEMORY_LIMIT, E2E_IMAGE or COMPOSE_FILE cannot change the render; the tests pass what it needs.
    DOCKER_CONFIG stays: it is where a host keeps its Compose plugin, and it changes no render."""
    names = set().union(*(interpolated_names(file.read_text()) for file in COMPOSE_FILES))
    return {key: value for key, value in os.environ.items()
            if key not in names and (key == "DOCKER_CONFIG" or not key.startswith(("COMPOSE_", "DOCKER_")))}


def compose_available():
    """Whether Compose works in the environment the renders use."""
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True, env=clean_environment()).returncode == 0


# In CI a missing Compose is a failure, not a skip: the hardening tests must run there.
IN_CI = bool(os.environ.get("CI"))


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

    def test_the_probe_keeps_docker_config_where_the_plugin_lives(self):
        with tempfile.TemporaryDirectory() as directory:
            stub(Path(directory) / "docker", '[ -n "$DOCKER_CONFIG" ] && [ -z "$DOCKER_HOST" ]')
            with mock.patch.dict(os.environ, {"PATH": directory, "DOCKER_CONFIG": "/plugins", "DOCKER_HOST": "tcp://x"}):
                self.assertTrue(compose_available())

    @unittest.skipUnless(IN_CI, "CI only")
    def test_ci_has_compose(self):
        self.assertTrue(compose_available(), "the hardening tests need the docker compose plugin in CI")


@unittest.skipUnless(compose_available() or IN_CI, "needs the docker compose plugin")
class HardeningTests(unittest.TestCase):
    interpolated_names = staticmethod(interpolated_names)
    clean_environment = staticmethod(clean_environment)

    def render(self, files, env, caller=None, extra=None):
        """Render the files; `extra` is the text of one more Compose file merged over them."""
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("".join(f"{key}={value}\n" for key, value in env.items()))
            command = ["docker", "compose", "--env-file", str(env_file)]
            files = list(files)
            if extra:
                (Path(directory) / "extra.yaml").write_text(extra)
                files.append(Path(directory) / "extra.yaml")
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
        self.assertEqual(unsafe_step(services["migrate"], "postgres"), {})
        self.assertTrue(services["migrate"]["read_only"])
        self.assertEqual(services["migrate"]["cap_drop"], ["ALL"])

    def test_end_to_end_migrate_step_is_hardened_like_the_app(self):
        services = self.render([DEPLOY.parent / "e2e" / "compose.yaml"], E2E_ENV)
        # The throwaway End-to-end stack has no log rotation.
        self.assertEqual(unexpected_differences(self.demo_app(), services["demo-migrate"], also=("logging",)), {})
        self.assertEqual(unsafe_step(services["demo-migrate"], "demo-postgres", networks=("default",)), {})
        # The app services themselves are not hardened in End-to-end.
        self.assertNotIn("read_only", services["demo"])

    def test_a_new_key_on_the_app_fails_the_comparison(self):
        services = self.render([DEPLOY / "compose.yaml", HERE / "compose.yaml"], DEMO_ENV)
        for key, value in (("user", "1000"), ("ulimits", {"nofile": 1024}), ("cap_add", ["NET_ADMIN"])):
            with self.subTest(key=key):
                app = {**copy.deepcopy(services["app"]), key: value}
                self.assertIn(key, unexpected_differences(app, services["migrate"]))

    def test_a_migrate_step_given_a_socket_a_host_path_a_port_or_the_public_network_is_unsafe(self):
        files = [DEPLOY / "compose.yaml", HERE / "compose.yaml"]
        for name, extra, problem in (
                ("socket", "volumes: ['/var/run/docker.sock:/var/run/docker.sock']", "volumes"),
                ("host path", "volumes: ['/etc:/host-etc:ro']", "volumes"),
                ("the app's data volume", "volumes: ['appdata:/var/lib/plaingym']", "volumes"),
                ("port", "ports: ['127.0.0.1:8080:3000']", "ports"),
                ("public network", "networks: [database, web]", "networks"),
                ("another dependency", "depends_on: {sidecar: {condition: service_started}}", "depends_on")):
            with self.subTest(name):
                extra = f"services:\n  sidecar: {{image: busybox}}\n  migrate:\n    {extra}\n"
                step = self.render(files, DEMO_ENV, extra=extra)["migrate"]
                self.assertIn(problem, unsafe_step(step, "postgres"))

    def test_an_exported_memory_limit_does_not_change_the_render(self):
        expected = self.demo_app()
        # The premise: the variable does change a render that lets it through.
        self.assertNotEqual(self.demo_app({"APP_MEMORY_LIMIT": "64m"}), expected)
        with mock.patch.dict(os.environ, {"APP_MEMORY_LIMIT": "64m"}):
            self.assertNotIn("APP_MEMORY_LIMIT", self.clean_environment())
            self.assertEqual(self.demo_app(), expected)
            services = self.render([DEPLOY / "compose.yaml", HERE / "compose.yaml"], DEMO_ENV)
        self.assertEqual(unexpected_differences(services["app"], services["migrate"]), {})

    def test_the_clean_environment_drops_bare_variables_and_compose_and_docker_settings(self):
        self.assertEqual(self.interpolated_names("a: ${BRACED:-x} $BARE $$ESCAPED ${OTHER}"), {"BRACED", "BARE", "OTHER"})
        # A variable right after an escaped dollar is still a variable.
        self.assertEqual(self.interpolated_names("$$$AFTER $$${BRACED} $$$$LITERAL x$"), {"AFTER", "BRACED"})
        with mock.patch.dict(os.environ, {"COMPOSE_FILE": "x", "COMPOSE_PROFILES": "y", "DOCKER_HOST": "z",
                                          "DOCKER_CONTEXT": "c", "KEPT_BY_THE_TESTS": "1"}):
            environment = self.clean_environment()
        self.assertEqual(sorted(set(environment) & {"COMPOSE_FILE", "COMPOSE_PROFILES", "DOCKER_HOST", "DOCKER_CONTEXT"}), [])
        self.assertIn("KEPT_BY_THE_TESTS", environment)


if __name__ == "__main__":
    unittest.main()
