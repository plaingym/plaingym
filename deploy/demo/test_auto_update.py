#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Release/clock/Docker fixtures like deploy/test/patch.sh, with real Ed25519 signatures."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent
spec = importlib.util.spec_from_file_location("deploy_files", HERE / "deploy-files.py")
deploy_files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy_files)
HOST_FILES = ("update.sh", "lib.sh", "rotate-key.sh", "restore.sh", "release-signing.pem",
              "systemd/plaingym-update.service", "systemd/plaingym-update.timer")
IMAGE = "ghcr.io/example/app"
DIGEST = "sha256:" + "a" * 64
OLD_ID = "sha256:" + "b" * 64


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


@unittest.skipUnless(os.name == "posix" and getattr(os, "geteuid", lambda: -1)() == 0,
                     "Host updater requires POSIX and root; CI runs these fixtures with sudo.")
class UpdateFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root, self.bin, self.release = [self.base / name for name in ("installed", "bin", "release")]
        for path in (self.root, self.bin, self.release):
            path.mkdir()
        self.env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "FIXTURE": str(self.base), "SYSTEMD_UNIT_DIR": str(self.base / "units"),
                    "PYTHONDONTWRITEBYTECODE": "1", "FAKE_NIGHT": "2026-11-14", "FAKE_EPOCH": "1794639600"}
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(self.base / "private.pem")],
                       check=True, capture_output=True)
        subprocess.run(["openssl", "pkey", "-in", str(self.base / "private.pem"), "-pubout", "-out", str(self.root / "release-signing.pem")],
                       check=True, capture_output=True)
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(self.base / "prerelease-private.pem")],
                       check=True, capture_output=True)
        subprocess.run(["openssl", "pkey", "-in", str(self.base / "prerelease-private.pem"), "-pubout", "-out", str(self.root / "prerelease-signing.pem")],
                       check=True, capture_output=True)
        for source, target in deploy_files.mapping(True).items():
            path = self.root / target
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(DEPLOY / source, path)
        self.initial = ("DEMO_INSTALL=1\nDEMO_LOCAL_TEST=true\nAPP_IMAGE=" + IMAGE + ":v1.2.3\n"
                        "CADDY_IMAGE=plaingym-caddy:v2.11.7-cf0.2.4\nAUTH_SECRET=preserved\nDEMO_RELEASE_CHANNEL=stable\n")
        (self.root / ".env").write_text(self.initial)
        (self.base / "running").write_text("yes")
        self.make_tools()
        self.publish()

    def make_tools(self):
        executable(self.bin / "docker", '''#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
import json,os,sys
from pathlib import Path
base=Path(os.environ['FIXTURE']); a=sys.argv[1:]
with (base/'calls').open('a') as log: log.write('docker '+' '.join(a)+' target='+os.environ.get('DEMO_TARGET_APP_IMAGE','')+'\\n')
if a[:2]==['compose','version']:
    if '--short' in a: print('2.30.0')
elif a[:2]==['image','inspect']:
    pin=a[2]; fmt=a[-1]
    if 'RepoDigests' in fmt: print('ghcr.io/example/app@sha256:'+('d' if os.environ.get('BAD_DIGEST') else 'a')*64)
    elif 'image.version' in fmt:
        print('1.2.3' if pin=='ghcr.io/example/app:v1.2.3' else ('9.0.0' if os.environ.get('BAD_LABEL') else pin.split(':v')[1].split('@')[0]))
    elif '.Id' in fmt: print('sha256:'+('c' if ':v0.2.0@' in pin else 'b')*64)
elif a and a[0]=='compose':
    if 'config' in a:
        app=os.environ.get('BAD_COMPOSE_APP_IMAGE',os.environ['APP_IMAGE'])
        caddy=os.environ.get('BAD_COMPOSE_CADDY_IMAGE',os.environ['CADDY_IMAGE'])
        print(json.dumps({'services':{'app':{'image':app},'migrate':{'image':app},'caddy':{'image':caddy}}}))
    elif 'ps' in a:
        state=(base/'running').read_text()
        if state=='yes': print('app')
        elif state.startswith('seed:'):
            left=int(state[5:]); (base/'running').write_text('seed:'+str(left-1) if left>1 else 'no'); print('app')
    elif 'kill' in a:
        if os.environ.get('INTERRUPT_DRAIN'): os.kill(os.getppid(), 9)
        (base/'running').write_text('seed:'+os.environ['SEED_POLLS'] if os.environ.get('SEED_POLLS') else 'no')
    elif 'exec' in a and 'postgres' in a: print('PGDMP fixture')
    elif 'up' in a:
        if 'app' in a:
            (base/'running').write_text('yes')
            if os.environ.get('END_WINDOW'): (base/'end-window').touch()
            target=os.environ.get('DEMO_TARGET_APP_IMAGE','')
            if os.environ.get('INTERRUPT_STARTUP') or (os.environ.get('INTERRUPT_TAG') and (':'+os.environ['INTERRUPT_TAG']+'@') in target): os.kill(os.getppid(), 9)
            if (os.environ.get('FAIL_UPDATE') and target.startswith('ghcr.io/')) or (os.environ.get('FAIL_TAG') and (':'+os.environ['FAIL_TAG']+'@') in target):
                sys.exit(1)
''')
        executable(self.bin / "curl", '''#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
import json,os,sys,shutil
from pathlib import Path
a=sys.argv[1:]; base=Path(os.environ['FIXTURE'])
url=next(x for x in a if x.startswith('https://'))
with (base/'calls').open('a') as log: log.write('curl '+url+'\\n')
destination=Path(a[a.index('-o')+1])
if '/releases/tags/' in url:
    tag=url.rsplit('/',1)[1]
    choices=json.loads((base/'release/releases.json').read_text())
    release=next((r for r in choices if r.get('tag_name')==tag), None)
    if release is None: sys.exit(22)
    destination.write_text(json.dumps(release))
else:
    if 'api.github.com' in url:
        page=url.partition('&page=')[2]
        name=f'releases-page{page}.json' if page else 'releases.json'
    else:
        name=url.rsplit('/',1)[1]
    directory=base/'release'
    if '/download/' in url:
        tagged=directory/url.split('/download/')[1].split('/')[0]
        if tagged.is_dir(): directory=tagged
    shutil.copyfile(directory/name, destination)
''')
        executable(self.bin / "date", '''#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
case "$*" in
  +%H) if [ -f "$FIXTURE/end-window" ]; then echo 05; else echo "${FAKE_HOUR:-03}"; fi ;;
  +%F) echo "$FAKE_NIGHT" ;;
  '-u +%s') echo "$FAKE_EPOCH" ;;
  *) exec /bin/date "$@" ;;
esac
''')
        executable(self.bin / "systemctl", '#!/bin/sh\n# SPDX-License-Identifier: AGPL-3.0-only\nprintf "systemctl %s\\n" "$*" >> "$FIXTURE/calls"\n')
        executable(self.bin / "sleep", '#!/bin/sh\n# SPDX-License-Identifier: AGPL-3.0-only\nprintf "seed wait\\n" >> "$FIXTURE/calls"\n')

    def publish(self, tag="v1.3.0", mutate=None, prerelease=False, floor=None, signer=None, signed_channel=None):
        self.tag = tag
        staging = self.base / "staged"
        shutil.rmtree(staging, ignore_errors=True)
        for name in set(HOST_FILES) | set(deploy_files.mapping(True)):
            path = staging / "deploy" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            public = "prerelease-signing.pem" if prerelease else "release-signing.pem"
            shutil.copyfile(self.root / public if name == "release-signing.pem" else DEPLOY / name, path)
        # Both public and local configurations must be present in a release archive.
        shutil.copyfile(HERE / "Caddyfile", staging / "deploy/demo/Caddyfile")
        with (staging / "deploy/demo/compose.yaml").open("a") as file:
            file.write(f"\n# verified release refresh {tag}\n")
        if mutate:
            mutate(staging)
        archive = self.release / f"plaingym-deploy-{tag}.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            bundle.add(staging / "deploy", arcname="deploy")
        floor = floor or ("v0.1.0" if prerelease else "v1.0.0")
        signed_channel = ("prerelease" if prerelease else "") if signed_channel is None else signed_channel
        manifest = (f"format=plaingym-release-manifest/2\nversion={tag}\nimage={IMAGE}\ndigest={DIGEST}\n"
                    f"revision={'c' * 40}\nmigrations=sha256:{'d' * 64}\nrollback_floor={floor}\nhost_format=1\n"
                    f"deploy_archive={archive.name}\ndeploy_archive_sha256=sha256:{hashlib.sha256(archive.read_bytes()).hexdigest()}\n")
        if signed_channel:
            manifest += f"channel={signed_channel}\n"
        for name in HOST_FILES:
            manifest += f"host.{name.lower()}=sha256:{hashlib.sha256((staging / 'deploy' / name).read_bytes()).hexdigest()}\n"
        (self.release / "release-manifest.txt").write_text(manifest)
        self.sign(signer or ("prerelease-private.pem" if prerelease else "private.pem"))
        self.tags([{"tag_name": tag, "prerelease": prerelease}, "v2.0.0", "v1.2.4"])

    def sign(self, key="private.pem"):
        subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", str(self.base / key), "-rawin",
                        "-in", str(self.release / "release-manifest.txt"), "-out", str(self.release / "release-manifest.txt.sig")],
                       check=True, capture_output=True)

    def tags(self, tags):
        (self.release / "releases.json").write_text(json.dumps([tag if isinstance(tag, dict) else {"tag_name": tag} for tag in tags]))

    def keep_release(self):
        directory = self.release / self.tag
        directory.mkdir()
        for path in self.release.iterdir():
            if path.is_file() and path.name != "releases.json":
                shutil.copyfile(path, directory / path.name)

    def run_update(self, *args, **env):
        return subprocess.run(["bash", str(self.root / "update.sh"), *(args or ("--auto", "--now"))],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=30)

    def calls(self):
        return (self.base / "calls").read_text() if (self.base / "calls").exists() else ""

    def status(self):
        return (self.root / "auto-update.status").read_text()


