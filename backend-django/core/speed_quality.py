"""How good a speed test is for four everyday uses (2026-10-29, like Ookla's
dots): browsing, video streaming, gaming and video calls.

Fixed limits on download, upload, ping, jitter, packet loss and loaded
latency (the ping while the download or upload runs). The phone holds the
same table (SDK `device/SpeedRatings.kt`); keep the two in step. A limit whose
figure is missing is skipped; with no download there is no rating.
"""

LEVELS = ('poor', 'fair', 'good', 'very_good')
LEVEL_LABELS = {'poor': 'Poor', 'fair': 'Fair', 'good': 'Good', 'very_good': 'Very good'}
USES = ('browsing', 'video', 'gaming', 'video_call')
USE_LABELS = {'browsing': 'Browsing', 'video': 'Video streaming', 'gaming': 'Gaming', 'video_call': 'Video calls'}

# Per use, best level first: minimum download / upload (Mbps), maximum ping,
# jitter, loss (%), loaded latency (ms).
TABLE = {
    'browsing': [
        ('very_good', dict(down=25, ping=50, loaded=300)),
        ('good', dict(down=10, ping=100, loaded=600)),
        ('fair', dict(down=3, ping=200)),
    ],
    'video': [
        ('very_good', dict(down=25)),
        ('good', dict(down=10)),
        ('fair', dict(down=3)),
    ],
    'gaming': [
        ('very_good', dict(down=5, ping=30, jitter=10, loss=0.5, loaded=100)),
        ('good', dict(down=3, ping=60, jitter=20, loss=1, loaded=200)),
        ('fair', dict(down=1, ping=100, jitter=30, loss=2.5, loaded=400)),
    ],
    'video_call': [
        ('very_good', dict(down=10, up=10, ping=50, jitter=15, loss=0.5, loaded=150)),
        ('good', dict(down=3, up=3, ping=100, jitter=30, loss=1, loaded=250)),
        ('fair', dict(down=1, up=1, ping=150, jitter=50, loss=3, loaded=500)),
    ],
}

# Above this, "the delay rises under load" is worth saying (the phone's
# ProblemHints uses the same figure).
HIGH_LOADED_MS = 400


def loaded_latency(latency_down_ms, latency_up_ms):
    values = [v for v in (latency_down_ms, latency_up_ms) if v is not None]
    return max(values) if values else None


def rate(download_mbps, upload_mbps=None, ping_ms=None, jitter_ms=None, loss_pct=None,
         latency_down_ms=None, latency_up_ms=None):
    """{'browsing': 'good', ...}, or {} when there is no download figure."""
    if download_mbps is None:
        return {}
    loaded = loaded_latency(latency_down_ms, latency_up_ms)
    out = {}
    for use, levels in TABLE.items():
        level = 'poor'
        for name, lim in levels:
            if (download_mbps >= lim.get('down', 0)
                    and ('up' not in lim or upload_mbps is None or upload_mbps >= lim['up'])
                    and ('ping' not in lim or ping_ms is None or ping_ms <= lim['ping'])
                    and ('jitter' not in lim or jitter_ms is None or jitter_ms <= lim['jitter'])
                    and ('loss' not in lim or loss_pct is None or loss_pct <= lim['loss'])
                    and ('loaded' not in lim or loaded is None or loaded <= lim['loaded'])):
                level = name
                break
        out[use] = level
    return out


def fields(download_mbps, upload_mbps, ping_ms, jitter_ms, loss_pct, latency_down_ms, latency_up_ms):
    """The keys every speed-test list returns: loaded latency and the ratings."""
    return {
        'latency_down_ms': latency_down_ms, 'latency_up_ms': latency_up_ms,
        'ratings': rate(download_mbps, upload_mbps, ping_ms, jitter_ms, loss_pct, latency_down_ms, latency_up_ms),
    }
