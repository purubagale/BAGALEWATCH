import DOMPurify from 'dompurify'

// Every HTML string the app puts on a page with dangerouslySetInnerHTML
// goes through here (2026-10-15 security audit). The Markdown it comes from
// is generated from stored text (menu names and descriptions a superadmin
// edits, reports, AI-assisted write-ups), so a <script>, an onerror=
// attribute or a javascript: link in that text would otherwise run in the
// reader's browser with their login. DOMPurify keeps ordinary HTML
// (headings, tables, lists, links, images) and removes everything that can
// run code. The Content-Security-Policy in nginx.conf is the second line of
// defence.
export function safeHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
