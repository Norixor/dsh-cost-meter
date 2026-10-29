// Rule-based observations for the statistics page (pure and self-contained: inlined into client.js and imported by tests).
// Each rule looks only at plain numbers the page has already aggregated, so the same facts drive the text and the tests.

const pct = (part, whole) => (whole > 0 ? part / whole : 0)

/**
 * facts = {
 *   calls, failed, unpriced, peakCalls, tierCalls,       // call counts in view
 *   hit, inputSide,                                      // cache hit rate (0–1 | null) and input + cache-read + cache-write tokens
 *   models, topModel, topShare,                          // distinct models and the biggest one's share of cost (0–1)
 *   latency: { calls, p95Ms, ttftAvgMs, slowCalls },     // slowCalls = calls over 60 s; null when nothing was timed
 * }
 * Returns [{ id, group: 'cost' | 'latency', level: 'warn' | 'info', params }], warnings first.
 * `id` selects the translated sentence; `params` are its placeholders (numbers are already formatted-ready raw values).
 */
export function insightsOf(facts) {
  const out = []
  const add = (id, group, level, params) => out.push({ id, group, level, params })

  if (facts.calls >= 10 && facts.failed >= 3 && pct(facts.failed, facts.calls) >= 0.05) {
    add('failed', 'cost', 'warn', { n: facts.failed, pct: pct(facts.failed, facts.calls) })
  }
  if (facts.unpriced > 0) add('unpriced', 'cost', 'warn', { n: facts.unpriced })
  if (facts.hit !== null && facts.hit < 0.5 && facts.inputSide >= 100_000) add('lowHit', 'cost', 'warn', { pct: facts.hit })
  if (facts.peakCalls > 0) add('peak', 'cost', 'info', { n: facts.peakCalls, pct: pct(facts.peakCalls, facts.calls) })
  if (facts.tierCalls > 0) add('tier', 'cost', 'info', { n: facts.tierCalls, pct: pct(facts.tierCalls, facts.calls) })
  if (facts.models >= 2 && facts.topShare >= 0.8 && facts.topModel) add('concentrated', 'cost', 'info', { model: facts.topModel, pct: facts.topShare })

  const lat = facts.latency
  if (lat && lat.calls >= 5) {
    if (lat.p95Ms !== null && lat.p95Ms >= 30_000) add('slowP95', 'latency', 'warn', { ms: lat.p95Ms })
    if (lat.ttftAvgMs !== null && lat.ttftAvgMs >= 5_000) add('slowFirst', 'latency', 'warn', { ms: lat.ttftAvgMs })
    if (lat.slowCalls > 0) add('longCalls', 'latency', 'info', { n: lat.slowCalls })
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1))
}
