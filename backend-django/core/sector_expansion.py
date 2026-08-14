"""
Sector-expansion classification (2026-08-09 request: "my major concern is
to find expanded sector list... manage this. also add search parameter
with all sector expansion, sector expansion with same latlong and sector
expansion with different latlong").

The user gave the real Nepal Telecom naming convention this is built on
verbatim, confirmed via AskUserQuestion before writing any of this (never
guessed/fabricated — this is exactly the kind of "silently misclassify
real operational data" risk CLAUDE.md's "never fabricate site data" rule
exists for):

  Baseline (NOT expansion) sector letters, per tech:
    4G: J, K, L      2G: A, B, C      3G: P, Q, R
  Expansion sector letters, per tech:
    4G: M, N, O, P, Q   2G: G, H, I      3G: S, T

  The Sector field (e.g. "J3", "M20") is a LETTER + a trailing number
  (the same two numbers — 3/20 for 4G, 1/2 for 2G and 3G — appear on both
  the baseline and expansion side, confirmed with the user: the SUFFIX
  NUMBER never affects classification, only the LEADING LETTER does).

Three signals combine to flag one sector as "expansion" — confirmed via
AskUserQuestion that ANY ONE of them is sufficient, not all three:
  1. Its Sector field's leading letter is in that tech's expansion list.
  2. Its Cell Name contains the word "expansion" (case-insensitive).
  3. Its own GPS override is a genuinely different location than its
     site's (see Sector.lat/lng's docstring in models.py) — the same
     ~11m epsilon used everywhere else in this app for that judgment.

Per the user's own framing ("if same site location is matched then they
are not sector expansion, usually EXCEPT that [[the letter/cell-name
list]]") — signal 1/2 (letter, cell name) can flag a sector as expansion
even when its GPS still matches the site (hasn't been re-surveyed to a
distinct point yet).

**2026-08-09 fix** ("it is showing J,K,L also as sector expanded site
which is not correct"): signal 3 (GPS) is NO LONGER a fully independent
OR — it's now suppressed for any sector whose letter is a CONFIRMED
baseline letter for its tech (J/K/L, A/B/C, P/Q/R). Real Sector Data
uploads showed baseline-letter sectors getting flagged purely because
their imported GPS reading differed from the site's own stored
coordinate by more than the ~11m epsilon — ordinary survey/rounding
noise between two separately-recorded coordinates, not evidence of a
real second cabinet. GPS divergence alone still flags a sector with NO
letter-based classification either way (not a recognized baseline OR
expansion letter) — that's the "a real-world site might not follow the
letter convention perfectly" case signal 3 exists for. See
`sector_expansion_signals()` for the exact rule.
"""
import re

# tech string -> the set of leading Sector-field letters that mean
# "this is an expansion sector" for that tech. Sector.tech is free text
# (not a DB enum — see models.py), so lookups here are by uppercased
# value with '4G' as the fallback, same convention this app already uses
# everywhere else a sector's tech needs a default (e.g. techBadgeClass()/
# sectorIdLabel() in SiteDetailPage.tsx).
EXPANSION_LETTERS = {
    '4G': set('MNOPQ'),
    '2G': set('GHI'),
    '3G': set('ST'),
}

# The complementary baseline sets. Originally kept only as documented
# reference and NOT read by the classification logic below — as of the
# 2026-08-09 fix (see sector_expansion_signals()'s docstring: "it is
# showing J,K,L also as sector expanded site which is not correct") this
# IS actively read, to suppress a lone GPS-divergence signal for any
# sector whose letter is a confirmed baseline one. A letter outside BOTH
# this set and EXPANSION_LETTERS is still just "not classified by the
# letter signal" — GPS divergence remains free to flag it on its own.
BASELINE_LETTERS = {
    '4G': set('JKL'),
    '2G': set('ABC'),
    '3G': set('PQR'),
}

# Mirrors frontend/src/lib/sectorLocation.ts's SAME_LOCATION_EPSILON_DEG
# and site_import.py's _SAME_LOCATION_EPSILON_DEG exactly (~11m at
# Nepal's latitude) — one more place "is this sector's coordinate
# actually different from its site" needs judging the same way.
SAME_LOCATION_EPSILON_DEG = 0.0001

_LEADING_LETTERS_RE = re.compile(r'^([A-Za-z]+)')


