# Data migration — seeds DtBand with today's hardcoded band tables from
# the frontend (frontend-react/src/lib/dtBands.ts), transcribed exactly
# so behavior is byte-for-byte unchanged until an admin actually edits
# something via the new Band Colors page. Kept as a real migration
# (not a management command) so a fresh `docker compose up --build` +
# `migrate` on any machine gets working defaults automatically, same as
# every other seeded-default table in this app.
#
# `RunPython` with a reverse no-op (`migrations.RunPython.noop`) — there's
# nothing meaningful to "undo" here beyond deleting the rows, and a
# forward-only seed is the same convention this project already uses
# elsewhere for one-time backfills.
from django.db import migrations

# label -> tag suffix per tech, matching lib/dtBands.ts's
# `${m.label}:${tech}` tag format exactly.
DEFAULT_BANDS = {
    'RSRP:4G': [
        ('< -105', -999, -105, '#dc2626'),
        ('-105 to -95', -105, -95, '#f97316'),
        ('-95 to -87', -95, -87, '#eab308'),
        ('-87 to -77', -87, -77, '#84cc16'),
        ('> -77', -77, 0, '#16a34a'),
    ],
    'RSCP:3G': [
        ('< -105', -999, -105, '#dc2626'),
        ('-105 to -95', -105, -95, '#f97316'),
        ('-95 to -87', -95, -87, '#eab308'),
        ('-87 to -77', -87, -77, '#84cc16'),
        ('> -77', -77, 0, '#16a34a'),
    ],
    'RxLevel:2G': [
        ('< -105', -999, -105, '#dc2626'),
        ('-105 to -92', -105, -92, '#f97316'),
        ('-92 to -82', -92, -82, '#eab308'),
        ('-82 to -72', -82, -72, '#84cc16'),
        ('> -72', -72, 999, '#16a34a'),
    ],
    'RSRQ:4G': [
        ('< -20', -999, -20, '#dc2626'),
        ('-20 to -17', -20, -17, '#f97316'),
        ('-17 to -15', -17, -15, '#eab308'),
        ('-15 to -13', -15, -13, '#2563eb'),
        ('-13 to -10', -13, -10, '#22d3ee'),
        ('-10 to -3', -10, -3, '#84cc16'),
        ('>= -3', -3, 999, '#16a34a'),
    ],
    'SINR:4G': [
        ('< -5', -999, -5, '#dc2626'),
        ('-5 to 0', -5, 0, '#f97316'),
        ('0 to 5', 0, 5, '#eab308'),
        ('5 to 10', 5, 10, '#2563eb'),
        ('10 to 15', 10, 15, '#22d3ee'),
        ('15 to 20', 15, 20, '#84cc16'),
        ('>= 20', 20, 999, '#16a34a'),
    ],
    'Ec/Io:3G': [
        ('< -18', -999, -18, '#94a3b8'),
        ('-18 to -15', -18, -15, '#dc2626'),
        ('-15 to -13', -15, -13, '#f97316'),
        ('-13 to -11', -13, -11, '#fb923c'),
        ('-11 to -9', -11, -9, '#eab308'),
        ('-9 to -7', -9, -7, '#a3e635'),
        ('-7 to -5', -7, -5, '#22c55e'),
        ('-5 to 0', -5, 0, '#15803d'),
        ('>= 0', 0, 999, '#052e16'),
    ],
    'RxQual:2G': [
        ('0', 0, 1, '#84cc16'),
        ('1', 1, 2, '#16a34a'),
        ('2', 2, 3, '#eab308'),
        ('3', 3, 4, '#f97316'),
        ('4', 4, 5, '#f472b6'),
        ('5', 5, 6, '#991b1b'),
        ('6', 6, 7, '#dc2626'),
        ('>= 7', 7, 999, '#7f1d1d'),
    ],
}


def seed_defaults(apps, schema_editor):
    DtBand = apps.get_model('core', 'DtBand')
    # Idempotent guard — if this migration is ever re-run against a DB
    # that already has rows (shouldn't normally happen, but matches this
    # app's general defensiveness elsewhere), don't duplicate them.
    if DtBand.objects.exists():
        return
    rows = []
    for tag, bands in DEFAULT_BANDS.items():
        for order, (label, min_v, max_v, color) in enumerate(bands):
            rows.append(DtBand(metric_tag=tag, label=label, min_value=min_v, max_value=max_v, color=color, sort_order=order))
    DtBand.objects.bulk_create(rows)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0007_dtband'),
    ]

    operations = [
        migrations.RunPython(seed_defaults, migrations.RunPython.noop),
    ]
