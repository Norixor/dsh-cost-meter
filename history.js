/**
 * Importing past usage from DSH's own session logs, so calls made before the plugin was installed (or while it was off)
 * count too. Only the numbers are read — model, tokens, times — never the conversation text.
 *
 * Logs live under `<root>/--<cwd>--/<session id>/session.v4.jsonl.zstd`: standard concatenated Zstandard frames (one per
 * append batch) of JSONL rows `{ type, seq, time, data }`. Node's one-shot decoder stops after the first frame, so the
 * frames are split here and decoded one by one. The model call that produced a reply is on its `assistant/message` row
 * (`data.usage`, `data.message.source.model`); a context compaction carries its own usage on `compaction/summary`.
 *
 * Nothing may be counted twice, so every call has to pass three gates (see selectCalls):
 *   - it started before the plugin recorded anything for that session (`liveAt`, or the plugin's first record overall for
 *     sessions it never saw): later calls were metered live;
 *   - its seq is above what an earlier import already booked for the session;
 *   - for a session forked from another (`isSeeded`), it comes after the inherited prefix.
 */
import { readdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { DAILY_KEEP_DAYS } from './daily.js'

/** The log generation this reader understands (the current one). Others are counted and skipped, never guessed at. */
export const SUPPORTED_VERSION = 4
export const PROMPTS = ['pending', 'dismissed', 'done']
const MAX_IMPORTED = 5000
// A legacy session entry only knows when its first call ended; calls that started a little earlier were metered live too.
const LEGACY_MARGIN_MS = 120_000
const MAX_TRACKED_SESSIONS = 200
const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_MAGIC = 0x184d2a50

const int = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/** Byte length of the Zstandard frame at `offset`, or -1 when it is truncated or not a frame. */
export function frameLength(buf, offset) {
  if (offset + 4 > buf.length) return -1
  const magic = buf.readUInt32LE(offset)
  if (((magic & SKIPPABLE_MASK) >>> 0) === SKIPPABLE_MAGIC) {
    if (offset + 8 > buf.length) return -1
    const end = offset + 8 + buf.readUInt32LE(offset + 4)
    return end <= buf.length ? end - offset : -1
  }
  if (magic !== ZSTD_MAGIC) return -1
  let p = offset + 4
  if (p >= buf.length) return -1
  const descriptor = buf[p++]
  const singleSegment = (descriptor >> 5) & 1
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][descriptor & 3]
  const sizeFlag = descriptor >> 6
  p += sizeFlag === 0 ? singleSegment : [0, 2, 4, 8][sizeFlag]
  for (;;) {
    if (p + 3 > buf.length) return -1
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    const type = (header >> 1) & 3
    if (type === 3) return -1
    p += 3 + (type === 1 ? 1 : header >> 3)
    if (p > buf.length) return -1
    if (header & 1) break
  }
  if ((descriptor >> 2) & 1) p += 4
  return p <= buf.length ? p - offset : -1
}

/** The text of a log file. A torn final frame (a write in progress) is left out; a damaged complete frame throws. */
export function decodeLog(buf, zstd) {
  if (!zstd) return buf.toString('utf8')
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('zstd-unavailable')
  const parts = []
  for (let offset = 0; offset < buf.length;) {
    const length = frameLength(buf, offset)
    if (length < 0) break
    if (((buf.readUInt32LE(offset) & SKIPPABLE_MASK) >>> 0) !== SKIPPABLE_MAGIC) parts.push(zlib.zstdDecompressSync(buf.subarray(offset, offset + length)))
    offset += length
  }
  return Buffer.concat(parts).toString('utf8')
}

const TYPE_RE = /^\{"type":"([^"]+)"/
const usageOf = (u) => ({
  inputTokens: int(u.inputTokens), outputTokens: int(u.outputTokens), cacheReadTokens: int(u.cacheReadTokens), cacheWriteTokens: int(u.cacheWriteTokens),
})
const hasTokens = (u) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0

/** The call behind one `assistant/message` or `compaction/summary` row, or null when it carries no usable usage. */
function callOf(event) {
  const data = event.data || {}
  if (!data.usage || typeof data.usage !== 'object' || !Number.isFinite(event.time) || !Number.isInteger(event.seq)) return null
  const usage = usageOf(data.usage)
  if (!hasTokens(usage)) return null
  if (event.type === 'compaction/summary') {
    return typeof data.model === 'string' && data.model !== ''
      ? { seq: event.seq, at: event.time, end: event.time, model: data.model, turn: null, messageId: null, usage }
      : null
  }
  const source = data.message && data.message.source
  if (!source || typeof source.model !== 'string' || source.model === '') return null
  // The reply is stamped when it is complete; its first stream chunk is when the model started answering.
  const first = Array.isArray(data.stream) && data.stream.length > 0 && Number.isFinite(data.stream[0].time) ? data.stream[0].time : null
  return {
    seq: event.seq, at: first !== null && first <= event.time ? first : event.time, end: event.time, model: source.model,
    turn: Number.isInteger(data.turn) && data.turn >= 0 ? data.turn : null,
    messageId: typeof data.message.id === 'string' ? data.message.id : null, usage,
  }
}

