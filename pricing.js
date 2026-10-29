/**
 * dsh-cost-meter — pricing rules (pure functions, no I/O).
 *
 * The rate of one call is resolved in three layers; a non-zero field in a higher
 * layer overrides the one below it:
 *   peak price (call started inside a peak window)
 *   > context tier price (prompt exceeds a tier threshold)
 *   > base price
 * A blank (0) field in any layer falls back to the next layer's value.
 *
 * Context length = uncached input + cache reads + cache writes, i.e. the whole prompt
 * sent to the model, matching the vendors' "prompt over N tokens" wording. When it
 * strictly exceeds a threshold, the WHOLE request (input, output and cache) is billed at
 * that tier's rates — not just the part beyond the threshold.
 */

export const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']
export const MAX_TIERS = 4
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Coerce to a number; invalid or negative values count as 0. */
export function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** "HH:MM" -> minutes since midnight; -1 when invalid. */
export function minutesOf(text) {
  const match = TIME_RE.exec(String(text || ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1
}

/** Whether the window covers the UTC minute m; windows may wrap past midnight (e.g. 22:00-06:00). */
function inWindow(m, window) {
  const start = minutesOf(window && window.start)
  const end = minutesOf(window && window.end)
  if (start < 0 || end < 0 || start === end) return false
  return start < end ? m >= start && m < end : m >= start || m < end
}

/** Whether the call's start time (UTC) falls inside a peak window. */
export function isPeakAt(peak, atMs) {
  if (!peak || peak.enabled !== true) return false
  const at = new Date(atMs)
  if (peak.weekdaysOnly !== false) {
    const weekday = at.getUTCDay()
    if (weekday === 0 || weekday === 6) return false
  }
  const m = at.getUTCHours() * 60 + at.getUTCMinutes()
  return (Array.isArray(peak.windows) ? peak.windows : []).some((window) => inWindow(m, window))
}

/**
 * Fold a later `usage` chunk into the earlier ones of the same call. Providers differ: some send one final total,
 * some send the prompt side first and the completion side last (the last chunk then has inputTokens 0 or none).
 * Taking the larger value per counter keeps cumulative totals as they are and no longer loses the other half.
 */
export function mergeUsage(previous, next) {
  if (!previous) return next
  if (!next) return previous
  const merged = Object.assign({}, previous, next)
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (previous[field] !== undefined || next[field] !== undefined) merged[field] = Math.max(num(previous[field]), num(next[field]))
  }
  return merged
}

/** Prompt size of one request: uncached input + cache reads + cache writes (output excluded). */
export function contextTokensOf(usage) {
  return num(usage && usage.inputTokens) + num(usage && usage.cacheReadTokens) + num(usage && usage.cacheWriteTokens)
}

/** The tier with the highest threshold that the context strictly exceeds; undefined if none. */
export function pickTier(tiers, contextTokens) {
  if (!Array.isArray(tiers)) return undefined
  let hit
  for (const tier of tiers) {
    const above = num(tier && tier.above)
    if (above > 0 && contextTokens > above && (!hit || above > num(hit.above))) hit = tier
  }
  return hit
}

/**
 * Cost of one call from the price config, the real usage and the call's start time.
 * Returns { currency, amount, parts, peak, tier }; peak / tier tell whether the call hit a peak
 * window / a context tier. `parts` = the cost of [input, output, cache read, cache write] at the rates
 * that applied, in the same unit as `amount` (their sum is `amount` up to float rounding).
 */
export function priceCall(price, usage, atMs) {
  const peak = isPeakAt(price.peak, atMs)
  const tier = pickTier(price.tiers, contextTokensOf(usage))
  const rate = (field) => {
    if (peak && num(price.peak[field]) > 0) return num(price.peak[field])
    if (tier && num(tier[field]) > 0) return num(tier[field])
    return num(price[field])
  }
  const amount = (
    num(usage.inputTokens) * rate('input')
    + num(usage.outputTokens) * rate('output')
    + num(usage.cacheReadTokens) * rate('cacheRead')
    + num(usage.cacheWriteTokens) * rate('cacheWrite')
  ) / 1_000_000
  const parts = [
    num(usage.inputTokens) * rate('input'),
    num(usage.outputTokens) * rate('output'),
    num(usage.cacheReadTokens) * rate('cacheRead'),
    num(usage.cacheWriteTokens) * rate('cacheWrite'),
  ].map((micro) => micro / 1_000_000)
  return { currency: String(price.currency || 'USD'), amount, parts, peak, tier: tier !== undefined }
}

/** Sanitize a peak config: invalid fields are dropped so the stored shape is always usable. */
export function parsePeak(src) {
  if (!src || typeof src !== 'object') return undefined
  const peak = { enabled: src.enabled === true, weekdaysOnly: src.weekdaysOnly !== false, windows: [] }
  for (const field of PRICE_FIELDS) peak[field] = num(src[field])
  const windows = Array.isArray(src.windows) ? src.windows : []
  for (const window of windows.slice(0, 2)) {
    if (minutesOf(window && window.start) >= 0 && minutesOf(window && window.end) >= 0) {
      peak.windows.push({ start: window.start, end: window.end })
    }
  }
  return peak
}

/**
 * Sanitize context tiers: the threshold (whole tokens) must be positive and unique, a
 * tier must override at least one rate, and the result is sorted ascending by threshold
 * and capped at MAX_TIERS. Anything else is dropped.
 */
export function parseTiers(src) {
  const tiers = []
  const seen = new Set()
  for (const item of Array.isArray(src) ? src : []) {
    const above = Math.round(num(item && item.above))
    if (above <= 0 || seen.has(above)) continue
    const tier = { above }
    for (const field of PRICE_FIELDS) tier[field] = num(item[field])
    if (PRICE_FIELDS.every((field) => tier[field] === 0)) continue
    seen.add(above)
    tiers.push(tier)
  }
  return tiers.sort((a, b) => a.above - b.above).slice(0, MAX_TIERS)
}
