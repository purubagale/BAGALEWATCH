#!/usr/bin/env python3
"""
BAGALEWATCH BTS v2 — safe, read-only snapshot of the v1 SQLite database.

This is the ONLY tool in this repo that is allowed to reference the v1
system's bagalewatch.db, and it never opens that file directly — it makes
a byte-for-byte copy first (shutil.copy2, a plain filesystem read of the
source), then does everything else (including opening it in SQLite) against
the COPY. The source file is never opened for writing, never locked, and
the running v1 server is never touched or interrupted.

Phase 0 scope: copy + inspect only (prints table names and row counts, so
the actual data volume is known before Phase 1's Django models are
designed against it). Phase 1 will add a real per-table import command
(`manage.py import_legacy_data <copy_path>`) once those models exist —
writing that importer before the models it targets exist would just be
dead code.

Usage:
    python3 copy_and_inspect_legacy_db.py /path/to/bagalewatch.db
"""
import os
import shutil
import sqlite3
import sys
import tempfile


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} /path/to/bagalewatch.db")
        sys.exit(1)

    source_path = sys.argv[1]
    if not os.path.isfile(source_path):
        print(f"ERROR: {source_path} does not exist or is not a file.")
        sys.exit(1)

    # Copy first. shutil.copy2 opens the source read-only — this process
    # never opens bagalewatch.db in write mode, and never runs any SQL
    # against the live file.
    tmp_dir = tempfile.mkdtemp(prefix="bagalewatch_v2_seed_")
    copy_path = os.path.join(tmp_dir, "bagalewatch_snapshot.db")
    print(f"Copying (read-only) {source_path}\n            -> {copy_path}")
    shutil.copy2(source_path, copy_path)
    print(f"Copy complete: {os.path.getsize(copy_path):,} bytes.")

    # Everything from here on operates ONLY on the copy, opened read-only
    # via SQLite's own uri=true immutable mode as a second layer of
    # protection (belt-and-suspenders on top of "it's a copy, not the
    # original").
    conn = sqlite3.connect(f"file:{copy_path}?mode=ro&immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        print(f"\nFound {len(tables)} table(s) in the snapshot:\n")
        print(f"{'table':<24} {'rows':>10}")
        print("-" * 36)
        for t in tables:
            count = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            print(f"{t:<24} {count:>10,}")
    finally:
        conn.close()

    print(f"\nSnapshot kept at: {copy_path}")
    print("(This directory is temporary — copy it somewhere durable if you")
    print(" need it for Phase 1's import command, or re-run this script.)")


if __name__ == "__main__":
    main()
