"""Keycloak SSO tests.

Runs inside the existing `manage.py test core` suite with no live Keycloak and
no live Redis: a real RSA keypair is generated once per class and used to sign
ID tokens, `sso._jwks` is patched to hand back the matching public key, and
`sso._redis` is patched with a small in-memory fake. That keeps the whole OIDC
flow — including signature, issuer, audience and nonce validation — genuinely
exercised rather than stubbed out at the boundary we most want to test.

What these tests cannot prove is that the *realm* is configured correctly
(client settings, redirect URI, group mapper). That needs the manual
smoke-test checklist in the design spec.
"""
import time
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.test import TestCase, override_settings
from django.urls import reverse

from . import sso
from . import sso_config as cfg
from .models import User

ISSUER = 'https://sso.example.test/realms/company'
CLIENT_ID = 'dtwatch'

SSO_SETTINGS = dict(
    KEYCLOAK_SSO_ENABLED=True,
    KEYCLOAK_ISSUER=ISSUER,
    KEYCLOAK_CLIENT_ID=CLIENT_ID,
    KEYCLOAK_CLIENT_SECRET='shh',
    KEYCLOAK_REDIRECT_URI='http://testserver/api/v2/auth/sso/callback/',
    SSO_FRONTEND_CALLBACK_URL='/sso/callback',
    SSO_FRONTEND_UNAUTHORIZED_URL='/login',
    KEYCLOAK_REQUIRED_GROUP='dtwatch',
    KEYCLOAK_GROUPS_CLAIM='groups',
    KEYCLOAK_ROLE_GROUP_MAP='superadmin:superadmin,platform-admins:admin,viewers:viewer',
)


class FakeRedis:
    """Just the four operations sso.py uses, including GETDEL semantics."""

    def __init__(self):
        self.store = {}

    def setex(self, key, ttl, value):
        self.store[key] = value

    def get(self, key):
        return self.store.get(key)

    def getdel(self, key):
        return self.store.pop(key, None)

    def delete(self, key):
        self.store.pop(key, None)


class FakeSigningKey:
    def __init__(self, key):
        self.key = key


