"""Signal level of a phone reading, whatever technology it was on (2026-10-12).

Each technology reports its level under a different name: RSRP on 4G and
5G, RSCP on 3G, RSSI (RxLevel) on 2G. Code that read RSRP alone treated
every 3G and 2G reading as having no level, so those readings were drawn
grey on the maps and left out of the coverage averages.

One rule, in Python and in SQL, so the stored coverage cells and the pages
that work from single samples agree. The frontend's copy of the same rule
is frontend-react/src/lib/telemetryLevel.ts, and the mobile app's is
RouteColor in MapFragment.kt.
"""

# Over a v2_telemetry_samples row.
LEVEL_SQL = "CASE network_type WHEN 'UMTS' THEN rscp_dbm WHEN 'GSM' THEN rssi_dbm ELSE rsrp_dbm END"


def sample_level(network_type, rsrp_dbm, rscp_dbm, rssi_dbm):
    """The level in dBm for one sample, or None."""
    if network_type == 'UMTS':
        return rscp_dbm
    if network_type == 'GSM':
        return rssi_dbm
    return rsrp_dbm
