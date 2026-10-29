// Pure attribution of logged calls (calllog.js) to one chat turn. Inlined into client.js and imported by tests.
// The Host stamps every call with the turn that was open when it started and keeps a messageId -> turn map from the
// session's assistant/message events, so attribution is a lookup, not a time-window guess.

/** Calls that ran in `turn` (a number); calls outside any turn (title requests, compaction) carry turn=null and never match. */
export function callsOfTurn(calls, turn) {
  if (!Number.isInteger(turn)) return []
  return calls.filter((c) => c.turn === turn)
}

/** The turn an assistant message belongs to, or null when the Host never saw it (older than the cap, or no event). */
export function turnOfMessage(msgs, messageId) {
  if (!msgs || typeof messageId !== 'string') return null
  const turn = msgs[messageId]
  return Number.isInteger(turn) ? turn : null
}

/** The turn number out of a turnTail `turn` prop: either the number itself or a view object carrying `.turn`. */
export function turnNumberOf(turn) {
  if (Number.isInteger(turn)) return turn
  return turn && typeof turn === 'object' && Number.isInteger(turn.turn) ? turn.turn : null
}

/** Totals of a set of calls: costs per currency, tokens, model time, and a per-model breakdown (most expensive first). */
export function summarizeCalls(calls) {
  const out = { calls: calls.length, failed: 0, unpriced: 0, costs: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, wallMs: 0, models: [] }
  const by = {}
  for (const c of calls) {
    const row = by[c.model] || (by[c.model] = { model: c.model, calls: 0, costs: {}, units: 0, media: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    row.calls += 1
    if (!c.ok) out.failed += 1
    if (c.media) { row.media = c.media; row.units += c.units || 0 } else {
      out.input += c.input || 0
      out.output += c.output || 0
      out.cacheRead += c.cacheRead || 0
      out.cacheWrite += c.cacheWrite || 0
      row.input += c.input || 0
      row.output += c.output || 0
      row.cacheRead += c.cacheRead || 0
      row.cacheWrite += c.cacheWrite || 0
      out.wallMs += Math.max(0, (c.end || 0) - (c.at || 0))
    }
    if (c.ok && c.cost !== null && c.cost !== undefined && c.currency) {
      out.costs[c.currency] = (out.costs[c.currency] || 0) + c.cost
      row.costs[c.currency] = (row.costs[c.currency] || 0) + c.cost
    } else if (c.ok) out.unpriced += 1
  }
  const weight = (row) => Object.values(row.costs).reduce((a, b) => a + b, 0)
  out.models = Object.values(by).sort((a, b) => weight(b) - weight(a) || b.calls - a.calls || a.model.localeCompare(b.model))
  return out
}

/** A summary with its total and every model row's costs mapped by `convert` (costs → costs); everything else is shared. */
export function convertSummary(summary, convert) {
  return Object.assign({}, summary, {
    costs: convert(summary.costs),
    models: summary.models.map((m) => Object.assign({}, m, { costs: convert(m.costs) })),
  })
}

/** All tokens the turn moved (input incl. cache, plus output). */
export const turnTokens = (s) => s.input + s.output + s.cacheRead + s.cacheWrite
