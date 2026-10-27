// Run: node --test test/history.test.mjs
// Importing past usage from DSH's session logs (history.js) and its wiring in index.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { decodeLog, frameLength, findLogs, legacyFirstLiveAt, migrateSessions, parseLog, sanitizeHistory, selectCalls } from '../history.js'
import { startHost } from './host-harness.mjs'

const DAY = 86_400_000
const usage = (input, output = 0, cacheRead = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, totalTokens: input + output + cacheRead })
const msg = (seq, time, over = {}) => ({
  type: 'assistant/message', seq, time,
  data: {
    turn: over.turn === undefined ? 1 : over.turn, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'SECRET reply text' }], source: { kind: 'model', provider: 'p', model: over.model === undefined ? 'm1' : over.model }, id: over.id || 'msg-' + seq },
    usage: over.usage === undefined ? usage(1000, 100) : over.usage,
    stream: over.streamAt === undefined ? [] : [{ type: 'chunk', time: over.streamAt }],
  },
})
const compaction = (seq, time, over = {}) => ({ type: 'compaction/summary', seq, time, data: { compactionId: 'c', summary: [], provider: 'p', model: over.model || 'm1', usage: usage(5000, 200) } })
const header = (id, over = {}) => ({ type: 'session', version: 4, id, createdAt: 1, cwd: '/x', isSeeded: false, delegationDepth: 0, agentPreset: 'standard', ...over })
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'

/** A compressed log of several frames (the first holds only the header, like DSH's own files). */
const zstdLog = (rows, perFrame = 2) => {
  const frames = [zlib.zstdCompressSync(Buffer.from(lines([rows[0]])))]
  for (let i = 1; i < rows.length; i += perFrame) frames.push(zlib.zstdCompressSync(Buffer.from(lines(rows.slice(i, i + perFrame)))))
  return Buffer.concat(frames)
}

test('decodeLog reads every frame, skips a torn tail and skippable frames, and reads raw text as is', () => {
  const rows = [header('s'), msg(1, 10), msg(2, 20), msg(3, 30), msg(4, 40)]
  const file = zstdLog(rows)
  assert.equal(decodeLog(file, true), lines(rows))
  // The one-shot decoder would stop after the first frame: that is why frames are split.
  assert.equal(zlib.zstdDecompressSync(file).toString().split('\n').filter(Boolean).length, 1)
  const extra = zlib.zstdCompressSync(Buffer.from(lines([msg(5, 50)])))
  const torn = Buffer.concat([file, extra.subarray(0, extra.length - 3)])
  assert.equal(decodeLog(torn, true), lines(rows), 'the incomplete last frame carries nothing')
  const skippable = Buffer.alloc(8 + 3)
  skippable.writeUInt32LE(0x184d2a50, 0)
  skippable.writeUInt32LE(3, 4)
  assert.equal(decodeLog(Buffer.concat([file, skippable]), true), lines(rows))
  assert.equal(decodeLog(Buffer.from(lines(rows)), false), lines(rows))
  assert.equal(frameLength(Buffer.from('not zstd at all'), 0), -1)
  assert.equal(frameLength(file, 0) > 0, true)
})

test('decodeLog handles frames with a content checksum', (t) => {
  const flag = zlib.constants && zlib.constants.ZSTD_c_checksumFlag
  if (flag === undefined) { t.skip('no checksum flag in this Node'); return }
  const rows = [header('s'), msg(1, 10)]
  const file = Buffer.concat(rows.map((row) => zlib.zstdCompressSync(Buffer.from(lines([row])), { params: { [flag]: 1 } })))
  assert.equal(decodeLog(file, true), lines(rows))
})