def sector_letter(sector_field: str) -> str:
    """The leading alphabetic run of a Sector field value, uppercased —
    "J3" -> "J", "m20" -> "M", "" or a value with no leading letters (a
    malformed/unexpected sector label) -> "" (matches nothing below,
    never raises)."""
    m = _LEADING_LETTERS_RE.match(sector_field or '')
    return m.group(1).upper() if m else ''


def sector_gps_diverges(sector, site) -> bool:
    """True only if the sector has its OWN override AND it's a genuine,
    non-trivial distance from the site's own location — mirrors
    site_import.py's _sector_location_override() (same epsilon), just
    returning a bool instead of the coordinate itself."""
    if sector.lat is None or sector.lng is None or site.lat is None or site.lng is None:
        return False
    return (
        abs(sector.lat - site.lat) >= SAME_LOCATION_EPSILON_DEG
        or abs(sector.lng - site.lng) >= SAME_LOCATION_EPSILON_DEG
    )


def sector_expansion_signals(sector, site) -> tuple[bool, bool]:
    """Returns (is_expansion, gps_diverges) for one sector against its
    parent site. `gps_diverges` is signal 3 alone, returned separately so
    callers (the search filter below) can distinguish "flagged as
    expansion but still at the site's coordinates" from "flagged as
    expansion AND its coordinates prove it".

    2026-08-09 fix ("it is showing J,K,L also as sector expanded site
    which is not correct"): `is_expansion` used to be a flat OR of all
    three signals, so a J/K/L (etc. — a CONFIRMED baseline letter for its
    tech) sector could still get flagged purely because its imported GPS
    reading was a bit off from the site's own stored coordinate. In real
    Sector Data uploads that's common even for sectors that never moved —
    the site's registered coordinate and a sector row's own Lat/Long
    column often come from different surveys/roundings, so small (>11m)
    drift shows up on ordinary baseline sectors too, not just genuine
    expansion cabinets. A known baseline letter is the user's own
    authoritative domain convention (confirmed verbatim, not guessed) —
    it now wins outright: GPS divergence alone can only flag a sector
    whose letter ISN'T a confirmed baseline letter (an unconventional or
    unlabeled sector, where a real second GPS reading is still the best
    evidence available). Cell Name containing "expansion" still overrides
    everything, same as before — that's an explicit human label, not
    inferred data."""
    tech = (sector.tech or '4G').strip().upper()
    letter = sector_letter(sector.sector)
    by_letter = letter in EXPANSION_LETTERS.get(tech, set())
    is_baseline_letter = letter in BASELINE_LETTERS.get(tech, set())
    by_cell_name = 'expansion' in (sector.cell_name or '').lower()
    gps_diverges = sector_gps_diverges(sector, site)
    gps_signal = gps_diverges and not is_baseline_letter
    return (by_letter or by_cell_name or gps_signal), gps_diverges


def sector_matches_mode(sector, site, mode: str) -> bool:
    """One sector's own pass/fail against a `sector_expansion` mode — see
    `site_matches_sector_expansion`'s docstring for what each mode means.
    Split out (2026-08-09 follow-up: "it is giving summary result with
    sitename, need sector wise result with cell name") so the search view
    can build one result ROW PER MATCHING SECTOR, not just decide
    yes/no per site — a site with three expansion sectors should show
    three rows, each with its own Cell Name, not one summary row."""
    is_expansion, gps_diverges = sector_expansion_signals(sector, site)
    if not is_expansion:
        return False
    if mode == 'all':
        return True
    if mode == 'same_latlong':
        return not gps_diverges
    if mode == 'different_latlong':
        return gps_diverges
    return False


def site_matches_sector_expansion(site, mode: str) -> bool:
    """`site.sectors` must already be prefetched by the caller — this
    iterates it once per site and would N+1 query otherwise.

    mode:
      'all'              -> at least one sector is flagged expansion by
                             ANY signal.
      'same_latlong'      -> at least one expansion-flagged sector whose
                             GPS still matches the site (the letter/cell-
                             name convention flagged it, but its
                             coordinates haven't been updated to show a
                             real second location yet).
      'different_latlong' -> at least one expansion-flagged sector whose
                             GPS genuinely differs from the site (the
                             coordinates themselves confirm it).
    """
    return any(sector_matches_mode(sec, site, mode) for sec in site.sectors.all())
