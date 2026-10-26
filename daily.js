/**
 * Per-day usage buckets behind the statistics page.
 *
 * Shape: { 'YYYY-MM-DD': { '<model>': counter } } where a counter has the same fields as
 * the all-time model counters. Days are keyed by the Host's local calendar date of the
 * call start, which is also the date the user sees on screen (the app runs locally).
 */
export const DAILY_KEEP_DAYS = 90

const pad = (n) => String(n).padStart(2, '0')

/** Local calendar date of a timestamp as `YYYY-MM-DD`. */
export function dayKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** Local hour of day, 0–23. */
export const hourOf = (ms) => new Date(ms).getHours()

/** Drop days older than the retention window (keys sort lexicographically as dates). */
export function pruneDaily(daily, nowMs) {
  const keys = Object.keys(daily)
  if (keys.length <= DAILY_KEEP_DAYS) return
  const oldest = dayKey(nowMs - (DAILY_KEEP_DAYS - 1) * 86_400_000)
  for (const key of keys) if (key < oldest) delete daily[key]
}

/** Earliest recorded day, or null when nothing has been recorded yet. */
export function firstDay(daily) {
  const keys = Object.keys(daily).sort()
  return keys.length > 0 ? keys[0] : null
}
