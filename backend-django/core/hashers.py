"""
A password hasher that verifies (but never creates) the v1 system's
hand-rolled PBKDF2 password format from bagalewatch_api.py:

    pbkdf2_sha256$<iterations>$<salt-hex>$<digest-hex>

This looks almost identical to Django's own PBKDF2PasswordHasher output,
but isn't compatible: Django hex/base64-encodes the digest as base64,
v1 uses plain hex (`dk.hex()`). Both formats also use the SAME algorithm
tag ('pbkdf2_sha256'), which would collide with Django's own hasher if a
v1 hash were imported unchanged — Django would try to verify it as base64,
get nonsense bytes back, and reject every migrated user's password.

The fix: the data-migration step (core/management/commands/seed_legacy_data.py)
rewrites the algorithm prefix on import from 'pbkdf2_sha256' to
'bagalewatch_legacy_pbkdf2' before storing it in the v2 `password` column.
That distinct prefix routes Django's hasher lookup (`identify_hasher`) to
THIS class instead of Django's built-in one.

Upgrade-on-login happens for free, no custom view code needed: this
hasher is not first in PASSWORD_HASHERS, so Django's own
`check_password(raw_password, encoded, setter)` sees `hasher.algorithm !=
preferred.algorithm`, treats that as `must_update=True`, and calls
`setter(raw_password)` on a successful verify — which re-hashes the
password with Django's native PBKDF2PasswordHasher and saves it. This is
the exact same "verify legacy, upgrade on next successful login" pattern
the v1 system already used for its own plain-sha256 -> pbkdf2_sha256
migration, just carried one hop further onto Django's own native format.
"""
import hashlib

from django.contrib.auth.hashers import BasePasswordHasher, mask_hash
from django.utils.crypto import constant_time_compare


class LegacyBagalewatchPBKDF2Hasher(BasePasswordHasher):
    algorithm = 'bagalewatch_legacy_pbkdf2'
    digest = hashlib.sha256

    def encode(self, password, salt, iterations=None):
        # Django never creates NEW hashes in this format (the native
        # PBKDF2PasswordHasher, first in PASSWORD_HASHERS, does that) —
        # this only exists so the hasher satisfies BasePasswordHasher's
        # interface, e.g. for tests that want to construct a fixture hash.
        iterations = iterations or 200_000
        salt_bytes = bytes.fromhex(salt) if isinstance(salt, str) else salt
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt_bytes, iterations)
        return f'{self.algorithm}${iterations}${salt}${dk.hex()}'

    def verify(self, password, encoded):
        algorithm, iterations_s, salt, hash_hex = encoded.split('$', 3)
        assert algorithm == self.algorithm
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), int(iterations_s))
        return constant_time_compare(dk.hex(), hash_hex)

    def safe_summary(self, encoded):
        algorithm, iterations, salt, hash_ = encoded.split('$', 3)
        return {
            'algorithm': algorithm,
            'iterations': iterations,
            'salt': mask_hash(salt),
            'hash': mask_hash(hash_),
        }

    def must_update(self, encoded):
        # Belt-and-suspenders — Django's check_password() already treats
        # any non-preferred hasher as must_update via the algorithm-
        # mismatch check, but being explicit here documents the intent:
        # every legacy hash should be a one-time-use bridge, never the
        # long-term stored format.
        return True

    def harden_runtime(self, password, encoded):
        # No-op: this hasher only ever verifies existing legacy hashes,
        # it never needs runtime-cost hardening against timing attacks
        # on encode() the way an actively-used hasher would.
        pass


class LegacyBagalewatchSha256Hasher(BasePasswordHasher):
    """
    Verifies the OLDER of v1's two legacy formats: 'sha256:<hex>' — a
    plain, unsalted SHA-256 of the password, produced by the original
    browser-only client before the PBKDF2 migration
    (see verify_password()'s 'needs_upgrade' branch in bagalewatch_api.py).
    Real production data seeded by DEFAULT_USERS already uses the newer
    pbkdf2_sha256 format, so this exists purely for completeness/safety —
    any account still on this format at seed time gets a working
    upgrade-on-login path here too, exactly like the pbkdf2 legacy hasher
    above, rather than silently failing to import.
    """
    algorithm = 'bagalewatch_legacy_sha256'
    digest = hashlib.sha256

    def encode(self, password, salt=None, iterations=None):
        return f'{self.algorithm}${hashlib.sha256(password.encode("utf-8")).hexdigest()}'

    def verify(self, password, encoded):
        algorithm, hash_hex = encoded.split('$', 1)
        assert algorithm == self.algorithm
        actual = hashlib.sha256(password.encode('utf-8')).hexdigest()
        return constant_time_compare(actual, hash_hex)

    def safe_summary(self, encoded):
        algorithm, hash_ = encoded.split('$', 1)
        return {'algorithm': algorithm, 'hash': mask_hash(hash_)}

    def must_update(self, encoded):
        return True

    def harden_runtime(self, password, encoded):
        pass
