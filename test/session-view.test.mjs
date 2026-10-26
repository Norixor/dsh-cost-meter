// Run: node --test test/session-view.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionBreakdown } from '../src/client/lib/89-session-view.js'

const counter = (over) => ({ calls: 1, failed: 0, unpriced: 0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costs: {}, ...over })
const snap = {
  prices: { cheap: { currency: 'CNY' } },
  presets: { preset: { currency: 'USD' } },
  sessions: {
    s1: {
      updatedAt: 99,
      costs: { CNY: 3, USD: 1 },
      models: {
        cheap: counter({ costs: { CNY: 1 }, calls: 3 }),
        big: counter({ costs: { CNY: 2, USD: 1 }, inputTokens: 1000, cacheReadTokens: 400, calls: 2, failed: 1 }),
        free: counter({ costs: {}, unpriced: 2, calls: 2 }),
        preset: counter({ costs: { USD: 0 } }),
      },
    },
  },
}

test('sessionBreakdown sums tokens and calls, sorts the most expensive model first and shares the cost out', () => {
  const b = sessionBreakdown(snap, 's1')
  assert.deepEqual(b.rows.map((r) => r.model), ['big', 'cheap', 'free', 'preset'])
  assert.equal(b.calls, 8)
  assert.equal(b.failed, 1)
  assert.equal(b.tokens, (100 + 50) * 3 + 1000 + 50 + 400)
  assert.equal(b.inTok, 100 * 3 + 1000)
  assert.equal(b.cacheRead, 400)
  assert.equal(b.unpriced, 2)
  assert.deepEqual(b.unpricedModels, ['free'])
  assert.equal(b.updatedAt, 99)
  assert.deepEqual(b.costs, { CNY: 3, USD: 1 })
  assert.equal(b.rows[0].share, 3 / 4)
  assert.equal(b.rows[1].share, 1 / 4)
  assert.equal(b.rows[2].share, 0)
  assert.deepEqual(b.rows.map((r) => r.price), [null, snap.prices.cheap, null, snap.presets.preset], 'configured price first, then the preset')
})

test('sessionBreakdown applies the display conversion to the total and every row, and the order follows the converted values', () => {
  // USD → CNY at 7, the way the statistics page folds currencies.
  const toCny = (costs) => {
    const out = {}
    for (const cur of Object.keys(costs || {})) out.CNY = (out.CNY || 0) + (cur === 'USD' ? costs[cur] * 7 : costs[cur])
    return out
  }
  const b = sessionBreakdown(snap, 's1', toCny)
  assert.deepEqual(b.costs, { CNY: 10 })
  assert.equal(b.rows[0].model, 'big')
  assert.deepEqual(b.rows[0].costs, { CNY: 9 })
  assert.equal(b.rows[0].share, 0.9)
})

test('sessionBreakdown is empty for an unknown session, a missing snapshot or no session id, and share is null without priced costs', () => {
  for (const [s, id] of [[snap, 'nope'], [null, 's1'], [snap, '']]) {
    const b = sessionBreakdown(s, id)
    assert.deepEqual([b.rows, b.session, b.tokens, b.costs], [[], null, 0, {}])
  }
  const free = sessionBreakdown({ sessions: { x: { costs: {}, models: { m: counter({}) } } } }, 'x')
  assert.equal(free.rows[0].share, null)
})
