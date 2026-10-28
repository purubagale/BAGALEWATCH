import { useEffect, useRef } from 'react'

/**
 * Bring a picked session's map into view (2026-10-28; first on Collections,
 * then Telemetry Drive Test and DT Session History, where the list above the
 * map keeps growing).
 *
 * One smooth scroll could stop short: the map, the route fit and the tables
 * under it change the page's height while it glides, and a second scroll when
 * the readings arrive could cut the first off. So for 2.5 s after a pick the
 * target is put back at the top whenever it is not there, and the watch stops
 * as soon as the user scrolls, touches or presses a key.
 *
 * `key` is the picked item (nothing happens while it is empty); `loaded`
 * re-runs the watch once its data has arrived.
 */
export function useScrollToSelection<T extends HTMLElement>(key: unknown, loaded: boolean) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (key == null || key === '') return
    const el = ref.current
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    let stopped = false
    const stop = () => { stopped = true }
    const opts = { passive: true } as const
    window.addEventListener('wheel', stop, opts)
    window.addEventListener('touchstart', stop, opts)
    window.addEventListener('keydown', stop)
    const started = Date.now()
    let lastTop = Number.NaN
    const timer = window.setInterval(() => {
      const node = ref.current
      if (stopped || !node || Date.now() - started > 2500) {
        window.clearInterval(timer)
        return
      }
      const top = node.getBoundingClientRect().top
      // Still gliding (the position moved since the last look): let it finish.
      if (Math.abs(top - lastTop) > 1) { lastTop = top; return }
      if (Math.abs(top - 8) > 4) node.scrollIntoView({ behavior: 'auto', block: 'start' })
      lastTop = top
    }, 150)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchstart', stop)
      window.removeEventListener('keydown', stop)
    }
  }, [key, loaded])
  return ref
}
