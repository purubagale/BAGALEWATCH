"""
NOT CURRENTLY USED by seed_legacy_data.py (as of 2026-07-27).

This script extracts v1's _SITE_REGION_MAP, which maps site_id -> one of
the 7 modern federal provinces. That turned out to be the wrong target
for the sidebar tree bug: the tree actually groups sites by NTC's 5
traditional development regions (Central/Eastern/Western/Mid-West/
Far-West), derived deterministically from the site ID prefix
(CDR/EDR/WDR/MWDR/FWDR, with KTM folding into Central) -- see
`_region_from_site_id()` in seed_legacy_data.py, which is what the seed
script actually uses now. Confirmed directly by the user after this
script's output was reviewed and rejected as the wrong scheme.

Left in place in case a future feature (not the tree) genuinely needs the
site_id -> current-province mapping _SITE_REGION_MAP provides.

Original docstring follows:
---
One-time extraction of v1's _SITE_REGION_MAP (bts_monitor.html) into a JSON
lookup file. NOT wired into seed_legacy_data.py anymore -- see note above.

Why this exists: v1's sites.region DB column still holds legacy region
names (Central/Eastern/Western/Mid-West/Far-West) for a large fraction of
rows. The correction to current province names has only ever been applied
client-side, in bts_monitor.html's fixSiteRegions(), which rewrites the
in-memory copy of SITES[] on every page load but never writes back to
bagalewatch.db. The v2 seed script copies sites.region as-is, so without
this correction v2 inherits the same stale values — reported 2026-07-27:
v2's sidebar tree grouped hundreds of sites under "Central" / "Mid-West >
Western" instead of their real current province.

_SITE_REGION_MAP is embedded in bts_monitor.html as a single ~145KB line
(`_SITE_REGION_MAP=new Map([["CDR001","Province 2 (Madhesh)"],...])`) —
too large to hand-copy reliably, so this script regex-extracts it directly
from the source file instead.

Usage (run locally, on the machine where bts_monitor.html actually lives):
  python extract_site_region_map.py "C:\\path\\to\\bts_monitor.html"

Writes site_region_map.json next to seed_legacy_data.py. After running
this once, re-run the seed command with --wipe to apply the correction:
  python manage.py seed_legacy_data <path to bagalewatch.db> --wipe
"""
import json
import re
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print('Usage: python extract_site_region_map.py <path to bts_monitor.html>')
        sys.exit(1)

    html_path = Path(sys.argv[1])
    if not html_path.is_file():
        print(f'Not found: {html_path}')
        sys.exit(1)

    text = html_path.read_text(encoding='utf-8', errors='replace')

    marker = '_SITE_REGION_MAP=new Map(['
    start = text.find(marker)
    if start == -1:
        print('Could not find "_SITE_REGION_MAP=new Map([" in the file -- '
              'has the variable been renamed or reformatted?')
        sys.exit(1)

    # Bracket-depth scan from the array literal's opening "[" to find its
    # matching closing "]" (skipping regex/string tricks entirely -- this
    # is robust as long as province name strings don't contain literal
    # "[" or "]", which they don't).
    array_start = start + len(marker) - 1  # index of the opening "["
    depth = 0
    end = None
    i = array_start
    while i < len(text):
        c = text[i]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                end = i
                break
        i += 1
    if end is None:
        print('Found the marker but could not find the matching closing bracket -- '
              'the file may have changed shape since this script was written.')
        sys.exit(1)

    array_text = text[array_start:end + 1]

    pairs = re.findall(r'\["([^"]+)","([^"]+)"\]', array_text)
    if not pairs:
        print('Found the map but extracted zero entries -- the regex may not '
              'match the actual format anymore.')
        sys.exit(1)

    mapping = {site_id: province for site_id, province in pairs}

    out_path = (
        Path(__file__).parent.parent
        / 'backend-django' / 'core' / 'management' / 'commands' / 'site_region_map.json'
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(mapping, ensure_ascii=False), encoding='utf-8')

    provinces = sorted(set(mapping.values()))
    print(f'Extracted {len(mapping)} site_id -> province entries.')
    print(f'Distinct province values found ({len(provinces)}):')
    for p in provinces:
        count = sum(1 for v in mapping.values() if v == p)
        print(f'  - {p}: {count}')
    print(f'\nWrote: {out_path}')
    print('\nNext step: re-run the seed command with --wipe to apply the correction.')


if __name__ == '__main__':
    main()
