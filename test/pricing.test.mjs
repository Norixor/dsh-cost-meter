// Run: node --test test/pricing.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contextTokensOf, mergeUsage, parseTiers, pickTier, priceCall } from '../pricing.js'
import { presetFor } from '../presets.js'
import { startHost } from './host-harness.mjs'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`)
// 2026-10-26 is a Monday; 02:00 UTC falls inside the DeepSeek peak window.
const MON_PEAK = Date.UTC(2026, 9, 26, 2, 0)
const MON_OFF = Date.UTC(2026, 9, 26, 12, 0)

const BASE = { currency: 'USD', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
const TIER = { above: 100000, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }

test('context length counts uncached input plus cache reads and writes, not output', () => {
  assert.equal(contextTokensOf({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 999 }), 60)
})

test('tier applies only when context strictly exceeds the threshold', () => {
  assert.equal(pickTier([TIER], 100000), undefined)
  assert.equal(pickTier([TIER], 100001), TIER)
  const high = { above: 200000, input: 3 }
  assert.equal(pickTier([high, TIER], 250000), high)
  assert.equal(pickTier([high, TIER], 150000), TIER)
})

test('a request over the threshold is billed entirely at the tier rate, cache included', () => {
  const price = { ...BASE, tiers: [TIER] }
  const usage = { inputTokens: 40000, cacheReadTokens: 70000, cacheWriteTokens: 0, outputTokens: 1000 }
  const result = priceCall(price, usage, MON_OFF)
  assert.equal(result.tier, true)
  close(result.amount, (40000 * 2 + 70000 * 0.2 + 1000 * 8) / 1e6)
  const small = priceCall(price, { inputTokens: 40000, cacheReadTokens: 60000, outputTokens: 1000 }, MON_OFF)
  assert.equal(small.tier, false)
  close(small.amount, (40000 * 1 + 60000 * 0.1 + 1000 * 5) / 1e6)
})

test('blank tier fields fall back to the base price', () => {
  const price = { ...BASE, tiers: [{ above: 1000, input: 4, output: 0, cacheRead: 0, cacheWrite: 0 }] }
  const result = priceCall(price, { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 1000 }, MON_OFF)
  close(result.amount, (2000 * 4 + 1000 * 5 + 1000 * 0.1) / 1e6)
})

test('peak price wins over tier price; blank peak fields fall through to the tier', () => {
  const peak = { enabled: true, weekdaysOnly: true, windows: [{ start: '01:00', end: '04:00' }], input: 9, output: 0, cacheRead: 0, cacheWrite: 0 }
  const price = { ...BASE, tiers: [TIER], peak }
  const result = priceCall(price, { inputTokens: 200000, outputTokens: 1000 }, MON_PEAK)
  assert.equal(result.peak, true)
  assert.equal(result.tier, true)
  close(result.amount, (200000 * 9 + 1000 * 8) / 1e6)
})

test('preset tiers: Haiku 5.5 over 100K and gpt-6.1-terra over 272K', () => {
  const haiku = priceCall(presetFor('claude-haiku-5-5'), { inputTokens: 120000, outputTokens: 1000 }, MON_OFF)
  close(haiku.amount, (120000 * 0.5 + 1000 * 2.5) / 1e6)
  const terra = priceCall(presetFor('gpt-6.1-terra'), { inputTokens: 300000, outputTokens: 1000 }, MON_OFF)
  close(terra.amount, (300000 * 2 + 1000 * 7.5) / 1e6)
  const short = priceCall(presetFor('gpt-6.1-terra'), { inputTokens: 100000, outputTokens: 1000 }, MON_OFF)
  close(short.amount, (100000 * 1 + 1000 * 5) / 1e6)
})

test('parseTiers drops invalid, duplicate and empty tiers and sorts ascending', () => {
  const tiers = parseTiers([
    { above: 200000, input: 3 },
    { above: 0, input: 9 },
    { above: 100000.4, input: 2, output: 'x' },
    { above: 100000, input: 7 },
    { above: 50000 },
    null,
  ])
  assert.deepEqual(tiers.map((t) => t.above), [100000, 200000])
  assert.equal(tiers[0].input, 2)
  assert.equal(tiers[0].output, 0)
  assert.equal(parseTiers('nope').length, 0)
  assert.equal(parseTiers(Array.from({ length: 9 }, (_, i) => ({ above: (i + 1) * 1000, input: 1 }))).length, 4)
})

test('host: set-price stores tiers, calls over the threshold are counted and billed', async () => {
  const host = await startHost()
  const { post, get } = host
  const call = (usage) => host.call({ model: 'tier-model', usage })

  const saved = await post({ action: 'set-price', model: 'tier-model', currency: 'usd', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0, tiers: [{ above: 100000, input: 2, output: 8 }, { above: 0, input: 5 }] })
  assert.equal(saved.ok, true)
  assert.deepEqual(get().prices['tier-model'].tiers, [{ above: 100000, input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }])

  await call({ inputTokens: 50000, outputTokens: 1000 })
  await call({ inputTokens: 150000, outputTokens: 1000 })
  const bucket = get().sessions.s1.models['tier-model']
  assert.equal(bucket.calls, 2)
  assert.equal(bucket.tierCalls, 1)
  close(bucket.costs.USD, (50000 * 1 + 1000 * 5 + 150000 * 2 + 1000 * 8) / 1e6)
  assert.equal((await post({ action: 'nope' })).ok, false)
  host.dispose()
})

test('mergeUsage keeps the larger value per counter so a partial last chunk does not erase the other half', () => {
  assert.deepEqual(mergeUsage(null, { inputTokens: 5 }), { inputTokens: 5 })
  assert.deepEqual(mergeUsage({ inputTokens: 5 }, undefined), { inputTokens: 5 })
  // Prompt side first, completion side last (input 0 in the last chunk).
  assert.deepEqual(mergeUsage({ inputTokens: 1200, cacheReadTokens: 300 }, { inputTokens: 0, outputTokens: 105 }), { inputTokens: 1200, cacheReadTokens: 300, outputTokens: 105 })
  // Cumulative totals: the last, larger chunk wins; a counter missing from both stays missing.
  const total = mergeUsage({ inputTokens: 1200, outputTokens: 10 }, { inputTokens: 1200, outputTokens: 105 })
  assert.deepEqual(total, { inputTokens: 1200, outputTokens: 105 })
  assert.equal('cacheWriteTokens' in total, false)
})

test('host: several usage chunks of one call are merged before the call is priced and logged', async () => {
  const host = await startHost()
  try {
    await host.post({ action: 'set-price', model: 'split-usage', currency: 'usd', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
    await host.run({ model: 'split-usage', sessionId: 'sess-split' }, async function* () {
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 0 } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 500 } }
    })
    const m = host.get().models['split-usage']
    assert.equal(m.inputTokens, 1000)
    assert.equal(m.outputTokens, 500)
    assert.ok(Math.abs(m.costs.USD - 0.002) < 1e-9)
    const { calls } = await host.post({ action: 'calls', sessionId: 'sess-split' })
    assert.equal(calls[0].input, 1000)
    assert.equal(calls[0].output, 500)
  } finally {
    host.dispose()
  }
})
