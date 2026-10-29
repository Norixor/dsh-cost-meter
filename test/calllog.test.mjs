// Run: node --test test/calllog.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { CALLS_PER_SESSION, CALL_LOG_SESSIONS, MESSAGES_PER_SESSION, appendCall, appendMessage, sanitizeCallLog } from '../calllog.js'
import { startHost } from './host-harness.mjs'

const entry = (end, over = {}) => ({ at: end - 500, end, turn: 1, model: 'm', ok: true, cost: 0.01, currency: 'USD', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ttftMs: 100, ...over })

test('appendCall keeps the newest calls per session and the most recently active sessions', () => {
  const log = {}
  for (let i = 0; i < CALLS_PER_SESSION + 5; i += 1) appendCall(log, 's0', entry(1000 + i))
  assert.equal(log.s0.calls.length, CALLS_PER_SESSION)
  assert.equal(log.s0.calls[0].end, 1005)
  for (let s = 1; s <= CALL_LOG_SESSIONS; s += 1) appendCall(log, 's' + s, entry(5000 + s))
  assert.equal(Object.keys(log).length, CALL_LOG_SESSIONS)
  assert.equal(log.s0, undefined, 'the session idle the longest is dropped')
})

test('appendMessage maps message ids to turns, ignores junk and drops the oldest ids beyond the cap', () => {
  const log = {}
  appendMessage(log, 's', 'm1', 3, 100)
  appendMessage(log, 's', '', 3, 100)
  appendMessage(log, 's', 'bad', 'x', 100)
  appendMessage(log, 's', 7, 1, 100)
  assert.deepEqual(log.s.msgs, { m1: 3 })
  for (let i = 0; i < MESSAGES_PER_SESSION + 5; i += 1) appendMessage(log, 's', 'id' + i, i, 200 + i)
  const ids = Object.keys(log.s.msgs)
  assert.equal(ids.length, MESSAGES_PER_SESSION)
  assert.equal(log.s.msgs.m1, undefined)
  assert.equal(log.s.msgs['id' + (MESSAGES_PER_SESSION + 4)], MESSAGES_PER_SESSION + 4)
})

test('sanitizeCallLog drops malformed entries, sorts by end time and keeps turn and media fields', () => {
  const log = sanitizeCallLog({
    a: { at: 5, msgs: { m1: 2, m2: 'x' }, calls: [entry(300), { at: 'x' }, null, entry(100, { media: 'image', units: 2, ok: false, turn: 2 }), entry(200, { cost: 'free', turn: 'bad' })] },
    b: [entry(1)], // an array is not a session log
    c: { calls: [], msgs: {} },
    d: 'nope',
  })
  assert.deepEqual(Object.keys(log), ['a'])
  assert.deepEqual(log.a.calls.map((e) => e.end), [100, 200, 300])
  assert.equal(log.a.calls[0].media, 'image')
  assert.equal(log.a.calls[0].units, 2)
  assert.equal(log.a.calls[0].ok, false)
  assert.equal(log.a.calls[0].turn, 2)
  assert.equal(log.a.calls[1].turn, null, 'a non-integer turn is dropped')
  assert.equal(log.a.calls[1].cost, null, 'a non-numeric cost is treated as unpriced')
  assert.deepEqual(log.a.msgs, { m1: 2 })
  assert.deepEqual(sanitizeCallLog(undefined), {})
  const parts = sanitizeCallLog({ p: { at: 1, msgs: {}, calls: [entry(1, { parts: [1, 2, 3, 4] }), entry(2, { parts: [1, 2, 3] }), entry(3, { parts: [1, 'x', 3, 4] }), entry(4, { parts: null }), entry(5)] } }).p.calls
  assert.deepEqual(parts.map((e) => e.parts), [[1, 2, 3, 4], undefined, undefined, undefined, undefined], 'only a well-formed four-number split is kept')
})

