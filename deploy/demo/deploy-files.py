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


def mode(name):
    return 0o700 if name in ("update.sh", "auto-update.sh", "deploy-files.py", "snapshots.py") else 0o644


def units(root, directory, source=None):
    directory.mkdir(parents=True, exist_ok=True)
    for name in UNITS:
        text = ((source or root) / "systemd" / name).read_text()
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


JOURNAL_BRIDGE = '''set -eu
ROOT=$1
. "$2"
HOST_JOURNAL_HELPER=$2
HOST_JOURNAL_PREFIX=.demo-deploy
command=$3; files=$4; units=$5; source=$6; target=$7
host_install_units() { python3 "$ROOT/deploy-files.py" units "$ROOT" "$1"; }
case "$command" in
  recover) host_recover "$files" "$units" ;;
  apply) host_apply "$source" "$target" '' "$files" "$units" ;;
esac
'''


def journal_command(command, root, directory, source="", target=""):
    helper = root / ".demo-deploy-update/helper.sh"
    if not helper.is_file():
        helper = root / "base-lib.sh"
    # Source-tree unit fixtures do not have an installed base-lib.sh.
    if not helper.is_file():
        helper = Path(__file__).resolve().parent.parent / "lib.sh"
    directory.mkdir(parents=True, exist_ok=True)
    subprocess.run(["sh", "-c", JOURNAL_BRIDGE, "demo-journal", str(root), str(helper), command,
                    " ".join(mapping(False).values()), " ".join(UNITS), str(source), target],
                   env={**os.environ, "SYSTEMD_UNIT_DIR": str(directory)}, check=True)


def recover(root, directory):
    # Migrate the older demo snapshot layout once; each rename is repeatable after interruption.
    retired = root / ".demo-deploy-retired"
    if retired.exists():
        shutil.rmtree(retired)
    journal = root / ".demo-deploy-update"
    if journal.exists():
        if not (journal / "target").is_file() or not any(
                (journal / name).is_dir() for name in ("files", "before/files")):
            raise RuntimeError("Incomplete demo deploy journal: " + str(journal))
        (journal / "before").mkdir(exist_ok=True)
        for name in ("files", "units"):
            if (journal / name).exists():
                os.replace(journal / name, journal / "before" / name)
    journal_command("recover", root, directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "apply", "recover", "units", "changed"))
    parser.add_argument("root", type=Path)
    parser.add_argument("value", nargs="?")
    parser.add_argument("target", nargs="?")
    parser.add_argument("--local", action="store_true")
    args = parser.parse_args()
    directory = Path(os.environ.get("SYSTEMD_UNIT_DIR", "/etc/systemd/system"))
    if args.command == "prepare":
        prepare(args.root, Path(args.value), args.local)
    elif args.command == "recover":
        recover(args.root, directory)
    elif args.command == "units":
        units(args.root, directory, Path(args.value) if args.value else None)
    elif args.command == "changed":
        print("yes" if any(not (args.root / name).is_file() or
                           (args.root / name).read_bytes() != (Path(args.value) / name).read_bytes()
                           for name in mapping(False).values()) else "no")
    else:
        if not args.target:
            parser.error("apply requires the target image pin")
        journal_command("apply", args.root, directory, args.value, args.target)


if __name__ == "__main__":
    main()