class SSOTestBase(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.private_pem = private.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        cls.public_key = private.public_key()

    def setUp(self):
        super().setUp()
        self.redis = FakeRedis()
        sso.reset_clients()
        patcher_redis = patch.object(sso, '_redis', return_value=self.redis)
        patcher_jwks = patch.object(
            sso, '_jwks',
            return_value=type('J', (), {
                'get_signing_key_from_jwt': lambda _s, _t: FakeSigningKey(self.public_key)
            })(),
        )
        patcher_redis.start()
        patcher_jwks.start()
        self.addCleanup(patcher_redis.stop)
        self.addCleanup(patcher_jwks.stop)

    def make_id_token(self, groups=None, nonce=None, issuer=ISSUER, audience=CLIENT_ID, **over):
        now = int(time.time())
        claims = {
            'iss': issuer,
            'aud': audience,
            'sub': 'kc-subject-1',
            'iat': now,
            'exp': now + 300,
            'preferred_username': 'puru',
            'email': 'puru@ntc.net.np',
            'email_verified': True,
            'name': 'Puru Bagale',
            'groups': groups if groups is not None else ['dtwatch'],
        }
        if nonce is not None:
            claims['nonce'] = nonce
        claims.update(over)
        return jwt.encode(claims, self.private_pem, algorithm='RS256')

    def run_flow(self, groups=None, **over):
        """Drive login -> callback and return the callback response."""
        start = self.client.get(reverse('auth-sso-login'))
        state = self.client.cookies[sso.STATE_COOKIE].value
        txn = sso.pop_transaction(state)
        # pop consumed it; put it back so the view can consume it itself.
        self.redis.setex(
            sso._TXN_PREFIX + state, 600,
            __import__('json').dumps(txn),
        )
        token = self.make_id_token(groups=groups, nonce=txn['nonce'], **over)
        with patch.object(sso.requests, 'post') as post:
            post.return_value.status_code = 200
            post.return_value.json.return_value = {'id_token': token}
            return self.client.get(
                reverse('auth-sso-callback'), {'code': 'abc', 'state': state}
            )


@override_settings(**SSO_SETTINGS)
class GateAndRoleTests(SSOTestBase):
    def test_member_of_required_group_is_admitted_and_created(self):
        resp = self.run_flow(groups=['dtwatch'])
        self.assertEqual(resp.status_code, 302)
        self.assertIn('/sso/callback?code=', resp['Location'])
        user = User.objects.get(username='puru')
        self.assertEqual(user.auth_source, User.AUTH_SOURCE_SSO)
        self.assertEqual(user.sso_subject, 'kc-subject-1')
        # No role group -> least privilege, not a guess.
        self.assertEqual(user.role, 'viewer')

    def test_missing_required_group_is_refused(self):
        resp = self.run_flow(groups=['viewers'])
        self.assertEqual(resp.status_code, 302)
        self.assertIn('sso_error=no_app_access', resp['Location'])
        self.assertFalse(User.objects.filter(username='puru').exists())

    def test_empty_groups_claim_is_refused(self):
        resp = self.run_flow(groups=[])
        self.assertIn('sso_error=no_app_access', resp['Location'])

    def test_role_mapping_superadmin(self):
        self.run_flow(groups=['dtwatch', 'superadmin'])
        self.assertEqual(User.objects.get(username='puru').role, 'superadmin')

    def test_role_mapping_admin(self):
        self.run_flow(groups=['dtwatch', 'platform-admins'])
        self.assertEqual(User.objects.get(username='puru').role, 'admin')

    def test_role_mapping_viewer(self):
        self.run_flow(groups=['dtwatch', 'viewers'])
        self.assertEqual(User.objects.get(username='puru').role, 'viewer')

    def test_unmapped_group_falls_back_to_viewer(self):
        self.run_flow(groups=['dtwatch', 'developers'])
        self.assertEqual(User.objects.get(username='puru').role, 'viewer')

    def test_highest_privilege_wins_regardless_of_claim_order(self):
        self.run_flow(groups=['dtwatch', 'viewers', 'superadmin'])
        self.assertEqual(User.objects.get(username='puru').role, 'superadmin')

    def test_full_group_paths_are_matched(self):
        """The mapper's "Full group path" toggle must not change the outcome."""
        self.run_flow(groups=['/dtwatch', '/ntc/staff/superadmin'])
        self.assertEqual(User.objects.get(username='puru').role, 'superadmin')

    def test_role_is_reapplied_from_keycloak_on_every_login(self):
        self.run_flow(groups=['dtwatch', 'superadmin'])
        User.objects.filter(username='puru').update(role='viewer')
        self.run_flow(groups=['dtwatch', 'superadmin'])
        self.assertEqual(User.objects.get(username='puru').role, 'superadmin')


@override_settings(**SSO_SETTINGS)
class LinkingTests(SSOTestBase):
    def test_links_by_sso_subject_even_if_username_changed(self):
        existing = User.objects.create(
            username='old-name', email='puru@ntc.net.np', sso_subject='kc-subject-1'
        )
        self.run_flow(groups=['dtwatch'])
        existing.refresh_from_db()
        self.assertEqual(existing.sso_subject, 'kc-subject-1')
        self.assertEqual(User.objects.count(), 1)

    def test_links_to_local_account_on_verified_matching_email(self):
        local = User.objects.create(username='puru', email='puru@ntc.net.np')
        local.set_password('old-local-password')
        local.save()
        self.run_flow(groups=['dtwatch'])
        local.refresh_from_db()
        self.assertEqual(local.sso_subject, 'kc-subject-1')
        self.assertEqual(local.auth_source, User.AUTH_SOURCE_SSO)
        self.assertEqual(User.objects.count(), 1)

    def test_refuses_to_link_when_email_is_unverified(self):
        User.objects.create(username='puru', email='puru@ntc.net.np')
        resp = self.run_flow(groups=['dtwatch'], email_verified=False)
        self.assertIn('sso_error=link_conflict', resp['Location'])
        self.assertIsNone(User.objects.get(username='puru').sso_subject)

    def test_refuses_to_link_when_emails_differ(self):
        User.objects.create(username='puru', email='someone.else@ntc.net.np')
        resp = self.run_flow(groups=['dtwatch'])
        self.assertIn('sso_error=link_conflict', resp['Location'])

    def test_jit_created_user_cannot_use_password_login(self):
        self.run_flow(groups=['dtwatch'])
        self.assertFalse(User.objects.get(username='puru').has_usable_password())

    def test_disabled_account_is_refused(self):
        User.objects.create(
            username='puru', email='puru@ntc.net.np',
            sso_subject='kc-subject-1', is_active=False,
        )
        resp = self.run_flow(groups=['dtwatch'])
        self.assertIn('sso_error=inactive_user', resp['Location'])


@override_settings(**SSO_SETTINGS)
class TokenValidationTests(SSOTestBase):
    def test_wrong_issuer_is_rejected(self):
        resp = self.run_flow(issuer='https://evil.example/realms/company')
        self.assertIn('sso_error=invalid_id_token', resp['Location'])

    def test_wrong_audience_is_rejected(self):
        resp = self.run_flow(audience='some-other-client')
        self.assertIn('sso_error=invalid_id_token', resp['Location'])

    def test_expired_token_is_rejected(self):
        resp = self.run_flow(exp=int(time.time()) - 10)
        self.assertIn('sso_error=invalid_id_token', resp['Location'])

    def test_signature_from_the_wrong_key_is_rejected(self):
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        other_pem = other.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        with self.assertRaises(sso.SSOError) as ctx:
            sso.verify_id_token(jwt.encode(
                {'iss': ISSUER, 'aud': CLIENT_ID, 'sub': 'x',
                 'iat': int(time.time()), 'exp': int(time.time()) + 300},
                other_pem, algorithm='RS256',
            ))
        self.assertEqual(ctx.exception.code, 'invalid_id_token')

    def test_nonce_mismatch_is_rejected(self):
        token = self.make_id_token(nonce='not-the-one')
        with self.assertRaises(sso.SSOError) as ctx:
            sso.verify_id_token(token, nonce='expected')
        self.assertEqual(ctx.exception.code, 'nonce_mismatch')

    def test_missing_id_token_is_rejected(self):
        with self.assertRaises(sso.SSOError) as ctx:
            sso.verify_id_token('')
        self.assertEqual(ctx.exception.code, 'no_id_token')


@override_settings(**SSO_SETTINGS)
class CallbackSecurityTests(SSOTestBase):
    def test_state_cookie_mismatch_is_rejected(self):
        self.client.get(reverse('auth-sso-login'))
        resp = self.client.get(
            reverse('auth-sso-callback'), {'code': 'abc', 'state': 'forged-state'}
        )
        self.assertIn('sso_error=bad_state', resp['Location'])

    def test_transaction_is_single_use(self):
        """A replayed callback must fail even with the right state + cookie."""
        start = self.client.get(reverse('auth-sso-login'))
        state = self.client.cookies[sso.STATE_COOKIE].value
        txn = sso.pop_transaction(state)
        with self.assertRaises(sso.SSOError) as ctx:
            sso.pop_transaction(state)
        self.assertEqual(ctx.exception.code, 'bad_state')

    def test_idp_error_is_surfaced_without_detail(self):
        self.client.get(reverse('auth-sso-login'))
        resp = self.client.get(reverse('auth-sso-callback'), {'error': 'access_denied'})
        self.assertIn('sso_error=idp_error', resp['Location'])


@override_settings(**SSO_SETTINGS)
class TokenExchangeTests(SSOTestBase):
    def test_login_code_is_single_use(self):
        resp = self.run_flow(groups=['dtwatch'])
        code = resp['Location'].split('code=')[1]

        first = self.client.post(reverse('auth-sso-token'), {'code': code})
        self.assertEqual(first.status_code, 200)
        self.assertIn('access', first.json())
        self.assertIn('refresh', first.json())
        # Same shape as /auth/login/, which is what lets the SPA reuse its
        # existing login path unchanged.
        self.assertIn('permissions', first.json())

        second = self.client.post(reverse('auth-sso-token'), {'code': code})
        self.assertEqual(second.status_code, 400)

    def test_unknown_code_is_rejected(self):
        resp = self.client.post(reverse('auth-sso-token'), {'code': 'nope'})
        self.assertEqual(resp.status_code, 400)

    def test_account_disabled_between_callback_and_exchange(self):
        resp = self.run_flow(groups=['dtwatch'])
        code = resp['Location'].split('code=')[1]
        User.objects.filter(username='puru').update(is_active=False)
        self.assertEqual(
            self.client.post(reverse('auth-sso-token'), {'code': code}).status_code, 403
        )


class ConfigurationTests(TestCase):
    """SSO must be all-or-nothing: a half-configured client should show no
    button rather than one that fails after the password is typed."""

    @override_settings(**SSO_SETTINGS)
    def test_fully_configured(self):
        self.assertTrue(cfg.is_configured())

    @override_settings(**{**SSO_SETTINGS, 'KEYCLOAK_SSO_ENABLED': False})
    def test_disabled_flag_wins_over_complete_config(self):
        self.assertFalse(cfg.is_configured())

    @override_settings(**{**SSO_SETTINGS, 'KEYCLOAK_CLIENT_SECRET': ''})
    def test_missing_secret_is_not_configured(self):
        self.assertFalse(cfg.is_configured())

    @override_settings(**{**SSO_SETTINGS, 'KEYCLOAK_REDIRECT_URI': ''})
    def test_missing_redirect_uri_is_not_configured(self):
        self.assertFalse(cfg.is_configured())

    def test_sso_login_returns_503_when_unconfigured(self):
        self.assertEqual(self.client.get(reverse('auth-sso-login')).status_code, 503)

    @override_settings(KEYCLOAK_ROLE_GROUP_MAP='  a:superadmin , bad-entry ,b:admin ')
    def test_role_group_map_ignores_malformed_entries(self):
        self.assertEqual(cfg.role_group_map(), {'a': 'superadmin', 'b': 'admin'})

    @override_settings(KEYCLOAK_SIGNING_ALGS='RS256, PS256')
    def test_signing_algs_parses_a_list(self):
        self.assertEqual(cfg.signing_algs(), ['RS256', 'PS256'])

    def test_redis_url_comes_from_settings_not_a_private_default(self):
        """Regression (2026-08-23): settings.py used to read REDIS_URL inline
        inside CACHES only, so `settings.REDIS_URL` did not exist and
        sso_config fell through to its own 'redis://redis:6379/1' default.
        Every SSO login then 500'd with a DNS failure, because the
        shared-redis override deletes the bundled `redis` service. The two
        must resolve to the same place."""
        from django.conf import settings as dj
        self.assertTrue(hasattr(dj, 'REDIS_URL'), 'settings.REDIS_URL must be defined')
        self.assertEqual(cfg.redis_url(), dj.REDIS_URL)

    @override_settings(REDIS_URL='redis://default:pw@shared-redis:6379/1')
    def test_redis_url_honours_an_overridden_host(self):
        self.assertEqual(cfg.redis_url(), 'redis://default:pw@shared-redis:6379/1')


class LocalLoginToggleTests(TestCase):
    """The cutover switch. Local login must keep working by default and stop
    working — reversibly — when the flag is off."""

    def setUp(self):
        self.user = User.objects.create(username='localguy', role='admin')
        self.user.set_password('correct-horse')
        self.user.save()

    def test_enabled_by_default(self):
        self.assertTrue(cfg.local_login_enabled())
        resp = self.client.post(
            reverse('auth-login'),
            {'username': 'localguy', 'password': 'correct-horse'},
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIn('access', resp.json())

    @override_settings(LOCAL_LOGIN_ENABLED=False)
    def test_disabled_refuses_even_correct_credentials(self):
        resp = self.client.post(
            reverse('auth-login'),
            {'username': 'localguy', 'password': 'correct-horse'},
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 403)
        self.assertNotIn('access', resp.json())

    @override_settings(LOCAL_LOGIN_ENABLED=False)
    def test_disabled_does_not_reveal_whether_the_user_exists(self):
        """Both a real and a fake username must give the identical response,
        so a disabled endpoint cannot be used to enumerate accounts."""
        real = self.client.post(
            reverse('auth-login'),
            {'username': 'localguy', 'password': 'wrong'},
            content_type='application/json',
        )
        fake = self.client.post(
            reverse('auth-login'),
            {'username': 'nobody-here', 'password': 'wrong'},
            content_type='application/json',
        )
        self.assertEqual(real.status_code, fake.status_code)
        self.assertEqual(real.json(), fake.json())


class HealthBuildStampTests(TestCase):
    """The build stamp must not leak to unauthenticated callers.

    /health/ is AllowAny because docker-compose's healthcheck and uptime
    monitoring hit it without credentials. But an exact build tag plus git SHA
    tells an anonymous visitor which commit is deployed, and this app is served
    through a public-facing proxy. Flagged by a security review on 2026-08-23
    after the fields were first added unconditionally.
    """

    @override_settings(APP_VERSION='v1.2.3', BUILD_TAG='v1.2.3-1-x-abc', GIT_SHA='abc')
    def test_anonymous_gets_no_build_stamp(self):
        body = self.client.get(reverse('health')).json()
        # Health itself must still work — the healthcheck depends on it.
        self.assertEqual(body['status'], 'ok')
        self.assertEqual(body['service'], 'dt-watch-django')
        for leaked in ('version', 'build_tag', 'git_sha'):
            self.assertNotIn(leaked, body)

    @override_settings(APP_VERSION='v1.2.3', BUILD_TAG='v1.2.3-1-x-abc', GIT_SHA='abc')
    def test_authenticated_gets_the_build_stamp(self):
        """AboutPage needs it, and gets it from the same endpoint — no second
        route — because DRF still runs its authentication classes on an
        AllowAny view."""
        user = User.objects.create(username='someone', role='viewer')
        user.set_password('pw')
        user.save()
        self.client.force_login(user)
        body = self.client.get(reverse('health')).json()
        self.assertEqual(body['version'], 'v1.2.3')
        self.assertEqual(body['build_tag'], 'v1.2.3-1-x-abc')
        self.assertEqual(body['git_sha'], 'abc')


class PublicLoginMethodFlagsTests(TestCase):
    """LoginPage.tsx renders from the public branding payload, so the flags
    have to be there and readable without a token."""

    def test_flags_present_and_unauthenticated(self):
        resp = self.client.get(reverse('branding'))
        self.assertEqual(resp.status_code, 200)
        self.assertIn('sso_enabled', resp.json())
        self.assertIn('local_login_enabled', resp.json())
        self.assertFalse(resp.json()['sso_enabled'])
        self.assertTrue(resp.json()['local_login_enabled'])

    @override_settings(**SSO_SETTINGS)
    def test_sso_enabled_reported_when_configured(self):
        self.assertTrue(self.client.get(reverse('branding')).json()['sso_enabled'])