test('parseLog takes usage, model, turn and message id from replies and compactions, and never the text', () => {
  const log = lines([
    header('session-a'),
    msg(1, 1000, { streamAt: 900, turn: 2, id: 'm-one' }),
    msg(2, 2000, { usage: null }),
    msg(3, 3000, { usage: usage(0, 0) }),
    msg(4, 4000, { model: '' }),
    compaction(5, 5000, { model: 'm2' }),
    { type: 'tool/call', seq: 6, time: 6000, data: {} },
  ]) + '{"type":"assistant/message","seq":7,"time":'
  const parsed = parseLog(log)
  assert.equal(parsed.id, 'session-a')
  assert.deepEqual(parsed.calls.map((c) => [c.seq, c.model, c.at, c.end, c.turn, c.messageId]), [
    [1, 'm1', 900, 1000, 2, 'm-one'],
    [5, 'm2', 5000, 5000, null, null],
  ])
  assert.deepEqual(parsed.calls[0].usage, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal(JSON.stringify(parsed).includes('SECRET'), false)
  assert.equal(parseLog('not json\n'), null)
  assert.equal(parseLog(lines([{ type: 'session', version: 4 }])), null)
})

test('a forked session counts only what comes after the inherited prefix; without a marker nothing is trusted', () => {
  const rows = (extra) => [header('child', extra), msg(1, 10), msg(2, 20), { type: 'session/end-seed', seq: 3, time: 25, data: {} }, msg(4, 30)]
  assert.deepEqual(parseLog(lines(rows({ isSeeded: true }))).calls.map((c) => c.seq), [4])
  assert.deepEqual(parseLog(lines(rows({ isSeeded: false }))).calls.map((c) => c.seq), [1, 2, 4], 'markers in an ordinary session change nothing')
  const noMarker = parseLog(lines([header('child', { isSeeded: true }), msg(1, 10)]))
  assert.deepEqual([noMarker.calls.length, noMarker.seedUnknown], [0, true])
})

test('selectCalls keeps calls above the import marker that started before the live cutoff', () => {
  const calls = [{ seq: 1, at: 10 }, { seq: 2, at: 20 }, { seq: 3, at: 30 }]
  assert.deepEqual(selectCalls(calls).map((c) => c.seq), [1, 2, 3])
  assert.deepEqual(selectCalls(calls, { after: 1, before: 30 }).map((c) => c.seq), [2])
  assert.deepEqual(selectCalls(calls, { before: 10 }), [])
})

test('legacy state: session entries get a live-start estimate, and trimmed state turns imports of unknown sessions off', () => {
  const sessions = { a: { firstAt: 1_000_000 }, b: { firstAt: 900_000, liveAt: null }, c: {} }
  migrateSessions(sessions)
  assert.equal(sessions.a.liveAt, 880_000)
  assert.equal(sessions.b.liveAt, null, 'an imported-only entry keeps null')
  assert.equal(sessions.c.liveAt, 0, 'no usable start: import nothing for it')
  assert.equal(legacyFirstLiveAt({ a: { liveAt: 500 }, b: { liveAt: 300 } }, {}), 300)
  assert.equal(legacyFirstLiveAt({}, {}), null)
  const day = new Date(2026, 9, 20).getTime()
  assert.equal(legacyFirstLiveAt({ a: { liveAt: day + 5 * 3600_000 } }, { '2026-10-20': {} }), day)
  assert.equal(legacyFirstLiveAt(Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['s' + i, { liveAt: 1 }])), {}), 0)
  assert.equal(legacyFirstLiveAt({}, Object.fromEntries(Array.from({ length: 90 }, (_, i) => ['2026-01-' + i, {}]))), 0)
})

test('sanitizeHistory keeps legal fields, falls back to the legacy estimate for a missing block', () => {
  assert.deepEqual(sanitizeHistory(undefined, 42), { prompt: 'pending', firstLiveAt: 42, imported: {}, importedCalls: 0, lastImportAt: null })
  const clean = sanitizeHistory({ prompt: 'done', firstLiveAt: 7, imported: { a: 3, b: -1, c: 'x', d: 1.5 }, importedCalls: 9, lastImportAt: 8, extra: 1 }, 42)
  assert.deepEqual(clean, { prompt: 'done', firstLiveAt: 7, imported: { a: 3 }, importedCalls: 9, lastImportAt: 8 })
  assert.equal(sanitizeHistory({ prompt: 'weird', firstLiveAt: 'x' }, 42).prompt, 'pending')
  assert.equal(sanitizeHistory({}, 42).firstLiveAt, null, 'an existing block is never overridden by the estimate')
})