class AutoUpdateTests(UpdateFixture):
    def test_newer_minor_refreshes_deploy_files_and_preserves_credentials_proxy_and_key(self):
        key = (self.root / "release-signing.pem").read_bytes()
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"APP_IMAGE={IMAGE}:v1.3.0@{DIGEST}", (self.root / ".env").read_text())
        for line in ("AUTH_SECRET=preserved", "CADDY_IMAGE=plaingym-caddy:v2.11.7-cf0.2.4"):
            self.assertIn(line, (self.root / ".env").read_text())
        self.assertEqual((self.root / "release-signing.pem").read_bytes(), key)
        self.assertIn("verified release refresh", (self.root / "demo.compose.yaml").read_text())
        self.assertEqual((self.root / "postgres/01-roles.sh").stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.root / "update.sh").stat().st_mode & 0o777, 0o700)
        self.assertIn("updated; from=v1.2.3 to=v1.3.0", self.status())
        self.assertEqual(self.run_update("--status").stdout, self.status())
        self.assertLess(self.calls().index(".RepoDigests"), self.calls().index("kill --signal SIGTERM"))
        self.assertIn("--pull never", self.calls())
        self.assertIn("--auto", (self.base / "units/plaingym-demo-update.service").read_text())
        self.assertFalse((self.root / ".demo-deploy-update").exists())

    def test_newer_patch_installs_but_major_and_prerelease_do_not(self):
        self.publish("v1.2.4")
        self.tags(["v2.0.0", "v1.2.4", "v1.9.0-beta"])
        self.assertEqual(self.run_update().returncode, 0)
        self.assertIn("to=v1.2.4", self.status())

    def test_major_only_is_up_to_date(self):
        self.tags(["v2.0.0", "v1.2.3"])
        self.assertEqual(self.run_update().returncode, 0)
        self.assertIn("up_to_date", self.status())
        self.assertNotIn("docker pull", self.calls())

    def test_draft_and_prerelease_are_ignored(self):
        (self.release / "releases.json").write_text(json.dumps([
            {"tag_name": "v1.3.0", "draft": True}, {"tag_name": "v1.4.0", "prerelease": True}]))
        self.run_update()
        self.assertIn("up_to_date", self.status())

    def test_bad_signature_is_never_retried_even_with_now(self):
        (self.release / "release-manifest.txt.sig").write_bytes(b"x" * 64)
        self.run_update()
        self.assertIn("signature_invalid", self.status())
        calls = self.calls().count("release-manifest.txt.sig")
        self.run_update()
        self.assertIn("previously_refused_signature_invalid", self.status())
        self.assertEqual(self.calls().count("release-manifest.txt.sig"), calls)
        self.assertNotIn("docker pull", self.calls())
        self.assertNotIn("kill --signal", self.calls())

    def test_signed_invalid_manifest_is_refused(self):
        path = self.release / "release-manifest.txt"
        path.write_text(path.read_text() + "version=v1.3.0\n")
        self.sign()
        self.run_update()
        self.assertIn("manifest_invalid", self.status())
        self.assertNotIn("docker pull", self.calls())

    def test_digest_and_label_mismatches_never_stop_app_and_are_not_retried(self):
        for setting, reason in (("BAD_DIGEST", "digest_mismatch"), ("BAD_LABEL", "label_mismatch")):
            with self.subTest(setting=setting):
                (self.root / "auto-update.state").unlink(missing_ok=True)
                (self.base / "calls").unlink(missing_ok=True)
                self.run_update(**{setting: "1"})
                self.assertIn(reason, self.status())
                self.assertNotIn("kill --signal", self.calls())
                self.run_update()
                self.assertEqual(self.calls().count("docker pull"), 1)

    def test_tampered_deploy_archive_is_refused(self):
        with (self.release / f"plaingym-deploy-{self.tag}.tar.gz").open("ab") as file:
            file.write(b"tampered")
        self.run_update()
        self.assertIn("deploy_archive_invalid", self.status())
        self.assertNotIn("docker pull", self.calls())

    def test_new_caddy_build_is_skipped(self):
        def mutate(stage):
            (stage / "deploy/demo/Dockerfile").write_text("# SPDX-License-Identifier: AGPL-3.0-only\nFROM new-caddy\n")
        self.publish(mutate=mutate)
        self.run_update()
        self.assertIn("caddy_image_required", self.status())
        self.assertNotIn("docker pull", self.calls())

    def test_rendered_compose_cannot_replace_verified_app_or_retained_proxy(self):
        for setting, reason in (("BAD_COMPOSE_APP_IMAGE", "deploy_image_mismatch"),
                                ("BAD_COMPOSE_CADDY_IMAGE", "caddy_image_required")):
            with self.subTest(setting=setting):
                (self.root / "auto-update.state").unlink(missing_ok=True)
                self.run_update(**{setting: "example/unverified:latest"})
                self.assertIn(reason, self.status())
                self.assertNotIn("docker pull", self.calls())
                self.assertNotIn("kill --signal", self.calls())

    def test_failed_update_restores_pin_files_units_and_retries_at_most_twice(self):
        before = (self.root / "demo.compose.yaml").read_bytes()
        for _ in range(2):
            result = self.run_update(FAIL_UPDATE="1")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("rolled_back", self.status())
            self.assertEqual((self.root / ".env").read_text(), self.initial)
            self.assertEqual((self.root / "demo.compose.yaml").read_bytes(), before)
            self.assertFalse((self.base / "units/plaingym-demo-update.service").exists())
        self.run_update()
        self.assertIn("repeated_failure", self.status())
        self.assertEqual(self.calls().count("kill --signal SIGTERM"), 2)
        self.assertIn(OLD_ID, self.calls())
        self.publish("v1.3.1")
        self.assertEqual(self.run_update().returncode, 0)
        self.assertIn("updated", self.status())

    def test_outside_window_and_off_do_nothing(self):
        for args, env in ((("--auto",), {"FAKE_HOUR": "01"}), (("--auto",), {"FAKE_HOUR": "05"})):
            result = self.run_update(*args, **env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("curl ", self.calls())
            self.assertFalse((self.root / "auto-update.status").exists())
        with (self.root / ".env").open("a") as file:
            file.write("DEMO_AUTO_UPDATE=off\n")
        self.assertEqual(self.run_update().returncode, 0)
        self.assertNotIn("curl ", self.calls())

    def test_once_per_night_and_now_bypasses_window(self):
        self.tags(["v1.2.3"])
        self.run_update("--auto")
        self.run_update("--auto")
        self.assertEqual(self.calls().count("curl "), 1)
        self.run_update(FAKE_HOUR="12")
        self.assertEqual(self.calls().count("curl "), 2)

    def test_locked_install_is_skipped_without_network_or_stop(self):
        result = subprocess.run(["flock", str(self.root / ".install.lock"), "bash", str(self.root / "update.sh"), "--auto", "--now"],
                                env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("holds_the_lock", result.stdout)
        self.assertNotIn("curl ", self.calls())

    def test_seed_drains_before_snapshot_and_migration(self):
        result = self.run_update(SEED_POLLS="3")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls().count("seed wait"), 3)
        self.assertLess(self.calls().rindex("seed wait"), self.calls().index("pg_dump"))
        self.assertNotIn(" stop ", self.calls())

    def test_interrupted_attempt_restarts_pin_without_retrying_release(self):
        result = self.run_update(INTERRUPT_DRAIN="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.root / ".demo-update.inflight").exists())
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recovered", self.status())
        self.assertEqual((self.root / ".env").read_text(), self.initial)
        self.assertEqual(self.calls().count("docker pull"), 1)
        self.assertIn("attempts.v1.3.0=1", (self.root / "auto-update.state").read_text())

    def test_interrupted_attempt_is_recovered_at_the_next_hourly_run(self):
        self.assertNotEqual(self.run_update("--auto", INTERRUPT_DRAIN="1").returncode, 0)
        result = self.run_update("--auto", FAKE_HOUR="12")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recovered", self.status())
        self.assertFalse((self.root / ".demo-update.inflight").exists())
        self.assertIn("--force-recreate --wait --wait-timeout 180 caddy", self.calls())
        self.assertEqual(self.calls().count("docker pull"), 1)

    def test_explicit_update_after_interrupted_attempt_installs_requested_image(self):
        self.assertNotEqual(self.run_update(INTERRUPT_DRAIN="1").returncode, 0)
        self.publish("v1.2.4")
        result = self.run_update(f"{IMAGE}:v1.2.4")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recovered an interrupted attempt", result.stdout)
        self.assertIn(f"APP_IMAGE={IMAGE}:v1.2.4@{DIGEST}\n", (self.root / ".env").read_text())
        self.assertFalse((self.root / ".demo-update.inflight").exists())

    def test_rollback_floor_above_running_release_is_skipped_not_refused(self):
        path = self.release / "release-manifest.txt"
        path.write_text(path.read_text().replace("rollback_floor=v1.0.0", "rollback_floor=v1.3.0"))
        self.sign()
        self.assertEqual(self.run_update().returncode, 0)
        self.assertIn("rollback_floor_above_running", self.status())
        self.assertNotIn("docker pull", self.calls())
        self.assertNotIn("refused.", (self.root / "auto-update.state").read_text())

    def test_stopped_demo_uses_no_attempt(self):
        (self.base / "running").write_text("no")
        self.assertEqual(self.run_update().returncode, 0)
        self.assertIn("app_not_running", self.status())
        self.assertNotIn("attempts.", (self.root / "auto-update.state").read_text())
        self.assertNotIn("kill --signal", self.calls())

    def test_interrupted_refresh_restores_host_files_before_restarting_pin(self):
        before = (self.root / "demo.compose.yaml").read_bytes()
        result = self.run_update(INTERRUPT_STARTUP="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.root / ".demo-deploy-update").exists())
        self.assertNotEqual((self.root / "demo.compose.yaml").read_bytes(), before)
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "demo.compose.yaml").read_bytes(), before)
        self.assertEqual((self.root / ".env").read_text(), self.initial)
        self.assertFalse((self.root / ".demo-deploy-update").exists())
        self.assertFalse((self.root / ".demo-update.inflight").exists())


class DeployArchiveTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "posix", "Shared host helpers require POSIX.")
    def test_prepared_file_modes_agree_with_shared_host_modes(self):
        for local in (True, False):
            for target in deploy_files.mapping(local).values():
                name = Path(target).name
                with self.subTest(local=local, name=name):
                    result = subprocess.run(["bash", "-c", '. deploy/lib.sh; host_mode "$1"', "_", name],
                                            cwd=DEPLOY.parent, check=True, capture_output=True, text=True, timeout=10)
                    self.assertEqual(oct(deploy_files.mode(name)), "0o" + result.stdout.strip().removeprefix("0"))

    @unittest.skipUnless(os.name == "posix", "Shared journal requires POSIX.")
    def test_missing_installed_base_lib_is_refused_before_starting_a_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, binaries = base / "installed", base / "bin"
            root.mkdir()
            binaries.mkdir()
            shutil.copyfile(HERE / "deploy-files.py", root / "deploy-files.py")
            (base / "lib.sh").touch()
            log = base / "calls"
            for shell in ("sh", "bash"):
                executable(binaries / shell, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$CALL_LOG"\n')
            env = {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                   "CALL_LOG": str(log), "SYSTEMD_UNIT_DIR": str(base / "units")}
            result = subprocess.run([sys.executable, str(root / "deploy-files.py"), "recover", str(root)],
                                    env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("base-lib.sh is missing", result.stderr)
            self.assertFalse(log.exists(), log.read_text() if log.exists() else "")

    @unittest.skipUnless(os.name == "posix", "Shared journal requires POSIX.")
    def test_recover_removes_only_the_stale_next_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, units, outside = base / "installed", base / "units", base / "outside"
            root.mkdir()
            outside.mkdir()
            original = outside / "x"
            original.write_text("keep")
            stale = root / ".demo-deploy-next"
            (stale / "files").mkdir(parents=True)
            (stale / "files/x").touch()
            deploy_files.recover(root, units)
            self.assertFalse(stale.exists())
            deploy_files.recover(root, units)
            self.assertEqual(list(root.iterdir()), [])
            stale.touch()
            deploy_files.recover(root, units)
            self.assertFalse(stale.exists())
            for target in (outside, outside / "missing"):
                with self.subTest(target=target):
                    stale.symlink_to(target)
                    deploy_files.recover(root, units)
                    self.assertFalse(stale.is_symlink())
                    self.assertEqual(original.read_text(), "keep")

    @unittest.skipUnless(os.name == "posix", "Shared journal requires POSIX.")
    def test_shared_journal_restores_demo_files_absence_and_units_and_keeps_committed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, staged, units, binaries = [base / name for name in ("installed % demo", "staged", "units", "bin")]
            for path in (root, staged, units, binaries):
                path.mkdir()
            executable(binaries / "systemctl", "#!/bin/sh\nexit 0\n")
            for source, name in deploy_files.mapping(True).items():
                for destination in (root, staged):
                    path = destination / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(DEPLOY / source, path)
            (root / "Caddyfile").unlink()
            (root / "compose.yaml").write_text("before\n")
            (root / "rotate-key.sh").write_text("unrelated\n")
            (units / deploy_files.UNITS[0]).write_text("old unit\n")
            (root / ".env").write_text("APP_IMAGE=old\n")
            with mock.patch.dict(os.environ, {"PATH": str(binaries) + os.pathsep + os.environ["PATH"]}):
                deploy_files.journal_command("apply", root, units, staged, "new")
                journal = root / ".demo-deploy-update"
                self.assertTrue((journal / "before/files/base-lib.sh").is_file())
                self.assertTrue((journal / "helper.sh").is_file())
                self.assertIn("installed %% demo", (units / deploy_files.UNITS[0]).read_text())
                deploy_files.recover(root, units)
                self.assertEqual((root / "compose.yaml").read_text(), "before\n")
                self.assertFalse((root / "Caddyfile").exists())
                self.assertEqual((units / deploy_files.UNITS[0]).read_text(), "old unit\n")
                self.assertFalse((units / deploy_files.UNITS[1]).exists())
                self.assertEqual((root / "rotate-key.sh").read_text(), "unrelated\n")
                deploy_files.journal_command("apply", root, units, staged, "new")
                (root / ".env").write_text("APP_IMAGE=new\n")
                deploy_files.recover(root, units)
                self.assertEqual((root / "compose.yaml").read_bytes(), (staged / "compose.yaml").read_bytes())
                self.assertFalse(journal.exists())
                self.assertFalse(list(root.glob(".demo-deploy-retired.*")))

    def test_symlinks_and_duplicate_demo_members_are_rejected(self):
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "deploy.tar.gz"
                with tarfile.open(archive, "w:gz") as bundle:
                    for name in deploy_files.mapping(True):
                        member = tarfile.TarInfo("deploy/" + name)
                        member.size = 1
                        if not duplicate and name == "demo/update.sh":
                            member.type = tarfile.SYMTYPE
                            member.linkname = "/etc/passwd"
                            bundle.addfile(member)
                        else:
                            bundle.addfile(member, io.BytesIO(b"x"))
                            if duplicate and name == "demo/update.sh":
                                bundle.addfile(member, io.BytesIO(b"x"))
                with self.assertRaises(ValueError):
                    deploy_files.prepare(archive, root / "prepared", True)

    @unittest.skipUnless(os.name == "posix", "Journal recovery uses os.sync.")
    def test_incomplete_journal_is_refused_and_a_retired_one_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text("APP_IMAGE=example/app:v1.3.0\n")
            (root / ".demo-deploy-retired/files").mkdir(parents=True)
            (root / ".demo-deploy-update/files").mkdir(parents=True)
            # A kill during deletion must not leave a journal that the next run treats as complete.
            with self.assertRaises(RuntimeError):
                deploy_files.recover(root, root / "units")
            self.assertFalse((root / ".demo-deploy-retired").exists())
            (root / ".demo-deploy-update/target").write_text("example/app:v1.3.0")
            deploy_files.recover(root, root / "units")
            self.assertFalse((root / ".demo-deploy-update").exists())
            self.assertFalse((root / ".demo-deploy-retired").exists())

    @unittest.skipUnless(os.name == "posix", "Shared journal requires POSIX.")
    def test_recover_removes_retired_file_and_symlinks(self):
        for kind in ("file", "directory symlink", "broken symlink"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                root, units, outside = base / "installed", base / "units", base / "outside"
                root.mkdir()
                outside.mkdir()
                original = outside / "x"
                original.write_text("keep")
                retired = root / ".demo-deploy-retired"
                if kind == "file":
                    retired.touch()
                else:
                    retired.symlink_to(outside if kind == "directory symlink" else outside / "missing")
                deploy_files.recover(root, units)
                self.assertFalse(retired.exists())
                self.assertFalse(retired.is_symlink())
                self.assertEqual(original.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
