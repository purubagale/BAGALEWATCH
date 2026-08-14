import DtExploreTab from '../components/DtExploreTab'

// Split out of the former single-page DtDataManagerPage.tsx (2026-08-09
// request: "manage upload, manage session and explore in different sub
// menu item... not in different tab on same page") — this page is just
// the old 'explore' tab's content, now its own route. See
// DtUploadPage.tsx/DtSessionHistoryPage.tsx for the other two former
// tabs. DtExploreTab itself renders its own `.dt-explore-tab` wrapper
// with no page heading (it was always meant to be embedded inside a
// page shell that supplies one), so this file supplies that shell.
export default function DtExplorePage() {
  return (
    <div className="admin-page" style={{ maxWidth: 'none' }}>
      <h1>DT Explore</h1>
      <p className="muted">
        Search by coordinates, city, district, or Site ID / cell name to see nearby sites and drive-test coverage.
      </p>
      <DtExploreTab />
    </div>
  )
}