// ---- the Host half, against fixture logs under the throw-away $DSH_HOME ----

const sessionsDir = (home) => join(home, 'sessions')
function writeLog(home, id, rows, { version = 4, raw = false, perFrame = 2 } = {}) {
  const dir = join(sessionsDir(home), '--proj--', id)
  mkdirSync(dir, { recursive: true })
  const name = 'session.v' + version + '.jsonl' + (raw ? '' : '.zstd')
  writeFileSync(join(dir, name), raw ? lines(rows) : zstdLog(rows, perFrame))
}
const setPrice = (host) => host.post({ action: 'set-price', model: 'm1', currency: 'CNY', input: 1, output: 2, cacheRead: 0.5 })

test('findLogs picks the highest generation per session and counts the ones it cannot read', async () => {
  const host = await startHost()
  rmSync(sessionsDir(host.home), { recursive: true, force: true })
  writeLog(host.home, 'session-new', [header('session-new'), msg(1, 10)])
  writeLog(host.home, 'session-new', [header('session-new'), msg(1, 10)], { version: 3 })
  writeLog(host.home, 'session-raw', [header('session-raw'), msg(1, 10)], { raw: true })
  writeLog(host.home, 'session-old', [header('session-old')], { version: 2 })
  const { logs, unsupported } = findLogs(sessionsDir(host.home))
  assert.deepEqual(logs.map((l) => [l.version, l.zstd]).sort(), [[4, false], [4, true]])
  assert.equal(unsupported, 1)
  assert.deepEqual(findLogs(join(host.home, 'nowhere')), { logs: [], unsupported: 0 })
  host.dispose()
})

test('host: scan previews, import books the calls like live ones, and a second import adds nothing', async () => {
  const host = await startHost()
  rmSync(sessionsDir(host.home), { recursive: true, force: true })
  const t0 = Date.now() - 5 * DAY
  writeLog(host.home, 'session-a', [header('session-a'), msg(1, t0, { usage: usage(1_000_000, 500_000, 1_000_000), id: 'reply-1' }), msg(2, t0 + 60_000, { model: 'mystery', turn: 2 }), compaction(3, t0 + 120_000)])
  writeLog(host.home, 'session-b', [header('session-b'), msg(1, Date.now() - 200 * DAY)])
  await setPrice(host)

  const scan = await host.post({ action: 'history-scan' })
  assert.equal(scan.ok, true)
  assert.deepEqual([scan.history.scan.sessions, scan.history.scan.calls, scan.history.scan.unpriced], [2, 4, 1])
  assert.ok(Math.abs(scan.history.scan.costs.CNY - (2.5 + 0.0054 + 0.0012)) < 1e-9, JSON.stringify(scan.history.scan.costs))
  assert.equal(host.get().models.m1, undefined, 'a scan books nothing')

  const first = await host.post({ action: 'history-import' })
  assert.deepEqual([first.ok, first.calls, first.sessions, first.unpriced], [true, 4, 2, 1])
  assert.equal(existsSync(join(host.home, 'cost-meter.json.before-import')), true, 'the state is backed up before an import')
  const snap = host.get()
  assert.equal(snap.models.m1.calls, 3)
  assert.equal(snap.models.mystery.unpriced, 1)
  assert.equal(snap.sessions['session-a'].models.m1.calls, 2, 'the compaction is booked under the same session')
  assert.equal(snap.sessions['session-a'].liveAt, null, 'an imported-only session has no live start yet')
  assert.equal(snap.sessions['session-a'].firstAt, t0)
  assert.equal(snap.history.prompt, 'done')
  assert.equal(snap.history.importedCalls, 4)

  const stats = await host.post({ action: 'stats' })
  assert.equal(Object.keys(stats.daily).length, 1, 'only the recent day gets a daily bucket; the 200-day-old call is in the totals only')
  const labels = await host.post({ action: 'calls', sessionId: 'session-a' })
  assert.equal(labels.msgs['reply-1'], 1, 'imported replies get their message labels')
  assert.equal(labels.calls.length, 3)

  const again = await host.post({ action: 'history-import' })
  assert.deepEqual([again.ok, again.calls, again.sessions], [true, 0, 0])
  assert.equal(host.get().models.m1.calls, 3)
  host.dispose()
})

