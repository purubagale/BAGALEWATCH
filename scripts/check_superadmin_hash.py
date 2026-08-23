#!/usr/bin/env python3
"""
One-off diagnostic: read-only check of what's actually stored for the
superadmin user in bagalewatch.db, to isolate why a v2 login is failing
(wrong password, unexpected hash format, or a real bug in the v2 hasher).

Same copy-first, read-only pattern as scripts/copy_and_inspect_legacy_db.py
and core/management/commands/seed_legacy_data.py — never opens the live
file directly.

Usage:
    python check_superadmin_hash.py /path/to/bagalewatch.db
"""
import os
import shutil
import sqlite3
import sys
import tempfile


def main():
    if len(sys.argv) != 2:
        print(f'Usage: {sys.argv[0]} /path/to/bagalewatch.db')
        sys.exit(1)

    source_path = sys.argv[1]
    tmp_dir = tempfile.mkdtemp(prefix='dtwatch_check_')
    copy_path = os.path.join(tmp_dir, 'snapshot.db')
    shutil.copy2(source_path, copy_path)

    conn = sqlite3.connect(f'file:{copy_path}?mode=ro&immutable=1', uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT id, username, role, password_hash, updated_at FROM users ORDER BY id").fetchall()
        print(f'{len(rows)} user(s) in this snapshot:\n')
        for r in rows:
            ph = r['password_hash'] or ''
            prefix = ph.split('$')[0].split(':')[0] if ph else '(empty)'
            print(f"id={r['id']:<3} username={r['username']:<15} role={r['role']:<12} "
                  f"hash_format={prefix:<15} hash_length={len(ph)} updated_at={r['updated_at']}")
    finally:
        conn.close()
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
