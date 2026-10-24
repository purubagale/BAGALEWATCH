"""Operator names for the network codes a phone reports (2026-10-19), so
pages say "Nepal Telecom" rather than "429/01". The app's SDK keeps the
same table (model/Operators.kt); keep the two in step."""

NAMES = {
    ('429', '01'): 'Nepal Telecom',
    ('429', '02'): 'Ncell',
    ('429', '03'): 'UTL',
    ('429', '04'): 'Smart Telecom',
}


def operator_name(mcc, mnc):
    """The operator's name, else "MCC/MNC", else None when neither is known."""
    if not mcc and not mnc:
        return None
    mcc, mnc = str(mcc or '').strip(), str(mnc or '').strip()
    return NAMES.get((mcc, mnc.zfill(2))) or f'{mcc or "?"}/{mnc or "?"}'
