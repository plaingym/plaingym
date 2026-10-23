#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Refresh a live local install through the real checksummed HTTPS bootstrap."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

from config import read_env
from test_support import https_directory

source, installed = Path(__file__).parent, Path(sys.argv[1])
new_app, new_caddy = sys.argv[2:4]
original = read_env(installed / ".env")
with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    staged = directory / "staged"
    files = ["compose.yaml", "lib.sh", "install.sh", "postgres/01-roles.sh"]
    files += ["demo/" + file for file in ("install.sh", "config.py", "lib.sh", "update.sh", "snapshots.py",
                                         "host.sh", "compose.yaml", "Caddyfile", "Caddyfile.local.conf")]
    for file in files:
        target = staged / "deploy" / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source.parent / file, target)
    for file in ("update.sh", "compose.yaml"):
        path = staged / "deploy/demo" / file
        path.write_text(path.read_text() + "\n# Verified bundle refresh fixture.\n")
    caddy = staged / "deploy/demo/Caddyfile.local.conf"
    caddy.write_text(caddy.read_text().replace("    tls internal", "    header X-Demo-Deploy-Revision refreshed\n    tls internal"))
    metadata = staged / "deploy/demo/images.env"
    metadata.write_text(f"APP_IMAGE={new_app}\nCADDY_IMAGE={new_caddy}\n")
    archive_path = directory / "bundle.tar"

    def pack():
        with tarfile.open(archive_path, "w") as archive:
            for file in files + ["demo/images.env"]:
                archive.add(staged / "deploy" / file, arcname="deploy/" + file)
        return hashlib.sha256(archive_path.read_bytes()).hexdigest()

    with https_directory(directory) as (base, env):
        env.pop("APP_IMAGE", None)
        env.pop("CADDY_IMAGE", None)
        command = ["sh", str(source / "bootstrap.sh"), "--bundle-url", base + "/bundle.tar", "--sha256", pack(),
                   "--directory", str(installed), "--", "--local-test"]
        subprocess.run(command, env=env, check=True)
        refreshed = read_env(installed / ".env")
        assert refreshed == {**original, "CADDY_IMAGE": new_caddy}
        assert (installed / "update.sh").read_bytes() == (staged / "deploy/demo/update.sh").read_bytes()
        assert (installed / "demo.compose.yaml").read_bytes() == (staged / "deploy/demo/compose.yaml").read_bytes()
        assert (installed / "Caddyfile").read_bytes() == caddy.read_bytes()
        compose = ["docker", "compose", "--project-directory", str(installed), "--env-file", str(installed / ".env"),
                   "-f", str(installed / "compose.yaml"), "-f", str(installed / "demo.compose.yaml")]
        previous_proxy = subprocess.check_output([*compose, "ps", "-q", "caddy"], env=env)
        caddy.write_text(caddy.read_text().replace("Revision refreshed", "Revision reloaded"))
        command[command.index("--sha256") + 1] = pack()
        subprocess.run(command, env=env, check=True)
        assert subprocess.check_output([*compose, "ps", "-q", "caddy"], env=env) != previous_proxy
        assert read_env(installed / ".env") == refreshed
        # A bad deploy file must roll back its files and leave both pins intact.
        caddy.write_text("# SPDX-License-Identifier: AGPL-3.0-only\n{\n    invalid_global_option\n}\n")
        command[command.index("--sha256") + 1] = pack()
        completed = subprocess.run(command, env=env, capture_output=True, text=True)
        assert completed.returncode != 0
        assert read_env(installed / ".env") == refreshed
        assert "X-Demo-Deploy-Revision reloaded" in (installed / "Caddyfile").read_text()
print("PASS: verified bundle refreshes scripts, Compose, Caddyfile and proxy pin; preserves app pin/secrets; invalid refresh rolls back.")
