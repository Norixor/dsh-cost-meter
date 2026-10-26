// Run: node --test test/stats-latency.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { LATENCY_BOUNDS_MS, addTiming } from '../timing.js'
import {
  countAbove, emptyLatency, formatDuration, histRows, latencyByDay, latencyByModel, mergeLatency, percentile, summarizeLatency,
} from '../src/client/lib/86-stats-latency.js'
import { insightsOf } from '../src/client/lib/87-stats-insights.js'

const B = LATENCY_BOUNDS_MS
const timed = (...calls) => {
  const bucket = {}
  for (const [durationMs, ttftMs, outputTokens] of calls) addTiming(bucket, { durationMs, ttftMs, outputTokens })
  return bucket
}

test('percentile interpolates inside the bucket and reports the open bucket by its lower bound', () => {
  assert.equal(percentile(emptyLatency(B).durHist, B, 0.5), null)
  const hist = new Array(B.length + 1).fill(0)
  hist[2] = 10 // (600, 1000]
  assert.equal(percentile(hist, B, 0.5), 800)
  assert.equal(percentile(hist, B, 1), 1000)
  const slow = new Array(B.length + 1).fill(0)
  slow[B.length] = 3
  assert.equal(percentile(slow, B, 0.95), B[B.length - 1])
  // P95 of 19 fast calls and 1 slow call sits in the fast bucket's tail, not at the slow call.
  const mixed = new Array(B.length + 1).fill(0)
  mixed[0] = 19
  mixed[8] = 1
  assert.ok(percentile(mixed, B, 0.95) <= B[0])
  assert.ok(percentile(mixed, B, 0.99) > B[7])
})

test('mergeLatency adds counters, tolerates counters without timing and summarises', () => {
  const a = timed([2000, 500, 300], [1000, null, 50])
  const b = timed([4000, 1000, 600])
  const merged = mergeLatency([a, b, { calls: 9 }, undefined], B)
  assert.equal(merged.timed, 3)
  assert.equal(merged.durationMs, 7000)
  assert.equal(merged.ttftCalls, 2)
  const s = summarizeLatency(merged, B)
  assert.equal(s.calls, 3)
  assert.ok(Math.abs(s.avgMs - 7000 / 3) < 1e-9)
  assert.equal(s.ttftAvgMs, 750)
  // 900 tokens over (1500 + 3000) ms of generation after the first token.
  assert.equal(s.tokensPerSec, 900 / 4.5)
  assert.ok(s.p95 >= s.p50)
  assert.equal(summarizeLatency(emptyLatency(B), B).avgMs, null)
  assert.equal(summarizeLatency(emptyLatency(B), B).tokensPerSec, null)
})

test('latencyByModel orders by total wait and latencyByDay leaves gaps null', () => {
  const days = [
    { key: 'd1', models: { fast: timed([500, 100, 10]), slow: timed([20000, 3000, 500]) } },
    { key: 'd2', models: {} },
    { key: 'd3', models: { fast: timed([700, 200, 20]), untimed: { calls: 4 } } },
  ]
  assert.deepEqual(latencyByModel(days, B).map((r) => r.model), ['slow', 'fast'])
  const fast = latencyByModel(days, B).find((r) => r.model === 'fast')
  assert.equal(fast.calls, 2)
  assert.equal(fast.avgMs, 600)
  const points = latencyByDay(days, B)
  assert.deepEqual(points.map((p) => p.avgMs), [10250, null, 700])
  assert.equal(points[0].ttftMs, 1550)
})

test('formatDuration and histRows', () => {
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration(850), '850ms')
  assert.equal(formatDuration(1000), '1s')
  assert.equal(formatDuration(1240), '1.2s')
  assert.equal(formatDuration(45_400), '45s')
  assert.equal(formatDuration(125_000), '2m05s')
  assert.equal(formatDuration(4_800_000), '1h20m')
  assert.equal(formatDuration(5 * 86_400_000 + 13 * 3_600_000), '5d13h')
  const rows = histRows(new Array(B.length + 1).fill(1), B)
  assert.equal(rows.length, B.length + 1)
  assert.equal(rows[0].key, '≤300ms')
  assert.equal(rows[rows.length - 1].key, '>2m00s')
  const hist = new Array(B.length + 1).fill(0)
  hist[B.indexOf(60000) + 1] = 2 // (60s, 120s]
  hist[B.length] = 1
  hist[B.indexOf(60000)] = 5 // (40s, 60s] does not count
  assert.equal(countAbove(hist, B, 60000), 3)
})

test('insightsOf raises only what the numbers justify, warnings first', () => {
  const quiet = { calls: 100, failed: 1, unpriced: 0, peakCalls: 0, tierCalls: 0, hit: 0.8, inputSide: 1e6, models: 1, topModel: 'a', topShare: 1, latency: { calls: 100, p95Ms: 8000, ttftAvgMs: 900, slowCalls: 0 } }
  assert.deepEqual(insightsOf(quiet), [])
  const loud = insightsOf({
    ...quiet, failed: 12, unpriced: 3, hit: 0.2, peakCalls: 10, tierCalls: 5, models: 3, topModel: 'big', topShare: 0.9,
    latency: { calls: 100, p95Ms: 45_000, ttftAvgMs: 7000, slowCalls: 4 },
  })
  assert.deepEqual(loud.map((i) => i.id), ['failed', 'unpriced', 'lowHit', 'slowP95', 'slowFirst', 'peak', 'tier', 'concentrated', 'longCalls'])
  assert.equal(loud[0].level, 'warn')
  assert.equal(loud.at(-1).level, 'info')
  assert.equal(loud.find((i) => i.id === 'concentrated').params.model, 'big')
  // Too little data: no failure-rate or latency verdicts.
  assert.deepEqual(insightsOf({ ...quiet, calls: 4, failed: 3, latency: { calls: 2, p95Ms: 99_000, ttftAvgMs: 99_000, slowCalls: 2 } }).map((i) => i.id), [])
  assert.deepEqual(insightsOf({ ...quiet, hit: 0.1, inputSide: 50_000 }), [])
})
