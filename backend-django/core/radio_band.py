"""Operating band of a phone reading (2026-10-13).

A phone reports the channel number of its serving cell: EARFCN on 4G,
UARFCN on 3G, NR-ARFCN on 5G, and the BCCH ARFCN on 2G. Newer phones
(Android 11 and later) also report the band itself. This module turns
either into the two values the screens show:

    band      3GPP operating band number (4G, 3G, 5G). None on 2G, where
              bands are named by frequency.
    band_mhz  the band's common name in MHz: 900, 1800, 2100 ...

The band the phone reports wins. A channel number is used when the phone
gave none. The tables hold the bands a phone can meet in Nepal and the
region, not every band in the specifications: a channel outside them gives
no band, never a guess.

Downlink channel ranges: 3GPP TS 36.101 table 5.7.3-1 (4G), TS 25.101
table 5.1 (3G), TS 45.005 table 2-2 (2G).
"""

# (first channel, last channel, band, MHz)
_LTE = (
    (0, 599, 1, 2100), (600, 1199, 2, 1900), (1200, 1949, 3, 1800), (1950, 2399, 4, 1700),
    (2400, 2649, 5, 850), (2750, 3449, 7, 2600), (3450, 3799, 8, 900), (6150, 6449, 20, 800),
    (9210, 9659, 28, 700), (37750, 38249, 38, 2600), (38250, 38649, 39, 1900),
    (38650, 39649, 40, 2300), (39650, 41589, 41, 2500),
)
_UMTS = (
    (10562, 10838, 1, 2100), (9662, 9938, 2, 1900), (1162, 1513, 3, 1800),
    (4357, 4458, 5, 850), (2937, 3088, 8, 900),
)
# 2G has no band number here. 512-885 is DCS 1800; PCS 1900 reuses part of
# that range but is not used in this region.
_GSM = ((0, 124, 900), (975, 1023, 900), (128, 251, 850), (512, 885, 1800))

# Band number -> MHz. 4G, 3G and 5G share these numbers for the bands listed.
_MHZ = {
    1: 2100, 2: 1900, 3: 1800, 4: 1700, 5: 850, 7: 2600, 8: 900, 20: 800, 28: 700,
    38: 2600, 39: 1900, 40: 2300, 41: 2500, 77: 3700, 78: 3500,
}


def _from_table(table, channel):
    for row in table:
        if row[0] <= channel <= row[1]:
            return row[2:]
    return None


def resolve(network_type, arfcn=None, band=None, bcch=None):
    """(band, band_mhz) for one reading. Either may be None."""
    if network_type == 'GSM':
        channel = arfcn if arfcn is not None else bcch
        hit = _from_table(_GSM, channel) if channel is not None else None
        return None, (hit[0] if hit else None)
    if band is not None and not 1 <= band <= 1024:
        band = None
    if band is None and arfcn is not None:
        table = {'LTE': _LTE, 'UMTS': _UMTS}.get(network_type)
        hit = _from_table(table, arfcn) if table else None
        if hit:
            return hit[0], hit[1]
    return band, _MHZ.get(band)


def label(network_type, band, band_mhz):
    """Text for a table cell: 'B3 (1800)', 'n78 (3500)', '900', or ''."""
    if band is None:
        return str(band_mhz) if band_mhz else ''
    name = f'n{band}' if network_type == 'NR' else f'B{band}'
    return f'{name} ({band_mhz})' if band_mhz else name


def fields(network_type, arfcn, band, band_mhz):
    """The band keys every sample list returns."""
    return {
        'arfcn': arfcn,
        'band': band,
        'band_mhz': band_mhz,
        'band_label': label(network_type, band, band_mhz),
    }


def gsm_mhz_sql(column='bcch'):
    """SQL for a 2G reading's band from its BCCH channel, for backfills."""
    parts = ' '.join(f'WHEN {column} BETWEEN {low} AND {high} THEN {mhz}' for low, high, mhz in _GSM)
    return f'(CASE {parts} END)'
