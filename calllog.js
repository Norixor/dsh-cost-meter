/**
 * Recent finished calls per session, attributed to chat turns (pure functions, unit-tested).
 *
 * The chat UI shows a cost label under an assistant message and a summary line above it. A model call carries no turn
 * or message id, but the host's `session/event` stream does (turn/start, turn/end, assistant/message). The Host half
 * therefore remembers which turn is open per session, stamps every call it logs with that turn number, and keeps a
 * `messageId -> turn` map from the assistant/message events. The browser half looks a message up in that map and sums
 * the calls of its turn. The log is deliberately small (recent sessions only): it labels messages you are looking at
 * and is not a second ledger.
 *
 * Per session: { at, calls: [entry...], msgs: { [messageId]: turn } }.
 * Entry fields:
 *   at, end        epoch ms the call started / finished
 *   turn           turn number the call ran in, or null (e.g. a title request after the turn ended)
 *   model, ok      model id; ok=false for calls that ended without usage (error / aborted)
 *   cost, currency price locked at write time, or cost=null when the model had no price yet
 *   parts          [input, output, cache read, cache write] share of `cost`, or null (unpriced, or logged before it existed)
 *   input, output, cacheRead, cacheWrite   token counts (input = uncached input)
 *   ttftMs         time to first content chunk, or null
 *   media, units   only for metered image / speech tool calls: the kind and the quantity
 */

export const CALLS_PER_SESSION = 80
export const MESSAGES_PER_SESSION = 200
export const CALL_LOG_SESSIONS = 20

const int = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
const turnOf = (value) => (Number.isInteger(value) && value >= 0 ? value : null)

function sessionLog(log, sessionId) {
  return log[sessionId] || (log[sessionId] = { at: 0, calls: [], msgs: {} })
}

/** Drop the least recently active sessions beyond the limit. */
function trimSessions(log) {
  const ids = Object.keys(log)
  if (ids.length > CALL_LOG_SESSIONS) {
    ids.sort((a, b) => log[a].at - log[b].at).slice(0, ids.length - CALL_LOG_SESSIONS).forEach((id) => { delete log[id] })
  }
}

/** Append `entry` to the session's log and drop the oldest calls beyond the cap. */
export function appendCall(log, sessionId, entry) {
  const s = sessionLog(log, sessionId)
  s.calls.push(entry)
  if (s.calls.length > CALLS_PER_SESSION) s.calls.splice(0, s.calls.length - CALLS_PER_SESSION)
  s.at = Math.max(s.at, entry.end)
  trimSessions(log)
  return log
}

/** Remember which turn an assistant message belongs to (oldest entries are dropped beyond the cap). */
export function appendMessage(log, sessionId, messageId, turn, now) {
  if (typeof messageId !== 'string' || messageId === '' || turnOf(turn) === null) return log
  const s = sessionLog(log, sessionId)
  delete s.msgs[messageId]
  s.msgs[messageId] = turn
  const ids = Object.keys(s.msgs)
  if (ids.length > MESSAGES_PER_SESSION) ids.slice(0, ids.length - MESSAGES_PER_SESSION).forEach((id) => { delete s.msgs[id] })
  s.at = Math.max(s.at, now)
  trimSessions(log)
  return log
}

/** Sanitise a persisted log: malformed entries are dropped, limits re-applied. */
export function sanitizeCallLog(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const id of Object.keys(raw)) {
    const s = raw[id]
    if (!s || typeof s !== 'object' || !Array.isArray(s.calls)) continue
    const calls = s.calls.filter((e) => e && typeof e === 'object' && Number.isFinite(e.at) && Number.isFinite(e.end) && typeof e.model === 'string')
      .map((e) => {
        const entry = {
          at: e.at, end: e.end, turn: turnOf(e.turn), model: e.model, ok: e.ok !== false,
          cost: Number.isFinite(e.cost) ? e.cost : null, currency: typeof e.currency === 'string' ? e.currency.slice(0, 3) : '',
          input: int(e.input), output: int(e.output), cacheRead: int(e.cacheRead), cacheWrite: int(e.cacheWrite),
          ttftMs: Number.isFinite(e.ttftMs) ? e.ttftMs : null,
        }
        if (Array.isArray(e.parts) && e.parts.length === 4 && e.parts.every((v) => Number.isFinite(v) && v >= 0)) entry.parts = e.parts.slice()
        if (typeof e.media === 'string') { entry.media = e.media.slice(0, 12); entry.units = Number.isFinite(e.units) ? e.units : 0 }
        return entry
      })
      .sort((a, b) => a.end - b.end)
    const msgs = {}
    if (s.msgs && typeof s.msgs === 'object') {
      for (const messageId of Object.keys(s.msgs).slice(-MESSAGES_PER_SESSION)) if (turnOf(s.msgs[messageId]) !== null) msgs[messageId] = s.msgs[messageId]
    }
    if (calls.length === 0 && Object.keys(msgs).length === 0) continue
    out[id] = { at: Number.isFinite(s.at) ? s.at : 0, calls: calls.slice(-CALLS_PER_SESSION), msgs }
  }
  trimSessions(out)
  return out
}
