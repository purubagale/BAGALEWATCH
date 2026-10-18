import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useAlertTest, useSaveSecuritySettings, useSecuritySettings, useSmsTest } from '../api/queries'
import type { SecuritySettings } from '../api/types'

// Security (2026-10-15, superadmin) -- the switches that can be turned on or
// off while the system runs, and a read-only view of the protection that is
// set in the server's configuration (.env). Each switch is audit-logged.

type Toggle = 'mfa_required' | 'mfa_required_admins' | 'phone_verification_required' | 'attack_alerts_enabled'

export default function SecurityPage() {
  const { data, isLoading, error } = useSecuritySettings()
  const save = useSaveSecuritySettings()
  const smsTest = useSmsTest()
  const [testNumber, setTestNumber] = useState('')

  const flip = (name: Toggle, value: boolean, warning?: string) => {
    if (warning && value && !window.confirm(warning)) return
    save.mutate({ [name]: value })
  }
  const s = data?.status

  return (
    <div className="admin-page" style={{ maxWidth: 1000 }}>
      <h1>Security</h1>
      <p className="muted">
        Switches that can be turned on or off at any time, and the protection set in the server's configuration.
        Every change here is written to the Audit Log.
      </p>
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{apiErrorMessage(error)}</p>}
      {save.error && <p className="error">{apiErrorMessage(save.error)}</p>}

      {data && (
        <>
          <section className="sec-card">
            <h2>Two-factor login</h2>
            <p className="muted">
              After the password, the user types a 6-digit code from an authenticator app on their phone. Anyone can
              turn it on for their own account from the menu under their name. When it is required, an account that
              has not set it up is shown the setup at its next sign-in and cannot go further until it is done. NT
              single sign-on accounts are not affected: their own login page handles the second step.
            </p>
            <Switch
              label="Required for superadmins and admins"
              hint="Recommended before the system is reachable from outside NTC."
              on={data.mfa_required_admins}
              busy={save.isPending}
              onChange={(v) => flip('mfa_required_admins', v,
                'Every superadmin and admin who has not set up two-factor login will have to do it at their next sign-in. Continue?')}
            />
            <Switch
              label="Required for everyone"
              hint="Every local account, viewers included."
              on={data.mfa_required}
              busy={save.isPending}
              onChange={(v) => flip('mfa_required', v,
                'Every user who has not set up two-factor login will have to do it at their next sign-in. Continue?')}
            />
          </section>

          <section className="sec-card">
            <h2>Phone number verification</h2>
            <p className="muted">
              A phone registers with a number typed in the app. When the SMS gateway is set up, the app asks for a
              code sent by SMS to that number, which proves the phone really has it. A verified owner can no longer be
              pushed out by someone else typing the same number.
            </p>
            <Switch
              label="Only verified numbers count in lookups"
              hint="Subscriber Profile, Device Location Trace and rescue lookups then ignore phones that only typed the number."
              on={data.phone_verification_required}
              busy={save.isPending}
              onChange={(v) => flip('phone_verification_required', v,
                s && !s.sms.sends_real_sms
                  ? 'No SMS gateway is set up, so no phone can verify its number yet: every lookup by number will find nothing until one is. Continue?'
                  : 'Phones that have not verified their number will no longer appear in lookups by number. Continue?')}
            />
            {s && (
              <>
                <h3>SMS gateway</h3>
                <table className="sec-facts">
                  <tbody>
                    <tr><th>Sending</th><td>
                      {s.sms.backend === 'off' && 'Off: no SMS is sent, and the app does not ask phones for a code.'}
                      {s.sms.backend === 'console' && 'Test mode: messages are written to the server log, not sent.'}
                      {(s.sms.backend === 'http' || s.sms.backend === 'ntc') && (s.sms.configured
                        ? `On, through ${s.sms.address_host} (${s.sms.method}, ${s.sms.encoding}).`
                        : 'Chosen, but the gateway address is not set.')}
                      {!['off', 'console', 'http', 'ntc'].includes(s.sms.backend) && `Unknown setting "${s.sms.backend}".`}
                    </td></tr>
                    <tr><th>Sender</th><td>{s.sms.sender_id || '—'}</td></tr>
                    <tr><th>Phones asked to verify</th><td>{s.sms.verification_available ? 'Yes' : 'No'}</td></tr>
                  </tbody>
                </table>
                <p className="muted" style={{ fontSize: 12 }}>
                  The gateway is set in the server's .env file (SMS_BACKEND, SMS_HTTP_URL, SMS_HTTP_FIELDS, the sign-in
                  details and SMS_SENDER_ID), then the server is restarted. No code change is needed.
                </p>
                <div className="problem-actions">
                  <input value={testNumber} onChange={(e) => setTestNumber(e.target.value)} placeholder="98XXXXXXXX"
                    style={{ width: 180 }} />
                  <button type="button" className="btn-secondary btn-small" disabled={smsTest.isPending || !testNumber.trim()}
                    onClick={() => smsTest.mutate(testNumber.trim())}>
                    {smsTest.isPending ? 'Sending…' : 'Send a test SMS'}
                  </button>
                  {smsTest.data && <span className={smsTest.data.sent ? 'muted' : 'error'}>{smsTest.data.message}</span>}
                  {smsTest.error && <span className="error">{apiErrorMessage(smsTest.error)}</span>}
                </div>
              </>
            )}
          </section>

          <ComplaintLocation data={data} busy={save.isPending} onSave={(body) => save.mutate(body)} />

          <AttackAlerts data={data} busy={save.isPending}
            onSave={(body) => save.mutate(body)} />

          {s && <InEffect s={s} />}
        </>
      )}
    </div>
  )
}