/**
 * Calls of one log text: `{ id, seeded, seedUnknown, calls }`, or null when it is not a session log. A forked session
 * starts with its parent's events; those end at the last `session/end-seed` row and are not new calls, so they are
 * dropped (and when a seeded log has no such marker nothing is trusted: better to miss a session than to count it twice).
 */
export function parseLog(text) {
  const lines = text.split('\n')
  let header
  try { header = JSON.parse(lines[0]) } catch { return null }
  if (!header || header.type !== 'session' || typeof header.id !== 'string' || header.id === '') return null
  const seeded = header.isSeeded === true
  let seedCut = -1
  const calls = []
  for (let i = 1; i < lines.length; i += 1) {
    const match = TYPE_RE.exec(lines[i])
    if (!match || (match[1] !== 'assistant/message' && match[1] !== 'compaction/summary' && match[1] !== 'session/end-seed')) continue
    let event
    try { event = JSON.parse(lines[i]) } catch { continue }
    if (match[1] === 'session/end-seed') { if (Number.isInteger(event.seq)) seedCut = Math.max(seedCut, event.seq); continue }
    const call = callOf(event)
    if (call) calls.push(call)
  }
  const seedUnknown = seeded && seedCut < 0
  return { id: header.id, seeded, seedUnknown, calls: seedUnknown ? [] : calls.filter((c) => !seeded || c.seq > seedCut) }
}

/** The log of each session directory under `root` at the highest generation; others are only counted. */
export function findLogs(root) {
  const logs = []
  let unsupported = 0
  const dirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] } }
  for (const project of dirs(root)) {
    for (const session of dirs(join(root, project))) {
      const dir = join(root, project, session)
      let best = null
      let names = []
      try { names = readdirSync(dir) } catch { continue }
      for (const name of names) {
        const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
        if (!match) continue
        const version = match[1] === undefined ? 0 : Number(match[1])
        if (!best || version > best.version) best = { file: join(dir, name), version, zstd: match[2] !== undefined }
      }
      if (!best) continue
      if (best.version === SUPPORTED_VERSION) logs.push(best)
      else unsupported += 1
    }
  }
  return { logs, unsupported }
}

/** Calls that may still be booked: seq above the session's import marker and started before its live cutoff. */
export function selectCalls(calls, { after = -1, before = Infinity } = {}) {
  return calls.filter((call) => call.seq > after && call.at < before)
}

/** Legacy session entries (before 0.8) have no `liveAt`: derive it from the first call's end, with a margin. */
export function migrateSessions(sessions) {
  for (const session of Object.values(sessions)) {
    if (!session || session.liveAt === null || Number.isFinite(session.liveAt)) continue
    session.liveAt = Number.isFinite(session.firstAt) ? session.firstAt - LEGACY_MARGIN_MS : 0
  }
}

/**
 * When the plugin first recorded anything, for a state file that predates the history block. Unknown (0, meaning "do not
 * import sessions the plugin has not seen") once old data has been trimmed: the earliest surviving entry would be later
 * than the real start and an import could count trimmed live calls again.
 */
export function legacyFirstLiveAt(sessions, daily) {
  const ids = Object.keys(sessions)
  const days = Object.keys(daily).sort()
  if (ids.length >= MAX_TRACKED_SESSIONS || days.length >= DAILY_KEEP_DAYS) return 0
  const times = ids.map((id) => sessions[id].liveAt).filter(Number.isFinite)
  if (days.length > 0) {
    const [y, m, d] = days[0].split('-').map(Number)
    if (y > 2000) times.push(new Date(y, m - 1, d).getTime())
  }
  return times.length > 0 ? Math.min(...times) : null
}

export const freshHistory = () => ({ prompt: 'pending', firstLiveAt: null, imported: {}, importedCalls: 0, lastImportAt: null })

/** A persisted history block, or a fresh one derived from `legacyFirstLiveAt` when the file has none. */
export function sanitizeHistory(raw, legacyFirst) {
  if (!raw || typeof raw !== 'object') return Object.assign(freshHistory(), { firstLiveAt: legacyFirst })
  const imported = {}
  for (const [id, seq] of Object.entries(raw.imported && typeof raw.imported === 'object' ? raw.imported : {}).slice(-MAX_IMPORTED)) {
    if (Number.isInteger(seq) && seq >= 0) imported[id] = seq
  }
  return {
    prompt: PROMPTS.includes(raw.prompt) ? raw.prompt : 'pending',
    firstLiveAt: Number.isFinite(raw.firstLiveAt) && raw.firstLiveAt >= 0 ? raw.firstLiveAt : null,
    imported,
    importedCalls: Number.isInteger(raw.importedCalls) && raw.importedCalls >= 0 ? raw.importedCalls : 0,
    lastImportAt: Number.isFinite(raw.lastImportAt) ? raw.lastImportAt : null,
  }
}