test('host: calls are stamped with the turn open when they start; messages map to their turn; reset clears the log', async () => {
  const host = await startHost()
  try {
    await host.post({ action: 'set-price', model: 'log-model', currency: 'usd', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
    const session = { id: 'sess-a' }
    const seq0 = host.get().callSeq
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0 }

    host.sessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
    await host.call({ model: 'log-model', sessionId: 'sess-a', usage })
    await host.call({ model: 'other-model', sessionId: 'sess-a', usage: null }) // aborted: no usage
    host.sessionEvent(session, { type: 'assistant/message', data: { turn: 1, step: 0, message: { id: 'msg-1' } } })
    host.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: 'done' } })
    await host.call({ model: 'log-model', sessionId: 'sess-a', usage }) // a title request after the turn: no turn
    host.sessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
    await host.call({ model: 'log-model', sessionId: 'sess-a', usage })
    await host.call({ model: 'log-model', sessionId: 'sess-b', usage: { inputTokens: 10, outputTokens: 10 } }) // another session: no open turn
    assert.ok(host.get().callSeq >= seq0 + 6)

    const { calls, msgs } = await host.post({ action: 'calls', sessionId: 'sess-a' })
    assert.deepEqual(calls.map((c) => c.turn), [1, 1, null, 2])
    assert.equal(calls[0].model, 'log-model')
    assert.equal(calls[0].currency, 'USD')
    assert.ok(Math.abs(calls[0].cost - 0.002) < 1e-9, 'priced at write time: 1000 in × $1/M + 500 out × $2/M')
    assert.equal(calls[0].cacheRead, 200)
    assert.equal(calls[0].parts.length, 4)
    assert.ok(Math.abs(calls[0].parts[0] - 0.001) < 1e-9 && Math.abs(calls[0].parts[1] - 0.001) < 1e-9, 'input $0.001, output $0.001')
    assert.ok(calls[0].end >= calls[0].at)
    assert.equal(calls[1].ok, false)
    assert.equal(calls[1].cost, null)
    assert.deepEqual(msgs, { 'msg-1': 1 })
    assert.deepEqual((await host.post({ action: 'calls', sessionId: 'sess-b' })).calls.map((c) => c.turn), [null])
    assert.deepEqual(await host.post({ action: 'calls', sessionId: 'nope' }).then((r) => [r.calls, r.msgs]), [[], {}])

    await host.post({ action: 'reset-totals' })
    assert.deepEqual((await host.post({ action: 'calls', sessionId: 'sess-a' })).calls, [])
  } finally {
    host.dispose()
  }
})

test('host: a call that ends after turn/end still belongs to the turn it started in; junk events are ignored', async () => {
  const host = await startHost()
  try {
    const session = { id: 'sess-late' }
    host.sessionEvent(session, { type: 'turn/start', data: { turn: 5 } })
    // The stream is still open when the turn closes (cleanup runs late): the turn was captured at the start.
    await host.run({ model: 'm', sessionId: 'sess-late' }, async function* () {
      host.sessionEvent(session, { type: 'turn/end', data: { turn: 5 } })
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    })
    for (const junk of [null, undefined, {}, { type: 5 }, { type: 'turn/start' }, { type: 'assistant/message', data: { message: {} } }]) host.sessionEvent(session, junk)
    host.sessionEvent(null, { type: 'turn/start', data: { turn: 1 } })
    const { calls } = await host.post({ action: 'calls', sessionId: 'sess-late' })
    assert.deepEqual(calls.map((c) => c.turn), [5])
  } finally {
    host.dispose()
  }
})

test('host: a metered media tool call is logged under its session and open turn with units and cost', async () => {
  const host = await startHost()
  try {
    await host.post({ action: 'set-prefs', prefs: { mediaMeter: true } })
    await host.post({ action: 'set-media-rules', rules: [{ tool: 'gen_image', kind: 'image', model: 'img-1', currency: 'CNY', price: 0.2 }] })
    host.sessionEvent({ id: 'sess-m' }, { type: 'turn/start', data: { turn: 4 } })
    host.tool({ name: 'gen_image', arguments: { n: 3 }, agent: { session: { id: 'sess-m' } } }, { isError: false })
    host.tool({ name: 'gen_image', arguments: { n: 1 }, agent: { session: { id: 'sess-m' } } }, { isError: true })
    const { calls } = await host.post({ action: 'calls', sessionId: 'sess-m' })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].media, 'image')
    assert.equal(calls[0].units, 3)
    assert.equal(calls[0].turn, 4)
    assert.ok(Math.abs(calls[0].cost - 0.6) < 1e-9)
    assert.equal(calls[1].ok, false)
    assert.equal(calls[1].cost, null)
  } finally {
    host.dispose()
  }
})
