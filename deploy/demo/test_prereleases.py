#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Demo channel separation, ordered catch-up and the explicit bundle switch."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_auto_update import DEPLOY, DIGEST, IMAGE, UpdateFixture

ORDER = ["v1.0.9", "v1.1.0-nightly.1", "v1.1.0-nightly.2", "v1.1.0-nightly.10", "v1.1.0", "v1.1.1", "v1.2.0-nightly.1"]


@unittest.skipUnless(os.name == "posix", "The demo updater's selection runs in bash.")
class SelectionOrderTests(unittest.TestCase):
    def select(self, current, releases, channel="prerelease"):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "releases.json"
            path.write_text(json.dumps(releases))
            result = subprocess.run(["bash", "-c", '. "$1/lib.sh"; . "$1/demo/auto-update.sh"; demo_select_release "$2" "$3" "$4"',
                                     "bash", str(DEPLOY), current, str(path), channel], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.split()

    def test_releases_and_nightlies_are_taken_in_one_order(self):
        releases = [{"tag_name": tag, "prerelease": "nightly" in tag} for tag in reversed(ORDER)]
        for current, following in zip(ORDER, ORDER[1:]):
            with self.subTest(current=current):
                self.assertEqual(self.select(current, releases)[0], following)
        self.assertEqual(self.select(ORDER[-1], releases), [])
        # The stable channel takes the newest release of the major, from a release or a nightly.
        for current in ("v1.0.9", "v1.1.0-nightly.10"):
            self.assertEqual(self.select(current, releases, "stable"), ["v1.1.1", "stable"])


class PrereleaseTests(UpdateFixture):
    def setUp(self):
        super().setUp()
        # An absent channel exercises the default on existing installations too.
        self.initial = self.initial.replace("v1.2.3", "v0.1.0").replace("DEMO_RELEASE_CHANNEL=stable\n", "")
        (self.root / ".env").write_text(self.initial)
        self.publish("v0.2.0", prerelease=True)

    def chain(self):
        self.keep_release()
        self.publish("v0.3.0", prerelease=True, floor="v0.2.0")
        self.keep_release()
        self.tags([{"tag_name": tag, "prerelease": True} for tag in ("v0.3.0", "v0.2.0")])

    def test_default_channel_installs_prerelease_and_preserves_both_keys(self):
        keys = {name: (self.root / name).read_bytes() for name in ("release-signing.pem", "prerelease-signing.pem")}
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.2.0@{DIGEST}", (self.root / ".env").read_text())
        self.assertIn("updated; from=v0.1.0 to=v0.2.0", self.status())
        for name, original in keys.items():
            self.assertEqual((self.root / name).read_bytes(), original)

    def test_stable_channel_ignores_prerelease(self):
        with (self.root / ".env").open("a") as file:
            file.write("DEMO_RELEASE_CHANNEL=stable\n")
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("up_to_date", self.status())
        self.assertNotIn("release-manifest", self.calls())
        self.assertNotIn("kill --signal", self.calls())

    def test_wrong_key_is_refused_for_each_channel_and_for_explicit_updates(self):
        for prerelease, signer in ((True, "private.pem"), (False, "prerelease-private.pem")):
            with self.subTest(prerelease=prerelease):
                self.publish("v0.2.0", prerelease=prerelease, signer=signer, floor="v0.1.0")
                (self.root / "auto-update.state").unlink(missing_ok=True)
                self.assertEqual(self.run_update().returncode, 0)
                self.assertIn("signature_invalid", self.status())
                explicit = self.run_update(f"{IMAGE}:v0.2.0")
                self.assertNotEqual(explicit.returncode, 0)
                self.assertIn("signature_invalid", explicit.stderr)
                self.assertEqual((self.root / ".env").read_text(), self.initial)
        self.assertNotIn("docker pull", self.calls())
        self.assertNotIn("kill --signal", self.calls())

    def test_stable_release_on_prerelease_channel_uses_release_key(self):
        self.publish("v0.2.0", floor="v0.1.0")
        (self.root / "prerelease-signing.pem").unlink()
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("updated; from=v0.1.0 to=v0.2.0", self.status())

    def test_missing_prerelease_key_is_reported_and_holds_the_chain(self):
        self.chain()
        (self.root / "prerelease-signing.pem").unlink()
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("skipped; from=v0.1.0 to=v0.2.0 reason=no_prerelease_key", self.status())
        self.assertEqual(result.stdout, self.status())
        self.assertEqual((self.root / ".env").read_text(), self.initial)
        self.assertNotIn("release-manifest", self.calls())
        self.assertNotIn("kill --signal", self.calls())

    def test_signed_channel_must_match_github_flag(self):
        for prerelease, signed_channel in ((True, ""), (False, "prerelease")):
            with self.subTest(prerelease=prerelease):
                self.publish("v0.2.0", prerelease=prerelease, signed_channel=signed_channel, floor="v0.1.0")
                (self.root / "auto-update.state").unlink(missing_ok=True)
                self.run_update()
                self.assertIn("channel_mismatch", self.status())
        self.assertNotIn("kill --signal", self.calls())

    def test_two_missed_prereleases_install_in_order_in_one_window(self):
        self.chain()
        result = self.run_update("--auto")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(result.stdout.index("updated; from=v0.1.0 to=v0.2.0"),
                        result.stdout.index("updated; from=v0.2.0 to=v0.3.0"))
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.3.0@{DIGEST}", (self.root / ".env").read_text())
        state = (self.root / "auto-update.state").read_text()
        for tag in ("v0.2.0", "v0.3.0"):
            self.assertIn(f"attempts.{tag}=1", state)
        self.assertEqual(self.calls().count("kill --signal SIGTERM"), 2)
        self.assertEqual(len(list((self.root / "snapshots").glob("*.dump"))), 2)

    def test_catchup_keeps_starting_snapshot_and_two_newest(self):
        def legacy_pruner(stage):
            path = stage / "deploy/demo/snapshots.py"
            path.write_text(path.read_text().replace('    parser.add_argument("--protect", type=Path)\n', "")
                            .replace("prune(args.directory, args.keep, args.protect)", "prune(args.directory, args.keep)"))

        for minor in range(2, 6):
            self.publish(f"v0.{minor}.0", prerelease=True, floor=f"v0.{minor - 1}.0", mutate=legacy_pruner)
            self.keep_release()
        self.tags([{"tag_name": f"v0.{minor}.0", "prerelease": True} for minor in range(5, 0, -1)])
        result = self.run_update(DEMO_SNAPSHOT_RETENTION="2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([line.split(" to=")[1].split()[0] for line in result.stdout.splitlines()
                          if line.startswith("Demo release update: updated;")],
                         [f"v0.{minor}.0" for minor in range(2, 6)])
        marker = "Pre-update snapshot: "
        snapshots = [Path(line.split(marker, 1)[1]) for line in result.stdout.splitlines() if marker in line]
        self.assertEqual(len(snapshots), 4)
        self.assertEqual(set((self.root / "snapshots").iterdir()), {snapshots[0], *snapshots[-2:]})

    def test_second_failure_keeps_first_release_running_and_limits_attempts_per_tag(self):
        self.chain()
        for _ in range(2):
            result = self.run_update(FAIL_TAG="v0.3.0")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("rolled_back; from=v0.2.0 to=v0.3.0", self.status())
            self.assertIn(f"APP_IMAGE={IMAGE}:v0.2.0@{DIGEST}", (self.root / ".env").read_text())
            self.assertEqual((self.base / "running").read_text(), "yes")
            self.assertIn("verified release refresh v0.2.0", (self.root / "demo.compose.yaml").read_text())
            self.assertNotIn("verified release refresh v0.3.0", (self.root / "demo.compose.yaml").read_text())
            self.assertIn("target=sha256:" + "c" * 64, self.calls())
        self.assertEqual(self.run_update().returncode, 0)
        self.assertIn("repeated_failure", self.status())
        state = (self.root / "auto-update.state").read_text()
        self.assertIn("attempts.v0.2.0=1", state)
        self.assertIn("attempts.v0.3.0=2", state)

    def test_second_interruption_recovers_first_pin_outside_window(self):
        self.chain()
        result = self.run_update(INTERRUPT_TAG="v0.3.0")
        self.assertNotEqual(result.returncode, 0)
        result = self.run_update("--auto", FAKE_HOUR="12")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recovered", self.status())
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.2.0@{DIGEST}", (self.root / ".env").read_text())
        self.assertFalse((self.root / ".demo-update.inflight").exists())
        self.assertFalse((self.root / ".demo-deploy-update").exists())
        self.assertEqual((self.base / "running").read_text(), "yes")

    def test_catchup_stops_when_window_closes_and_resumes_next_night(self):
        self.chain()
        result = self.run_update("--auto", END_WINDOW="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("updated; from=v0.1.0 to=v0.2.0", self.status())
        self.assertNotIn("v0.3.0/release-manifest", self.calls())
        (self.base / "end-window").unlink()
        result = self.run_update("--auto", FAKE_NIGHT="2026-11-15", FAKE_EPOCH="1794726000")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("updated; from=v0.2.0 to=v0.3.0", self.status())

    def test_prerelease_archive_cannot_change_its_trust_key(self):
        def mutate(stage):
            (stage / "deploy/release-signing.pem").write_bytes((self.root / "release-signing.pem").read_bytes())
        self.publish("v0.2.0", prerelease=True, mutate=mutate)
        self.run_update()
        self.assertIn("deploy_archive_invalid", self.status())
        self.assertNotIn("kill --signal", self.calls())

    def test_floor_above_running_blocks_entire_chain_without_an_attempt(self):
        self.publish("v0.2.0", prerelease=True, floor="v0.2.0")
        self.chain()
        self.assertEqual(self.run_update().returncode, 0)
        self.assertIn("rollback_floor_above_running", self.status())
        self.assertNotIn("attempts.", (self.root / "auto-update.state").read_text())
        self.assertNotIn("v0.3.0/release-manifest", self.calls())
        self.assertNotIn("kill --signal", self.calls())

    def test_explicit_switch_from_bundle_verifies_and_pins_prerelease(self):
        self.initial = self.initial.replace(f"{IMAGE}:v0.1.0", "plaingym:v0.0.0-local")
        (self.root / ".env").write_text(self.initial)
        self.run_update()
        self.assertIn("version_unknown", self.status())
        # First prerelease has itself as floor; the operator's switch crosses it.
        self.publish("v0.2.0", prerelease=True, floor="v0.2.0")
        result = self.run_update(f"{IMAGE}:v0.2.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.2.0@{DIGEST}", (self.root / ".env").read_text())
        self.assertIn("/releases/tags/v0.2.0", self.calls())
        self.assertLess(self.calls().index(".RepoDigests"), self.calls().index("kill --signal SIGTERM"))

    def test_explicit_image_must_match_signed_manifest(self):
        result = self.run_update("ghcr.io/another/app:v0.2.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("image_mismatch", result.stderr)
        self.assertNotIn("kill --signal", self.calls())

    def test_prerelease_caddy_change_is_still_refused(self):
        def mutate(stage):
            (stage / "deploy/demo/Dockerfile").write_text("# SPDX-License-Identifier: AGPL-3.0-only\nFROM changed\n")
        self.publish("v0.2.0", prerelease=True, mutate=mutate)
        self.run_update()
        self.assertIn("caddy_image_required", self.status())
        self.assertNotIn("kill --signal", self.calls())

    def test_pagination_continues_past_a_full_page_that_contains_running_version(self):
        self.chain()
        self.publish("v0.1.5", prerelease=True, floor="v0.1.0")
        self.keep_release()
        self.tags([{"tag_name": tag, "prerelease": True} for tag in ("v0.3.0", "v0.2.0", "v0.1.0")]
                  + [{"tag_name": f"v0.0.{index}", "draft": True} for index in range(97)])
        (self.release / "releases-page2.json").write_text(json.dumps([{"tag_name": "v0.1.5", "prerelease": True}]))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("&page=2", self.calls())
        self.assertEqual(self.calls().count("/releases?per_page=100"), 2)
        self.assertLess(result.stdout.index("to=v0.1.5"), result.stdout.index("to=v0.2.0"))
        self.assertLess(result.stdout.index("to=v0.2.0"), result.stdout.index("to=v0.3.0"))
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.3.0@{DIGEST}", (self.root / ".env").read_text())

    def test_pagination_finds_intermediate_prerelease_on_later_page(self):
        self.chain()
        first = [{"tag_name": "v0.3.0", "prerelease": True}]
        first += [{"tag_name": f"v0.0.{index}", "draft": True} for index in range(99)]
        self.tags(first)
        second = [{"tag_name": tag, "prerelease": True} for tag in ("v0.2.0", "v0.1.0")]
        (self.release / "releases-page2.json").write_text(json.dumps(second))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(result.stdout.index("to=v0.2.0"), result.stdout.index("to=v0.3.0"))
        self.assertIn("&page=2", self.calls())

    def test_full_pages_without_running_version_stop_at_safety_cap(self):
        full_page = [{"tag_name": "v0.2.0", "prerelease": True},
                     {"tag_name": "v0.0.0-local"}]
        full_page += [{"tag_name": f"v0.0.{index}", "draft": True} for index in range(98)]
        self.tags(full_page)
        for page in range(2, 11):
            (self.release / f"releases-page{page}.json").write_text(json.dumps(full_page))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("skipped; from=v0.1.0 to=- reason=running_release_not_listed", self.status())
        self.assertEqual(result.stdout, self.status())
        self.assertEqual(self.calls().count("/releases?per_page=100"), 10)
        self.assertIn("&page=10", self.calls())
        self.assertNotIn("release-manifest", self.calls())
        self.assertNotIn("kill --signal", self.calls())

    def test_full_pages_with_running_version_on_page_3_proceeds_at_safety_cap(self):
        draft_page = [{"tag_name": f"v0.0.{index}", "draft": True} for index in range(100)]
        first = [{"tag_name": "v0.2.0", "prerelease": True}] + draft_page[:99]
        third = [{"tag_name": "v0.1.0", "prerelease": True}] + draft_page[:99]
        self.tags(first)
        for page in range(2, 11):
            entries = third if page == 3 else draft_page
            (self.release / f"releases-page{page}.json").write_text(json.dumps(entries))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("updated; from=v0.1.0 to=v0.2.0", self.status())
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.2.0@{DIGEST}", (self.root / ".env").read_text())
        self.assertEqual(self.calls().count("/releases?per_page=100"), 10)
        self.assertIn("&page=10", self.calls())

    def test_pagination_continues_past_an_older_published_tag(self):
        self.chain()
        first = [{"tag_name": "v0.3.0", "prerelease": True}, {"tag_name": "v0.0.5", "draft": False}]
        first += [{"tag_name": f"v0.0.{index}", "draft": True} for index in range(6, 104)]
        self.tags(first)
        second = [{"tag_name": tag, "prerelease": True} for tag in ("v0.2.0", "v0.1.0")]
        (self.release / "releases-page2.json").write_text(json.dumps(second))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(result.stdout.index("to=v0.2.0"), result.stdout.index("to=v0.3.0"))
        self.assertIn("&page=2", self.calls())

    def test_stable_pagination_finds_eligible_release_after_full_prerelease_page(self):
        (self.root / ".env").write_text(self.initial + "DEMO_RELEASE_CHANNEL=stable\n")
        self.publish("v0.2.0", floor="v0.1.0")
        (self.release / "releases-page2.json").write_text(json.dumps([{"tag_name": "v0.2.0", "prerelease": False}]))
        self.tags([{"tag_name": f"v0.{index}.0", "prerelease": True} for index in range(3, 103)])
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.2.0@{DIGEST}", (self.root / ".env").read_text())
        self.assertIn("updated; from=v0.1.0 to=v0.2.0", self.status())
        self.assertIn("&page=2", self.calls())

    def test_stable_pagination_continues_past_full_page_with_eligible_release(self):
        (self.root / ".env").write_text(self.initial + "DEMO_RELEASE_CHANNEL=stable\n")
        self.publish("v0.1.1", floor="v0.1.0")
        self.keep_release()
        self.publish("v0.2.0", floor="v0.1.0")
        self.keep_release()
        first = [{"tag_name": "v0.1.1", "prerelease": False}] + [
            {"tag_name": f"v0.{index}.0", "prerelease": True} for index in range(3, 102)
        ]
        self.tags(first)
        (self.release / "releases-page2.json").write_text(json.dumps([
            {"tag_name": "v0.2.0", "prerelease": False},
            {"tag_name": "v0.1.0", "prerelease": False},
        ]))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("updated; from=v0.1.0 to=v0.2.0", self.status())
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.2.0@{DIGEST}", (self.root / ".env").read_text())
        self.assertEqual(self.calls().count("/releases?per_page=100"), 2)
        self.assertEqual(self.calls().count("kill --signal SIGTERM"), 1)

    def test_stable_pagination_continues_past_full_page_with_running_release_and_no_eligible(self):
        (self.root / ".env").write_text(self.initial + "DEMO_RELEASE_CHANNEL=stable\n")
        first = [{"tag_name": "v0.1.0", "prerelease": False}] + [
            {"tag_name": f"v0.2.{index}", "prerelease": True} for index in range(99)
        ]
        self.tags(first)
        (self.release / "releases-page2.json").write_text(json.dumps([
            {"tag_name": "v0.0.9", "prerelease": False},
            {"tag_name": "v0.3.0", "draft": True},
        ]))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("up_to_date; from=v0.1.0 to=- reason=-", self.status())
        self.assertEqual(self.calls().count("/releases?per_page=100"), 2)
        self.assertNotIn("release-manifest", self.calls())

    def test_stable_full_pages_with_running_release_on_page_3_apply_newest_stable_at_safety_cap(self):
        (self.root / ".env").write_text(self.initial + "DEMO_RELEASE_CHANNEL=stable\n")
        self.publish("v0.2.0", floor="v0.1.0")
        filler = [{"tag_name": f"v0.9.{index}", "prerelease": True} for index in range(100)]
        # Tags outside the vX.Y.Z grammar are never chosen, even when they read as newer.
        first = [{"tag_name": tag, "prerelease": False}
                 for tag in ("v0.03.0", "v0.1000000.0", "v0.4.0-rc.1", "v0.1.1", "v0.2.0")] + filler[:95]
        third = [{"tag_name": "v0.1.0", "prerelease": False}] + filler[:99]
        self.tags(first)
        for page in range(2, 11):
            (self.release / f"releases-page{page}.json").write_text(json.dumps(third if page == 3 else filler))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("updated; from=v0.1.0 to=v0.2.0", self.status())
        self.assertIn(f"APP_IMAGE={IMAGE}:v0.2.0@{DIGEST}", (self.root / ".env").read_text())
        self.assertEqual(self.calls().count("/releases?per_page=100"), 10)
        self.assertEqual(self.calls().count("kill --signal SIGTERM"), 1)

    def test_stable_full_pages_without_running_release_skip_at_safety_cap(self):
        (self.root / ".env").write_text(self.initial + "DEMO_RELEASE_CHANNEL=stable\n")
        filler = [{"tag_name": f"v0.9.{index}", "prerelease": True} for index in range(100)]
        self.tags([{"tag_name": "v0.2.0", "prerelease": False}] + filler[:99])
        for page in range(2, 11):
            (self.release / f"releases-page{page}.json").write_text(json.dumps(filler))
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("skipped; from=v0.1.0 to=- reason=running_release_not_listed", self.status())
        self.assertEqual(self.calls().count("/releases?per_page=100"), 10)
        self.assertNotIn("release-manifest", self.calls())

    def test_stable_pagination_stops_on_short_page_without_eligible_release(self):
        (self.root / ".env").write_text(self.initial + "DEMO_RELEASE_CHANNEL=stable\n")
        self.tags([{"tag_name": "v0.2.0", "prerelease": True}, {"tag_name": "v0.3.0", "draft": True},
                   "v0.0.5", "v1.1.0", "v0.4.0-rc.1"])
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("up_to_date; from=v0.1.0 to=- reason=-", self.status())
        self.assertEqual(self.calls().count("/releases?per_page=100"), 1)


class NightlyTests(UpdateFixture):
    """Nightly vX.Y.0-nightly.N prereleases sort above every vX.(Y-1).* release and below vX.Y.0."""

    def setUp(self):
        super().setUp()
        self.original = self.initial

    def running(self, tag, channel="prerelease"):
        self.initial = self.original.replace("v1.2.3", tag).replace("DEMO_RELEASE_CHANNEL=stable\n", f"DEMO_RELEASE_CHANNEL={channel}\n")
        (self.root / ".env").write_text(self.initial)

    def release(self, tag, prerelease=False, floor="v1.0.0"):
        self.publish(tag, prerelease=prerelease, floor=floor)
        self.keep_release()

    def updated(self, result):
        return [line.split(" to=")[1].split()[0] for line in result.stdout.splitlines()
                if line.startswith("Demo release update: updated;")]

    def patch_and_nightlies(self):
        self.release("v1.1.1")
        self.release("v1.2.0-nightly.1", prerelease=True, floor="v1.1.0")
        self.release("v1.2.0-nightly.2", prerelease=True, floor="v1.2.0-nightly.1")
        self.tags([{"tag_name": "v1.2.0-nightly.2", "prerelease": True}, {"tag_name": "v1.2.0-nightly.1", "prerelease": True},
                   "v1.1.1", "v1.1.0", {"tag_name": "v0.9.0", "prerelease": True}])

    def test_prerelease_channel_takes_the_patch_then_each_nightly_in_order(self):
        self.running("v1.1.0")
        self.patch_and_nightlies()
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.updated(result), ["v1.1.1", "v1.2.0-nightly.1", "v1.2.0-nightly.2"])
        self.assertIn("updated; from=v1.2.0-nightly.1 to=v1.2.0-nightly.2", self.status())
        self.assertIn(f"APP_IMAGE={IMAGE}:v1.2.0-nightly.2@{DIGEST}", (self.root / ".env").read_text())
        # Nothing newer: up to date on the nightly, never back to v1.1.1 or a v0.* prerelease.
        again = self.run_update()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("up_to_date; from=v1.2.0-nightly.2", self.status())

    def test_stable_channel_takes_only_the_newest_release(self):
        self.running("v1.1.0", channel="stable")
        self.patch_and_nightlies()
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.updated(result), ["v1.1.1"])
        self.assertIn(f"APP_IMAGE={IMAGE}:v1.1.1@{DIGEST}", (self.root / ".env").read_text())

    def test_a_nightly_waits_for_its_minor_and_never_takes_an_older_release(self):
        self.running("v1.2.0-nightly.2")
        self.release("v1.1.2", floor="v1.1.0")
        self.tags(["v1.1.2", {"tag_name": "v1.2.0-nightly.2", "prerelease": True}, "v1.1.0"])
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("up_to_date; from=v1.2.0-nightly.2 to=- reason=-", self.status())
        self.assertNotIn("version_unknown", self.status())
        self.release("v1.2.0", floor="v1.1.0")
        self.tags(["v1.2.0", "v1.1.2", {"tag_name": "v1.2.0-nightly.2", "prerelease": True}])
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.updated(result), ["v1.2.0"])
        self.assertIn("updated; from=v1.2.0-nightly.2 to=v1.2.0", self.status())

    def test_another_major_and_an_unmarked_nightly_are_skipped(self):
        self.running("v1.2.0-nightly.2")
        self.release("v1.2.0-nightly.3", floor="v1.1.0")
        self.tags([{"tag_name": "v2.0.0-nightly.1", "prerelease": True}, {"tag_name": "v1.2.0-nightly.3", "prerelease": False},
                   {"tag_name": "v1.2.0-nightly.2", "prerelease": True}, {"tag_name": "v1.2.0-nightly.01", "prerelease": True},
                   {"tag_name": "v1.2.1-nightly.1", "prerelease": True}, {"tag_name": "v1.3.0-rc.1", "prerelease": True}])
        for channel in ("prerelease", "stable"):
            with self.subTest(channel=channel):
                self.running("v1.2.0-nightly.2", channel=channel)
                (self.root / "auto-update.state").unlink(missing_ok=True)
                result = self.run_update()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("up_to_date; from=v1.2.0-nightly.2 to=- reason=-", self.status())
        self.assertNotIn("release-manifest", self.calls())

    def test_explicit_nightly_update_verifies_with_the_prerelease_key(self):
        self.running("v1.1.0", channel="stable")
        self.release("v1.2.0-nightly.1", prerelease=True, floor="v1.1.0")
        self.tags([{"tag_name": "v1.2.0-nightly.1", "prerelease": True}])
        result = self.run_update(f"{IMAGE}:v1.2.0-nightly.1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"APP_IMAGE={IMAGE}:v1.2.0-nightly.1@{DIGEST}", (self.root / ".env").read_text())
        self.assertIn("/releases/download/v1.2.0-nightly.1/release-manifest.txt", self.calls())
