// Per-model breakdown of one session out of the polled snapshot. Shared by the dock popover and the right-sidebar page,
// inlined into client.js and imported by tests, so it has no dependencies of its own.

const weightOf = (costs) => Object.keys(costs || {}).reduce((sum, cur) => sum + (Number(costs[cur]) || 0), 0)

/**
 * Rows (most expensive first) and totals for session `sessionId`. `convert` optionally maps a costs object into the
 * display currency; it is applied to the session total and to every row, and the order and `share` follow the result.
 * share = the row's part of the session's cost (0–1), or null when nothing was priced.
 */
export function sessionBreakdown(snap, sessionId, convert) {
  const out = { session: null, rows: [], costs: {}, tokens: 0, inTok: 0, cacheRead: 0, calls: 0, failed: 0, unpriced: 0, unpricedModels: [], updatedAt: 0 }
  const session = snap && snap.sessions && sessionId ? snap.sessions[sessionId] : undefined
  if (!session) return out
  const map = typeof convert === 'function' ? convert : (costs) => costs || {}
  out.session = session
  out.costs = map(session.costs)
  out.updatedAt = Number(session.updatedAt) || 0
  for (const model of Object.keys(session.models || {})) {
    const counter = session.models[model]
    const price = (snap.prices && snap.prices[model]) || (snap.presets && snap.presets[model]) || null
    const inTok = counter.inputTokens || 0
    const outTok = counter.outputTokens || 0
    const cacheRead = counter.cacheReadTokens || 0
    const cacheWrite = counter.cacheWriteTokens || 0
    out.unpriced += counter.unpriced || 0
    if (counter.unpriced > 0) out.unpricedModels.push(model)
    out.calls += counter.calls || 0
    out.failed += counter.failed || 0
    out.tokens += inTok + outTok + cacheRead + cacheWrite
    out.inTok += inTok
    out.cacheRead += cacheRead
    out.rows.push({ model, counter, price, costs: map(counter.costs), inTok, outTok, cacheRead, cacheWrite })
  }
  out.rows.sort((a, b) => weightOf(b.costs) - weightOf(a.costs) || a.model.localeCompare(b.model))
  const total = weightOf(out.costs)
  for (const row of out.rows) row.share = total > 0 ? Math.min(1, weightOf(row.costs) / total) : null
  return out
}
