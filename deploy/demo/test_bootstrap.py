#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Exercise the pasted HTTPS download command with an isolated deployment bundle."""
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from test_support import https_directory


@unittest.skipUnless(os.name == "posix", "The bootstrap uses POSIX sh, sudo/root checks and Unix file permissions; run in Linux/WSL.")
@unittest.skipUnless(getattr(os, "geteuid", lambda: -1)() == 0, "The bootstrap requires root; run these tests with sudo in Linux/WSL.")
class BootstrapTests(unittest.TestCase):
    def test_https_download_checksum_safe_extraction_and_argument_forwarding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "bundle.tar"
            # Only this fixture is executed. It never invokes Docker or modifies a host.
            payload = b'#!/bin/sh\nprintf "%s\\n" "$@" > "$BOOTSTRAP_RESULT"\n'
            with tarfile.open(bundle, "w") as archive:
                member = tarfile.TarInfo("deploy/demo/install.sh")
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))

            with https_directory(root) as (base, env):
                result_path = root / "result"
                env["BOOTSTRAP_RESULT"] = str(result_path)
                url = base + "/bundle.tar"
                checksum = hashlib.sha256(bundle.read_bytes()).hexdigest()
                command = ["sh", str(Path(__file__).with_name("bootstrap.sh")), "--bundle-url", url,
                           "--sha256", checksum, "--directory", str(root / "install"), "--", "--local-test"]
                completed = subprocess.run(command, env=env, capture_output=True, text=True)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(result_path.read_text().splitlines(), ["--directory", str(root / "install"), "--local-test"])
                # A wrong checksum never reaches the fixture installer.
                result_path.write_text("unchanged")
                command[command.index(checksum)] = "0" * 64
                completed = subprocess.run(command, env=env, capture_output=True, text=True)
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(result_path.read_text(), "unchanged")
                # Even a correctly checksummed archive cannot escape its extraction root.
                with tarfile.open(bundle, "w") as archive:
                    member = tarfile.TarInfo("../escape")
                    member.size = 1
                    archive.addfile(member, io.BytesIO(b"x"))
                command[command.index("0" * 64)] = hashlib.sha256(bundle.read_bytes()).hexdigest()
                completed = subprocess.run(command, env=env, capture_output=True, text=True)
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(result_path.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
