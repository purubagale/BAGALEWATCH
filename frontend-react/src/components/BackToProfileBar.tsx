import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { OPAQUE_PATHS } from '../constants/opaqueRoutes'

// "Back to …" bar (2026-10-15). A page opened from the Subscriber Network
// Diagnosis Dashboard, or (2026-10-26) from a complaint on the Problem
// Dashboard, carries `?back=<that address>`; this bar, shown by Layout on
// every page, leads back with the search intact. Only an address on one of
// those two pages is accepted, so the link can never point elsewhere.
function within(back: string, page: string | undefined) {
  return !!page && (back === page || back.startsWith(`${page}?`))
}

export default function BackToProfileBar() {
  const [params] = useSearchParams()
  const location = useLocation()
  // The site page shows its own "← Back to …" link in place of "Back to sites".
  if (location.pathname.startsWith('/sites/')) return null
  const back = params.get('back') ?? ''
  const query = new URLSearchParams(back.split('?')[1] ?? '')
  if (within(back, OPAQUE_PATHS['/subscriber-profile'])) {
    const number = query.get('msisdn')
    return (
      <div className="sp-backbar">
        <Link to={back}>← Back to Subscriber Network Diagnosis{number ? ` · ${number}` : ''}</Link>
        <span>Opened from the subscriber network diagnosis dashboard</span>
      </div>
    )
  }
  if (within(back, OPAQUE_PATHS['/problem-reports'])) {
    const report = query.get('report')
    return (
      <div className="sp-backbar">
        <Link to={back}>← Back to the complaint{report ? ` PR-${report}` : ''}</Link>
        <span>Opened from the Problem Dashboard</span>
      </div>
    )
  }
  return null
}