// Exact positions for the customer's own complaint (2026-10-16). Off by
// default: turning it on is NTC's decision on how subscriber location may
// be used. Emergencies are not affected.
function ComplaintLocation({ data, busy, onSave }: {
  data: SecuritySettings; busy: boolean; onSave: (body: Partial<Omit<SecuritySettings, 'status'>>) => void
}) {
  const [days, setDays] = useState(String(data.complaint_location_days ?? 7))
  const [hours, setHours] = useState(String(data.complaint_location_hours ?? 3))
  useEffect(() => {
    setDays(String(data.complaint_location_days ?? 7))
    setHours(String(data.complaint_location_hours ?? 3))
  }, [data.complaint_location_days, data.complaint_location_hours])
  const dirty = days !== String(data.complaint_location_days ?? 7) || hours !== String(data.complaint_location_hours ?? 3)
  return (
    <section className="sec-card">
      <h2>Customer location for their own complaint</h2>
      <p className="muted">
        The Subscriber Profile always shows the cells and sites a customer used, and their signal. Exact positions
        from the phone are shown only while an emergency is declared. With this switch on, they are also shown for
        readings taken close to a problem report that customer made, so the complaint can be analysed where it
        happened. Each time a position is shown this way, the Audit Log records it with the report. A customer who
        withdrew rescue consent stays hidden either way.
      </p>
      <Switch label="Show exact positions near the customer's own problem report"
        hint="Off by default. Turn on only once NTC has agreed this use of the customer's location."
        on={data.complaint_location_access} busy={busy}
        onChange={(v) => {
          if (v && !window.confirm("Staff with the Subscriber Profile will see exact positions of a customer's readings near that customer's problem reports, without an emergency. Has NTC agreed this?")) return
          onSave({ complaint_location_access: v })
        }} />
      <div className="sec-lists">
        <label>
          Problem reports from the last (days, 1 to 30)
          <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label>
          Readings within this many hours of the report (1 to 24)
          <input type="number" min={1} max={24} value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
      </div>
      <div className="problem-actions">
        <button type="button" className="btn-primary btn-small" disabled={busy || !dirty}
          onClick={() => onSave({ complaint_location_days: Number(days), complaint_location_hours: Number(hours) })}>
          Save
        </button>
      </div>
    </section>
  )
}

// Attack alerts (2026-10-15): when an address is blocked or an account is
// locked after failed logins, tell the superadmins by email, SMS or both.
function AttackAlerts({ data, busy, onSave }: {
  data: SecuritySettings; busy: boolean; onSave: (body: Partial<Omit<SecuritySettings, 'status'>>) => void
}) {
  const test = useAlertTest()
  const [emails, setEmails] = useState(data.alert_extra_emails ?? '')
  const [numbers, setNumbers] = useState(data.alert_extra_numbers ?? '')
  useEffect(() => {
    setEmails(data.alert_extra_emails ?? '')
    setNumbers(data.alert_extra_numbers ?? '')
  }, [data.alert_extra_emails, data.alert_extra_numbers])
  const a = data.status?.alerts
  const smsReady = !!data.status?.sms.sends_real_sms || data.status?.sms.backend === 'console'
  const dirty = emails !== (data.alert_extra_emails ?? '') || numbers !== (data.alert_extra_numbers ?? '')

  return (
    <section className="sec-card">
      <h2>Attack alerts</h2>
      <p className="muted">
        When the system blocks an address after repeated failed logins, or locks an account that reached the
        failed-login limit, it can tell the superadmins at once. Each address or account raises at most one alert an
        hour. Every alert sent is written to the Audit Log.
      </p>
      <Switch label="Send attack alerts" hint="Off: the Audit Log and Blocked IPs pages still show everything."
        on={data.attack_alerts_enabled} busy={busy} onChange={(v) => onSave({ attack_alerts_enabled: v })} />
      <div className="sec-channels">
        <span>Send by</span>
        <label>
          <input type="checkbox" checked={data.alert_by_email} disabled={busy}
            onChange={(e) => onSave({ alert_by_email: e.target.checked })} /> Email
        </label>
        <label>
          <input type="checkbox" checked={data.alert_by_sms} disabled={busy}
            onChange={(e) => onSave({ alert_by_sms: e.target.checked })} /> SMS
        </label>
        {!data.alert_by_email && !data.alert_by_sms && <span className="error">Choose at least one.</span>}
      </div>
      {a && (
        <ul className="sec-notes">
          <li>
            Every superadmin ({a.superadmins}) is told by the email and mobile number on their account (Users page).
          </li>
          {data.alert_by_email && !a.email_configured && (
            <li className="error">No mail server is set (EMAIL_HOST in .env): emails only reach the server log.</li>
          )}
          {data.alert_by_email && a.superadmins_without_email.length > 0 && (
            <li>No email on: {a.superadmins_without_email.join(', ')}.</li>
          )}
          {data.alert_by_sms && !smsReady && (
            <li className="error">No SMS gateway is set up (see Phone number verification above): no SMS is sent.</li>
          )}
          {data.alert_by_sms && a.superadmins_without_mobile.length > 0 && (
            <li>No mobile number on: {a.superadmins_without_mobile.join(', ')}.</li>
          )}
        </ul>
      )}
      <div className="sec-lists">
        <label>
          Also email (comma separated)
          <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="noc@ntc.net.np, ..." />
        </label>
        <label>
          Also send SMS to (comma separated)
          <input value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder="98XXXXXXXX, ..." />
        </label>
      </div>
      <div className="problem-actions">
        <button type="button" className="btn-primary btn-small" disabled={busy || !dirty}
          onClick={() => onSave({ alert_extra_emails: emails, alert_extra_numbers: numbers })}>
          Save recipients
        </button>
        <button type="button" className="btn-secondary btn-small" disabled={test.isPending || dirty}
          onClick={() => test.mutate()}>
          {test.isPending ? 'Sending…' : 'Send a test alert'}
        </button>
        {test.data && (
          <span className="muted">
            Email: {test.data.email ?? 'not sent'} · SMS: {test.data.sms ?? 'not sent'}
          </span>
        )}
        {test.error && <span className="error">{apiErrorMessage(test.error)}</span>}
      </div>
    </section>
  )
}

