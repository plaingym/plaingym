#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Retention for root-only local pre-update snapshots, after a healthy update."""
import argparse
from pathlib import Path
import re


def retention(value):
    if not re.fullmatch(r"[1-9][0-9]*", str(value)):
        raise ValueError("Snapshot retention must be a positive integer.")
    return int(value)


def prune(directory, keep):
    keep = retention(keep)
    directory = Path(directory)
    # Include the previous installer's encrypted snapshots in the same quota.
    snapshots = [path for path in directory.iterdir()
                 if path.name.startswith("pre-update-") and path.name.endswith((".dump", ".dump.enc"))
                 and not path.is_symlink() and path.is_file()]
    snapshots.sort(key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True)
    for path in snapshots[keep:]:
        path.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--keep", required=True)
    args = parser.parse_args()
    prune(args.directory, args.keep)
