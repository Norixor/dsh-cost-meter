// Run: node --test test/item-costs.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { itemCostsOf, partsComplete } from '../src/client/lib/51-item-costs.js'

const price = { currency: 'USD', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
const tokens = { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 400_000 }

test('an exact split that adds up to the recorded cost is used as booked', () => {
  const parts = { USD: [2, 1, 0.2, 1] }
  const costs = { USD: 4.2 }
  assert.equal(partsComplete(parts, costs), true)
  const r = itemCostsOf(parts, costs, tokens, price)
  assert.equal(r.estimated, false)
  assert.deepEqual(r.items, [{ USD: 2 }, { USD: 1 }, { USD: 0.2 }, { USD: 1 }])
})

test('a split that falls short of the recorded cost (older calls had none) is replaced by an estimate', () => {
  const parts = { USD: [0.2, 0.1, 0.02, 0.1] }
  assert.equal(partsComplete(parts, { USD: 4.2 }), false)
  const r = itemCostsOf(parts, { USD: 4.2 }, tokens, price)
  assert.equal(r.estimated, true)
  assert.deepEqual(r.items, [{ USD: 2 }, { USD: 1 }, { USD: 0.2 }, { USD: 1 }])
})

test('without a split the estimate uses the base price; no price means nothing to show; zero items stay empty', () => {
  const r = itemCostsOf(undefined, { USD: 1 }, { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 }, price)
  assert.equal(r.estimated, true)
  assert.deepEqual(r.items, [{ USD: 1 }, {}, {}, {}])
  assert.equal(itemCostsOf(undefined, { USD: 1 }, tokens, null), null)
  assert.equal(partsComplete(undefined, {}), false)
})

test('every currency of the cost must be covered by the split', () => {
  const costs = { USD: 1, CNY: 5 }
  assert.equal(partsComplete({ USD: [1, 0, 0, 0] }, costs), false)
  assert.equal(partsComplete({ USD: [1, 0, 0, 0], CNY: [2, 3, 0, 0] }, costs), true)
})
