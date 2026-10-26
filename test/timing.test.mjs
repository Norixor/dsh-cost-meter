// Run: node --test test/timing.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LATENCY_BOUNDS_MS, SLOWEST_KEEP, addTiming, histIndex, pushSlowest, sanitizeSlowest } from '../timing.js'
import { startHost } from './host-harness.mjs'

test('histIndex puts a duration in the first bucket whose bound it does not exceed', () => {
  assert.equal(histIndex(0), 0)
  assert.equal(histIndex(LATENCY_BOUNDS_MS[0]), 0)
  assert.equal(histIndex(LATENCY_BOUNDS_MS[0] + 1), 1)
  assert.equal(histIndex(10 ** 9), LATENCY_BOUNDS_MS.length)
})

test('addTiming accumulates sums and histograms and initialises old buckets lazily', () => {
  const bucket = { calls: 3 } // a bucket written by an older version
  addTiming(bucket, { durationMs: 2000, ttftMs: 500, outputTokens: 300 })
  addTiming(bucket, { durationMs: 1000, ttftMs: null, outputTokens: 50 })
  assert.equal(bucket.timed, 2)
  assert.equal(bucket.durationMs, 3000)
  assert.equal(bucket.ttftCalls, 1)
  assert.equal(bucket.ttftMs, 500)
  // Throughput counts only the call that had a first token: 300 tokens over the 1500 ms after it.
  assert.equal(bucket.genTokens, 300)
  assert.equal(bucket.genMs, 1500)
  assert.equal(bucket.durHist.reduce((a, b) => a + b, 0), 2)
  assert.equal(bucket.ttftHist.reduce((a, b) => a + b, 0), 1)
  assert.equal(bucket.durHist[histIndex(2000)], 1)
  // Garbage durations are ignored entirely.
  addTiming(bucket, { durationMs: Number.NaN, ttftMs: 1, outputTokens: 1 })
  addTiming(bucket, { durationMs: -5, ttftMs: 1, outputTokens: 1 })
  assert.equal(bucket.timed, 2)
})

test('addTiming skips throughput when nothing was generated after the first token', () => {
  const bucket = {}
  addTiming(bucket, { durationMs: 400, ttftMs: 390, outputTokens: 20 })
  assert.equal(bucket.genTokens, undefined)
  addTiming(bucket, { durationMs: 900, ttftMs: 100, outputTokens: 0 })
  assert.equal(bucket.genTokens, undefined)
  assert.equal(bucket.ttftCalls, 2)
})

test('pushSlowest keeps the longest calls inside the window, longest first', () => {
  const entry = (durationMs, at = 1000) => ({ at, model: 'm', durationMs })
  let list = []
  for (let i = 1; i <= SLOWEST_KEEP + 5; i += 1) list = pushSlowest(list, entry(i * 10), 0)
  assert.equal(list.length, SLOWEST_KEEP)
  assert.equal(list[0].durationMs, (SLOWEST_KEEP + 5) * 10)
  assert.equal(list[list.length - 1].durationMs, 60)
  // A call shorter than the current tail is ignored once the list is full; entries older than the cutoff drop out.
  assert.equal(pushSlowest(list, entry(5), 0).length, SLOWEST_KEEP)
  assert.equal(pushSlowest(list, entry(5), 0).some((e) => e.durationMs === 5), false)
  assert.equal(pushSlowest([entry(900, 10)], entry(100, 2000), 1000).length, 1)
  assert.equal(sanitizeSlowest('nope').length, 0)
  assert.equal(sanitizeSlowest([entry(5), { at: 'x' }, null]).length, 1)
})

test('host: the llm/stream wrapper measures duration and time-to-first-token on a fake clock', async () => {
  const host = await startHost()
  const realPerf = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let clock = 1000
  Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true })
  try {
    await host.run({ model: 'timed', sessionId: 's1' }, async function* () {
      clock += 400
      yield { type: 'block-start', index: 0, blockType: 'text' } // not content: must not count as the first token
      clock += 100
      yield { type: 'text-delta', index: 0, text: 'hi' }
      clock += 1500
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 60 } }
    })
    // A stream that dies before any content, without usage, is a failed call: slowest list only.
    await host.run({ model: 'timed', sessionId: 's1' }, async function* () {
      clock += 7000
    })

    const stats = await host.post({ action: 'stats' })
    assert.deepEqual(stats.latencyBounds, LATENCY_BOUNDS_MS)
    const bucket = stats.daily[stats.today].timed
    assert.equal(bucket.calls, 2)
    assert.equal(bucket.failed, 1)
    assert.equal(bucket.timed, 1)
    assert.equal(bucket.durationMs, 2000)
    assert.equal(bucket.ttftMs, 500)
    assert.equal(bucket.genTokens, 60)
    assert.equal(bucket.genMs, 1500)
    // The all-time bucket carries the same figures.
    assert.equal(host.get().models.timed.durationMs, 2000)

    assert.deepEqual(stats.slowest.map((e) => [e.durationMs, e.ok, e.ttftMs]), [[7000, false, null], [2000, true, 500]])
    assert.equal(stats.slowest[1].input, 100)
    assert.equal(stats.slowest[1].output, 60)

    await host.post({ action: 'reset-totals' })
    assert.deepEqual((await host.post({ action: 'stats' })).slowest, [])
  } finally {
    if (realPerf) Object.defineProperty(globalThis, 'performance', realPerf)
    host.dispose()
  }
})

test('host: a 0.6.x state file with { calls, tokens } hourly slots is migrated under the "unknown" model', async () => {
  // The earlier tests in this file already pointed DSH_HOME at a throw-away directory (index.js reads it once at import).
  const home = process.env.DSH_HOME
  assert.ok(home)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'cost-meter.json'), JSON.stringify({
    hourly: { '2026-10-25': { 9: { calls: 3, tokens: 300 }, 14: { calls: 1, tokens: 5 } } },
  }))
  // startHost wipes the state file, so load the module directly the way the plugin does.
  const { apply } = await import('../index.js')
  let route
  let dispose = () => {}
  apply({
    on: (event, handler) => { if (event === 'dispose') dispose = handler },
    webServer: { register: (spec) => { route = spec; return () => {} } },
  })
  let out = ''
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ action: 'stats' })) },
  }
  await route.handler(req, { setHeader() {}, end(text) { out = text } })
  const { hourly } = JSON.parse(out)
  assert.deepEqual(hourly['2026-10-25'][9], { unknown: { calls: 3, tokens: 300 } })
  assert.deepEqual(hourly['2026-10-25'][14], { unknown: { calls: 1, tokens: 5 } })
  dispose()
})