function Switch({ label, hint, on, busy, onChange }: {
  label: string; hint: string; on: boolean; busy: boolean; onChange: (v: boolean) => void
}) {
  return (
    <label className="sec-switch">
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>{label}</b> <span className={on ? 'sec-on' : 'sec-off'}>{on ? 'On' : 'Off'}</span>
        <small>{hint}</small>
      </span>
    </label>
  )
}

function InEffect({ s }: { s: NonNullable<SecuritySettings['status']> }) {
  const rows: [string, string, boolean][] = [
    ['Browser session login', s.session_login
      ? 'On. Only for development; set API_SESSION_AUTH=0 and DEBUG=0 in production.'
      : 'Off (sign-in by token only).', !s.session_login],
    ['Rate limit, signed in', s.rate_limits.signed_in ? `${s.rate_limits.signed_in} per user` : 'Off', !!s.rate_limits.signed_in],
    ['Rate limit, before sign-in', s.rate_limits.before_sign_in ? `${s.rate_limits.before_sign_in} per address` : 'Off',
      !!s.rate_limits.before_sign_in],
    ['Rate limit, linked systems', s.rate_limits.linked_systems ? `${s.rate_limits.linked_systems} per key` : 'Off',
      !!s.rate_limits.linked_systems],
    ['Linked-system update addresses', `${s.linked_system_https_only ? 'https only' : 'http and https'}; ${
      s.linked_system_hosts.length ? `hosts: ${s.linked_system_hosts.join(', ')}` : 'any host (no allowed-hosts list)'}`,
      s.linked_system_https_only && s.linked_system_hosts.length > 0],
    ['Ticketing system (provisioning on the Subscriber Profile)', !s.provisioning || s.provisioning.backend === 'off'
      ? 'Not linked (set PROVISIONING_BACKEND and the PROVISIONING_* details once the UTS team gives its API)'
      : s.provisioning.backend === 'demo' ? 'Demo data only: not for real customers'
        : s.provisioning.configured ? `Linked, through ${s.provisioning.address_host}` : 'Chosen, but the address is not set',
      !!s.provisioning?.configured && s.provisioning.backend === 'http'],
    ['Debug mode', s.debug ? 'On: must be off in production' : 'Off', !s.debug],
    ['Redirect to https', s.https_redirect ? 'On' : 'Off (set HTTPS_ENABLED=1 once the site is served over https)',
      s.https_redirect],
    ['Shared app upload key', s.shared_upload_key_until
      ? `Accepted until ${new Date(s.shared_upload_key_until).toLocaleString()}`
      : 'Accepted with no end date (set TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL once every phone signs its uploads)',
      !!s.shared_upload_key_until],
  ]
  return (
    <section className="sec-card">
      <h2>Set in the server's configuration</h2>
      <p className="muted">Read-only here; changed in .env and applied by restarting the server.</p>
      <table className="sec-facts">
        <tbody>
          {rows.map(([k, v, good]) => (
            <tr key={k}><th>{k}</th><td><i className={good ? 'sec-dot-ok' : 'sec-dot-warn'} />{v}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
