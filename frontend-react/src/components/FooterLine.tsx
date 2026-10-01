import { useBranding } from '../api/queries'

// App-wide footer (2026-09-30, "use... footer as style-test in all with
// superadmin controlled text configuration in branding") — shared between
// Layout.tsx (every authenticated page) and LoginPage.tsx (pre-login) so
// both render the SAME configured text instead of two hardcoded copies
// that could drift apart. Same blank-means-default convention as every
// other BrandingSettings text field: an empty `footer_text` falls back to
// a line built from the real, currently-configured app name (never a
// copied placeholder like a different app's "Procurement Management
// System" — see the login-gradient trial page this was ported from,
// which used exactly that wrong text). `footer_developed_by` has no
// fallback text at all when blank — the whole line is omitted rather than
// shown empty, since "Developed By" isn't necessarily accurate for every
// deployment and shouldn't be invented.
export default function FooterLine() {
  const { data: branding } = useBranding()
  const brandName = branding?.app_name || 'DT-WATCH BTS'
  const year = new Date().getFullYear()
  const text = branding?.footer_text || `© ${year} ${brandName} - Nepal Telecom. All rights reserved.`
  const developedBy = branding?.footer_developed_by || ''

  return (
    <footer className="app-footer">
      <div className="app-footer-line">{text}</div>
      {developedBy && (
        <div className="app-footer-line app-footer-developed-by">
          Developed By: <span className="app-footer-developed-by-name">{developedBy}</span>
        </div>
      )}
    </footer>
  )
}
