import { Link, useSearchParams } from 'react-router-dom'
import { OPAQUE_PATHS } from '../constants/opaqueRoutes'

// "Back to Subscriber Profile" (2026-10-15). A page opened from a profile
// carries `?back=<profile address>`; this bar, shown by Layout on every page,
// leads back to that profile with its search intact. Only an address on the
// profile page itself is accepted, so the link can never point elsewhere.
export default function BackToProfileBar() {
  const [params] = useSearchParams()
  const back = params.get('back') ?? ''
  const profile = OPAQUE_PATHS['/subscriber-profile']
  if (!profile || !(back === profile || back.startsWith(`${profile}?`))) return null
  const number = new URLSearchParams(back.split('?')[1] ?? '').get('msisdn')
  return (
    <div className="sp-backbar">
      <Link to={back}>← Back to Subscriber Network Diagnosis{number ? ` · ${number}` : ''}</Link>
      <span>Opened from the subscriber network diagnosis dashboard</span>
    </div>
  )
}
