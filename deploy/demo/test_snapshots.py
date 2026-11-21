#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
import os
from pathlib import Path
import tempfile
import unittest

from snapshots import prune


class SnapshotTests(unittest.TestCase):
    def test_keeps_newest_three_by_default_policy_and_custom_count(self):
        for keep in (3, 2):
            with self.subTest(keep=keep), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                for index in range(6):
                    path = directory / f"pre-update-{index}.dump"
                    path.write_bytes(b"PGDMP")
                    os.utime(path, (index + 1, index + 1))
                prune(directory, keep)
                self.assertEqual(sorted(path.name for path in directory.iterdir()),
                                 [f"pre-update-{index}.dump" for index in range(6 - keep, 6)])

    def test_protects_oldest_snapshot_in_addition_to_newest(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            snapshots = [directory / f"pre-update-{index}.dump" for index in range(4)]
            for index, path in enumerate(snapshots, start=1):
                path.write_bytes(b"PGDMP")
                os.utime(path, (index, index))
            prune(directory, 2, protect=directory / ".." / directory.name / snapshots[0].name)
            self.assertEqual(set(directory.iterdir()), {snapshots[0], *snapshots[-2:]})
            prune(directory, 2, protect=directory / "pre-update-missing.dump")
            self.assertEqual(set(directory.iterdir()), set(snapshots[-2:]))

    def test_invalid_count_never_deletes_and_other_files_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "pre-update-old.dump.enc").write_bytes(b"old encrypted format")
            (directory / "pre-update-new.dump").write_bytes(b"PGDMP")
            os.utime(directory / "pre-update-old.dump.enc", (1, 1))
            (directory / "unrelated.dump").write_bytes(b"preserve")
            for value in ("0", "-1", "1.5", "invalid"):
                with self.assertRaises(ValueError):
                    prune(directory, value)
            self.assertEqual(len(list(directory.iterdir())), 3)
            prune(directory, 1)
            self.assertEqual(sorted(path.name for path in directory.iterdir()), ["pre-update-new.dump", "unrelated.dump"])


if __name__ == "__main__":
    unittest.main()
