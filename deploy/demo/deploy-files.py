#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Fixed deployment allowlist and recoverable host-file refresh. Never unpack arbitrary paths."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


FILES = {
    "compose.yaml": "compose.yaml", "lib.sh": "base-lib.sh", "postgres/01-roles.sh": "postgres/01-roles.sh",
    **{"demo/" + name: name for name in (
        "lib.sh", "update.sh", "auto-update.sh", "deploy-files.py", "snapshots.py",
        "systemd/plaingym-demo-update.service", "systemd/plaingym-demo-update.timer")},
    "demo/compose.yaml": "demo.compose.yaml", "demo/Dockerfile": "caddy.Dockerfile",
}
UNITS = ("plaingym-demo-update.service", "plaingym-demo-update.timer")


def mapping(local):
    return {**FILES, "demo/Caddyfile.local.conf" if local else "demo/Caddyfile": "Caddyfile"}


def replace(source, target, mode=0o644):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".demo-next")
    shutil.copyfile(source, temporary)
    temporary.chmod(mode)
    os.replace(temporary, target)


def mode(name):
    return 0o700 if name in ("update.sh", "auto-update.sh", "deploy-files.py", "snapshots.py") else 0o644


def units(root, directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name in UNITS:
        text = (root / "systemd" / name).read_text()
        # systemd's specifier expansion also applies inside quoted arguments.
        text = text.replace("@ROOT@", str(root).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%"))
        temporary = directory / (name + ".demo-next")
        temporary.write_text(text)
        temporary.chmod(0o644)
        os.replace(temporary, directory / name)
    subprocess.run(["systemctl", "daemon-reload"], check=True)


def prepare(archive, destination, local):
    destination.mkdir(mode=0o700)
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        for source, target in mapping(local).items():
            matches = [member for member in members if member.name == "deploy/" + source]
            if len(matches) != 1 or not matches[0].isfile() or matches[0].size > 1024 * 1024:
                raise ValueError("Missing, repeated or unsafe demo deploy file: " + source)
            path = destination / target
            path.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(matches[0]) as content:
                path.write_bytes(content.read())
            path.chmod(mode(target))


def recover(root, directory):
    # A retired journal is never authoritative: its rename completed after the files were persisted.
    retired = root / ".demo-deploy-retired"
    if retired.exists():
        shutil.rmtree(retired)
    journal = root / ".demo-deploy-update"
    if not journal.exists():
        return
    if not (journal / "target").is_file() or not (journal / "files").is_dir():
        raise RuntimeError("Incomplete demo deploy journal: " + str(journal))
    target = (journal / "target").read_text()
    pin = next((line[10:] for line in reversed((root / ".env").read_text().splitlines())
                if line.startswith("APP_IMAGE=")), "")
    if pin != target:
        for base, names, saved in ((root, list(mapping(False).values()), journal / "files"),
                                   (directory, UNITS, journal / "units")):
            for name in names:
                before = saved / name
                if before.exists():
                    replace(before, base / name, before.stat().st_mode & 0o777)
                else:
                    (base / name).unlink(missing_ok=True)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
    # Persist the pin (or restoration) and retire the journal by rename before deleting it, so a kill
    # during deletion never leaves a half-deleted journal for the next run to mistake for a complete one.
    os.sync()
    os.rename(journal, retired)
    os.sync()
    shutil.rmtree(retired)


def capture(root, directory, target):
    journal = root / ".demo-deploy-next"
    if journal.exists():
        shutil.rmtree(journal)
    journal.mkdir(mode=0o700)
    (journal / "files").mkdir()
    for base, names, saved in ((root, list(mapping(False).values()), journal / "files"),
                               (directory, UNITS, journal / "units")):
        for name in names:
            before = base / name
            if before.exists():
                path = saved / name
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(before, path)
    (journal / "target").write_text(target)
    os.rename(journal, root / ".demo-deploy-update")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "capture", "apply", "recover", "units", "changed"))
    parser.add_argument("root", type=Path)
    parser.add_argument("value", nargs="?")
    parser.add_argument("--local", action="store_true")
    args = parser.parse_args()
    directory = Path(os.environ.get("SYSTEMD_UNIT_DIR", "/etc/systemd/system"))
    if args.command == "prepare":
        prepare(args.root, Path(args.value), args.local)
    elif args.command == "capture":
        capture(args.root, directory, args.value)
    elif args.command == "recover":
        recover(args.root, directory)
    elif args.command == "units":
        units(args.root, directory)
    elif args.command == "changed":
        print("yes" if any(not (args.root / name).is_file() or
                           (args.root / name).read_bytes() != (Path(args.value) / name).read_bytes()
                           for name in mapping(False).values()) else "no")
    else:
        for name in mapping(False).values():
            replace(Path(args.value) / name, args.root / name, mode(name))
        units(args.root, directory)


if __name__ == "__main__":
    main()
