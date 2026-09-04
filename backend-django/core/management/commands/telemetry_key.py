"""
python manage.py telemetry_key create "<name>" [--rate 600] [--expires-days N]
python manage.py telemetry_key list
python manage.py telemetry_key revoke <key_prefix>

Mint / list / revoke the ingest credentials for the crowdsourced
telemetry endpoint (POST /api/telemetry/v1/samples/). This is the CLI
side of the pilot's separate-mechanism auth (models.py TelemetryIngestKey)
— a superadmin admin page can come later; a command is enough to hand the
Android app team a key to point the SDK's TelemetryConfig.apiKey at.

`create` prints the full key ONCE. It is not recoverable afterwards
(only its SHA-256 hash and non-secret prefix are stored) — losing it
means minting a new one and revoking the old.
"""
from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.models import TelemetryIngestKey
from core.telemetry import generate_ingest_key


class Command(BaseCommand):
    help = 'Manage telemetry ingest keys (create / list / revoke).'

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest='cmd', required=True)
        c = sub.add_parser('create', help='Mint a new key.')
        c.add_argument('name')
        c.add_argument('--rate', type=int, default=600, help='Batches/minute allowed (default 600).')
        c.add_argument('--expires-days', type=int, default=None, help='Auto-expire after N days.')
        sub.add_parser('list', help='List keys (prefixes only, never the secret).')
        r = sub.add_parser('revoke', help='Deactivate a key by its prefix.')
        r.add_argument('key_prefix')

    def handle(self, *args, **o):
        if o['cmd'] == 'create':
            full, prefix, key_hash = generate_ingest_key()
            expires = None
            if o['expires_days']:
                expires = timezone.now() + timedelta(days=o['expires_days'])
            TelemetryIngestKey.objects.create(
                name=o['name'], key_prefix=prefix, key_hash=key_hash,
                rate_limit_per_min=o['rate'], expires_at=expires,
            )
            self.stdout.write(self.style.SUCCESS(f'Created telemetry ingest key "{o["name"]}"'))
            self.stdout.write(f'  prefix : {prefix}')
            self.stdout.write(f'  rate   : {o["rate"]} batches/min')
            self.stdout.write(f'  expires: {expires.isoformat() if expires else "never"}')
            self.stdout.write('')
            self.stdout.write(self.style.WARNING('  FULL KEY (shown once, store it now):'))
            self.stdout.write(f'  {full}')
            return

        if o['cmd'] == 'list':
            keys = TelemetryIngestKey.objects.all()
            if not keys:
                self.stdout.write('No telemetry ingest keys.')
                return
            for k in keys:
                state = 'active' if k.is_active else 'REVOKED'
                exp = k.expires_at.isoformat() if k.expires_at else 'never'
                used = k.last_used_at.isoformat() if k.last_used_at else 'never'
                self.stdout.write(
                    f'{k.key_prefix}  {state:8}  rate={k.rate_limit_per_min:<5}  '
                    f'expires={exp}  last_used={used}  "{k.name}"'
                )
            return

        if o['cmd'] == 'revoke':
            n = TelemetryIngestKey.objects.filter(key_prefix=o['key_prefix']).update(is_active=False)
            if not n:
                raise CommandError(f'no key with prefix {o["key_prefix"]!r}')
            self.stdout.write(self.style.SUCCESS(f'Revoked key {o["key_prefix"]}.'))
