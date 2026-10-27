// Pure peak / off-peak status for the dock strip and the right-sidebar page. Inlined into client.js and imported by tests.
// It answers the question the billing code answers per call: "would a call that starts at this instant be priced at the
// peak rate?" The window test below mirrors isPeakAt() in pricing.js (the browser half cannot import it); the test suite
// compares the two over a grid of instants so they cannot drift apart.

const PEAK_MINUTE_MS = 60000
const PEAK_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
// A weekday-only schedule flips at least once a week; one extra day of slack.
const PEAK_SEARCH_DAYS = 8
const PEAK_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']

/** "HH:MM" -> minutes since midnight; -1 when invalid. */
export function clockMinutes(text) {
  const match = PEAK_TIME_RE.exec(String(text || ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1
}

/** The windows that can ever match: both ends valid and not equal (an empty window never matches). */
function usableWindows(peak) {
  return (Array.isArray(peak && peak.windows) ? peak.windows : [])
    .filter((w) => clockMinutes(w && w.start) >= 0 && clockMinutes(w && w.end) >= 0 && clockMinutes(w.start) !== clockMinutes(w.end))
}

/** Whether the schedule is switched on and has at least one usable window. */
export const hasPeakWindows = (peak) => !!peak && peak.enabled === true && usableWindows(peak).length > 0

/** UTC instant `atMs` inside a peak window? Windows may wrap past midnight; weekdaysOnly (default on) skips Sat/Sun in UTC. */
export function isPeakNow(peak, atMs) {
  if (!peak || peak.enabled !== true) return false
  const at = new Date(atMs)
  if (peak.weekdaysOnly !== false) {
    const weekday = at.getUTCDay()
    if (weekday === 0 || weekday === 6) return false
  }
  const m = at.getUTCHours() * 60 + at.getUTCMinutes()
  return usableWindows(peak).some((w) => {
    const start = clockMinutes(w.start)
    const end = clockMinutes(w.end)
    return start < end ? m >= start && m < end : m >= start || m < end
  })
}

/**
 * Status at `nowMs`: `peak` is the state now and `changeAt` the first whole minute (epoch ms) at which it flips, or null
 * when it never does within the search horizon (no windows). Walks minute by minute with isPeakNow(), so weekends and
 * windows that wrap midnight need no special cases here.
 */
export function peakState(peak, nowMs) {
  const start = Math.floor(nowMs / PEAK_MINUTE_MS) * PEAK_MINUTE_MS
  const peakNow = isPeakNow(peak, start)
  if (!hasPeakWindows(peak)) return { peak: peakNow, changeAt: null }
  for (let k = 1; k <= PEAK_SEARCH_DAYS * 1440; k++) {
    const at = start + k * PEAK_MINUTE_MS
    if (isPeakNow(peak, at) !== peakNow) return { peak: peakNow, changeAt: at }
  }
  return { peak: peakNow, changeAt: null }
}

/** "45m", "1h 20m", "2h", "2d 3h": time left, rounded up to the minute so it never reads 0 while a minute remains. */
export function formatCountdown(ms) {
  const minutes = Math.max(1, Math.ceil(ms / PEAK_MINUTE_MS))
  if (minutes < 60) return minutes + 'm'
  if (minutes < 1440) return Math.floor(minutes / 60) + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '')
  const hours = Math.floor((minutes % 1440) / 60)
  return Math.floor(minutes / 1440) + 'd' + (hours ? ' ' + hours + 'h' : '')
}

/** The windows as "09:00–12:00 · 14:00–18:00", shifted by `offsetMinutes` from UTC (0 = UTC, +480 = UTC+8). */
export function windowsText(peak, offsetMinutes) {
  const shift = (text) => {
    const m = (((clockMinutes(text) + (offsetMinutes || 0)) % 1440) + 1440) % 1440
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
  }
  return usableWindows(peak).map((w) => shift(w.start) + '–' + shift(w.end)).join(' · ')
}

/**
 * Peak price / normal price when every rate that has both agrees (DeepSeek: all 2), else null. A peak field left blank
 * falls back to the normal price in billing, so it carries no ratio and is skipped.
 */
export function peakMultiplier(price) {
  const peak = price && price.peak
  if (!peak) return null
  let ratio = null
  for (const field of PEAK_FIELDS) {
    const normal = Number(price[field])
    const raised = Number(peak[field])
    if (!(normal > 0) || !(raised > 0)) continue
    const r = raised / normal
    if (ratio === null) ratio = r
    else if (Math.abs(r - ratio) > 1e-6) return null
  }
  return ratio
}

/** Effective prices by model, as billing looks them up: a saved price replaces the preset of the same name as a whole. */
const effectivePrices = (snap) => Object.assign({}, snap && snap.presets, snap && snap.prices)

/**
 * The distinct peak schedules that apply to a session, each with the models that share it. Which models count:
 * the ones this session has called; before its first call, the ones seen anywhere; on a fresh install, every priced model.
 */
export function peakSchedules(snap, sessionId) {
  const prices = effectivePrices(snap)
  const session = snap && snap.sessions && sessionId ? snap.sessions[sessionId] : undefined
  const pools = [
    Object.keys((session && session.models) || {}),
    Object.keys((snap && snap.models) || {}).filter((name) => ((snap.models[name] && snap.models[name].calls) || 0) > 0),
    Object.keys(prices),
  ]
  return groupSchedules(prices, pools.find((pool) => pool.length > 0) || [])
}

/** Every distinct peak schedule among all priced models, used or not (the settings page lists what is configured). */
export function allPeakSchedules(snap) {
  const prices = effectivePrices(snap)
  return groupSchedules(prices, Object.keys(prices))
}

/** Group `names` by identical schedule; a group keeps a price ratio only while all its models agree on it. */
function groupSchedules(prices, names) {
  const groups = new Map()
  for (const model of names) {
    const price = prices[model]
    const peak = price && price.peak
    if (!hasPeakWindows(peak)) continue
    const key = (peak.weekdaysOnly !== false ? 'w' : 'a') + '|' + usableWindows(peak).map((w) => w.start + '-' + w.end).join(',')
    const multiplier = peakMultiplier(price)
    const group = groups.get(key)
    if (!group) groups.set(key, { key, peak, models: [model], multiplier })
    else {
      group.models.push(model)
      if (group.multiplier !== multiplier) group.multiplier = null
    }
  }
  return Array.from(groups.values())
}