const yieldToHost = () => new Promise((resolve) => setImmediate(resolve))
const addTo = (bag, key, amount) => { bag[key] = (bag[key] || 0) + amount }

/**
 * Scans and imports. `deps`: `root` (sessions directory), `state` (its `.history` block is read and updated), `sessions`
 * (the plugin's live session table), `price(model, usage, atMs)` (a priced call or null), `book(sessionId, call)` (books
 * one call like a live one and returns its price or null), `persistNow`, `stateFile` (for the pre-import backup).
 */
export function createHistoryService(deps) {
  const { root, state, sessions, price, book, persistNow, stateFile } = deps
  let last = null
  let scanning = false
  let importing = false

  const cutoffOf = (id) => {
    const live = sessions[id] && sessions[id].liveAt
    if (Number.isFinite(live)) return live
    return state.history.firstLiveAt === null ? Infinity : state.history.firstLiveAt
  }

  /** Visit every readable log with the calls that may still be booked; `visit` may be async. */
  async function walk(visit) {
    const { logs, unsupported } = findLogs(root)
    const skipped = { unsupported, damaged: 0, seeded: 0 }
    for (const log of logs) {
      let parsed = null
      try { parsed = parseLog(decodeLog(readFileSync(log.file), log.zstd)) } catch { skipped.damaged += 1 }
      if (parsed) {
        if (parsed.seedUnknown) skipped.seeded += 1
        const calls = selectCalls(parsed.calls, { after: state.history.imported[parsed.id] === undefined ? -1 : state.history.imported[parsed.id], before: cutoffOf(parsed.id) })
        if (calls.length > 0) await visit(parsed.id, calls)
      }
      await yieldToHost()
    }
    return skipped
  }

  async function scan() {
    if (scanning || importing) return last
    scanning = true
    try {
      const summary = { at: Date.now(), sessions: 0, calls: 0, tokens: 0, from: null, to: null, costs: {}, unpriced: 0, models: {} }
      const skipped = await walk((id, calls) => {
        summary.sessions += 1
        for (const call of calls) {
          summary.calls += 1
          summary.tokens += call.usage.inputTokens + call.usage.outputTokens + call.usage.cacheReadTokens + call.usage.cacheWriteTokens
          summary.from = summary.from === null ? call.at : Math.min(summary.from, call.at)
          summary.to = summary.to === null ? call.end : Math.max(summary.to, call.end)
          const priced = price(call.model, call.usage, call.at)
          if (priced) addTo(summary.costs, priced.currency, priced.amount)
          else summary.unpriced += 1
          const row = summary.models[call.model] || (summary.models[call.model] = { model: call.model, calls: 0, costs: {} })
          row.calls += 1
          if (priced) addTo(row.costs, priced.currency, priced.amount)
        }
      })
      last = Object.assign(summary, { skipped, models: Object.values(summary.models).sort((a, b) => b.calls - a.calls).slice(0, 8), legacyPruned: state.history.firstLiveAt === 0 })
      return last
    } finally {
      scanning = false
    }
  }

  async function importAll() {
    if (importing || scanning) return { ok: false, code: 'busy' }
    importing = true
    try {
      persistNow()
      try { copyFileSync(stateFile, stateFile + '.before-import') } catch { /* nothing persisted yet */ }
      const result = { ok: true, code: 'ok', sessions: 0, calls: 0, costs: {}, unpriced: 0 }
      const skipped = await walk((id, calls) => {
        for (const call of calls) {
          const priced = book(id, call)
          if (priced) addTo(result.costs, priced.currency, priced.amount)
          else result.unpriced += 1
        }
        result.sessions += 1
        result.calls += calls.length
        state.history.imported[id] = calls.reduce((top, c) => Math.max(top, c.seq), state.history.imported[id] === undefined ? -1 : state.history.imported[id])
      })
      const keys = Object.keys(state.history.imported)
      if (keys.length > MAX_IMPORTED) for (const key of keys.slice(0, keys.length - MAX_IMPORTED)) delete state.history.imported[key]
      state.history.importedCalls += result.calls
      state.history.lastImportAt = Date.now()
      state.history.prompt = 'done'
      persistNow()
      last = null
      result.skipped = skipped
      return result
    } finally {
      importing = false
    }
  }

  return {
    scan,
    importAll,
    dismiss() { state.history.prompt = 'dismissed' },
    /** What the polled snapshot carries: the prompt state and the last scan summary (null until one has run). */
    snapshot: () => ({
      prompt: state.history.prompt, scan: last, scanning, importing,
      importedCalls: state.history.importedCalls, lastImportAt: state.history.lastImportAt,
    }),
    /** After "reset totals": everything before now is unrecorded history again; the import markers no longer apply. */
    reset() {
      state.history.imported = {}
      state.history.importedCalls = 0
      state.history.lastImportAt = null
      state.history.firstLiveAt = Date.now()
      last = null
    },
  }
}
