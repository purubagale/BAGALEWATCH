"""Screening of phone readings on arrival (2026-10-29), for when the phone
side of DT-WATCH is open to the internet.

Three plain checks, run on every upload before the readings are stored:

  daily cap   at most TELEMETRY_DEVICE_DAILY_CAP readings a day per phone;
              the rest of a batch past the cap is dropped, so one broken or
              hostile phone cannot flood the server.
  jump        a reading whose position is more than JUMP_MIN_KM from the
              phone's previous one, at a speed no vehicle reaches
              (JUMP_SPEED_MS), is kept but flagged 'jump'.
  burst       readings less than BURST_GAP_S apart from the same phone are
              kept but flagged 'burst' (the app reads every 10 s at most).

Each reading also records whether it came signed by a registered phone
(`signed`); a reading sent with the app's shared key is not. Flagged
readings stay visible on Live Samples but are left out of the coverage
roll-up and the complaint check.
"""
import math
from datetime import datetime

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

JUMP_MIN_KM = 2.0
JUMP_SPEED_MS = 85.0      # about 300 km/h
BURST_GAP_S = 1.0
LAST_TTL_S = 2 * 86400


def daily_cap():
    return int(getattr(settings, 'TELEMETRY_DEVICE_DAILY_CAP', 20000))


def _km(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 12742.0 * math.asin(math.sqrt(a))


def _take(device_id, n):
    """How many of `n` readings this phone may still send today."""
    key = f'ingestcap:{device_id}:{timezone.now():%Y%m%d}'
    cache.add(key, 0, timeout=90000)
    try:
        after = cache.incr(key, n)
    except ValueError:
        return n
    cap = daily_cap()
    return max(0, n - max(0, after - cap))


def screen(rows, signed):
    """Applies the cap and the checks. Returns (rows to store, dropped)."""
    by_device = {}
    for r in rows:
        by_device.setdefault(r['device_id'], []).append(r)
    kept, dropped = [], 0
    for device_id, items in by_device.items():
        items.sort(key=lambda r: r['ts'])
        allowed = _take(device_id, len(items))
        dropped += len(items) - allowed
        items = items[:allowed]
        last = cache.get(f'ingestlast:{device_id}')   # (iso ts, lat, lng) or None
        prev_ts = datetime.fromisoformat(last[0]) if last else None
        prev_pos = (last[1], last[2]) if last else None
        for r in items:
            flag = ''
            if prev_ts is not None:
                gap = (r['ts'] - prev_ts).total_seconds()
                if r['lat'] is not None and r['lng'] is not None and prev_pos is not None:
                    km = _km(prev_pos[0], prev_pos[1], r['lat'], r['lng'])
                    if km > JUMP_MIN_KM and (gap <= 0 or km * 1000 / gap > JUMP_SPEED_MS):
                        flag = 'jump'
                if not flag and 0 <= gap < BURST_GAP_S and r.get('trigger_reason') not in ('drive_start', 'drive_stop'):
                    flag = 'burst'
            r['signed'] = bool(signed)
            r['flag'] = flag
            prev_ts = r['ts']
            if r['lat'] is not None and r['lng'] is not None:
                prev_pos = (r['lat'], r['lng'])
            kept.append(r)
        if items:
            cache.set(f'ingestlast:{device_id}',
                      (prev_ts.isoformat(), prev_pos[0] if prev_pos else None, prev_pos[1] if prev_pos else None),
                      LAST_TTL_S)
    return kept, dropped