test('host: calls the plugin metered itself are never imported again', async () => {
  const host = await startHost()
  rmSync(sessionsDir(host.home), { recursive: true, force: true })
  await setPrice(host)
  const before = Date.now() - 2 * 3600_000
  const after = Date.now() + 3600_000
  // Session "live" was metered by the plugin from now on; its log holds an older call and a call from the live period.
  await host.call({ model: 'm1', sessionId: 'live', usage: usage(1000, 100) })
  writeLog(host.home, 'live', [header('live'), msg(1, before), msg(2, after)])
  // A session the plugin never saw: calls after its first record anywhere are not history either.
  writeLog(host.home, 'stranger', [header('stranger'), msg(1, before), msg(2, after)])
  const result = await host.post({ action: 'history-import' })
  assert.deepEqual([result.calls, result.sessions], [2, 2])
  const snap = host.get()
  assert.equal(snap.sessions.live.models.m1.calls, 2, 'one live call plus the one older call')
  assert.equal(snap.sessions.stranger.models.m1.calls, 1)
  assert.ok(snap.sessions.live.liveAt > 0)
  assert.equal(snap.history.importedCalls, 2)
  host.dispose()
})

test('host: a forked session is not counted twice, and an unsupported log is reported, not guessed', async () => {
  const host = await startHost()
  rmSync(sessionsDir(host.home), { recursive: true, force: true })
  const t0 = Date.now() - DAY
  writeLog(host.home, 'parent', [header('parent'), msg(1, t0), msg(2, t0 + 1000)])
  writeLog(host.home, 'fork', [header('fork', { isSeeded: true }), msg(1, t0), msg(2, t0 + 1000), { type: 'session/end-seed', seq: 3, time: t0 + 2000, data: {} }, msg(4, t0 + 3000)])
  writeLog(host.home, 'blind', [header('blind', { isSeeded: true }), msg(1, t0)])
  writeLog(host.home, 'old', [header('old')], { version: 2 })
  mkdirSync(join(sessionsDir(host.home), '--proj--', 'broken'), { recursive: true })
  writeFileSync(join(sessionsDir(host.home), '--proj--', 'broken', 'session.v4.jsonl.zstd'), Buffer.concat([zlib.zstdCompressSync(Buffer.from(lines([header('broken')]))), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00, 0x01, 0x00, 0x00, 0x99, 0x99, 0x99, 0x99])]))
  const scan = await host.post({ action: 'history-scan' })
  assert.deepEqual([scan.history.scan.sessions, scan.history.scan.calls], [2, 3])
  assert.deepEqual(scan.history.scan.skipped, { unsupported: 1, damaged: 1, seeded: 1 })
  host.dispose()
})

test('host: dismissing the question, and a reset that makes the whole history importable again', async () => {
  const host = await startHost()
  rmSync(sessionsDir(host.home), { recursive: true, force: true })
  writeLog(host.home, 'a', [header('a'), msg(1, Date.now() - DAY)])
  assert.equal(host.get().history.prompt, 'pending')
  assert.equal((await host.post({ action: 'history-dismiss' })).history.prompt, 'dismissed')
  assert.equal((await host.post({ action: 'history-import' })).calls, 1, 'dismissing only hides the question; a manual import still works')
  assert.equal((await host.post({ action: 'history-import' })).calls, 0)
  await host.post({ action: 'reset-totals' })
  assert.equal(host.get().history.importedCalls, 0)
  assert.equal((await host.post({ action: 'history-import' })).calls, 1, 'after a reset the log is history again')
  host.dispose()
})
