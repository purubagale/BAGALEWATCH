// Same mobile number however it is written (2026-10-15): "+977 9851-113656",
// "9779851113656" and "9851113656" all match. Nepal mobile numbers are 10
// digits, so the last 10 digits are compared. Used where a page opened from
// a Subscriber Profile shows only that number's rows (?msisdn=).
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = (a ?? '').replace(/\D/g, '')
  const db = (b ?? '').replace(/\D/g, '')
  if (da.length < 7 || db.length < 7) return false
  return da.slice(-10) === db.slice(-10)
}
