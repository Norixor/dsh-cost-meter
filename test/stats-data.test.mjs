// Run: node --test test/stats-data.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allows, buildDays, cnyPer, compactNumber, convertCosts, convertDaily, convertModels, convertSessions, convertedFrom, currenciesOf, dayStartMs, hitRateOf, hourShare, hourStats, labelEvery, modelOrder, niceTicks,
  peakHour, rangeKeys, rankModels, sessionRows, shiftDay, slowestRows, stackByModel, sumDays, tokenMix, weekdayOf,
} from '../src/client/lib/85-stats-data.js'

const counter = (o = {}) => ({ calls: 1, failed: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costs: {}, ...o })

test('day arithmetic crosses month and year boundaries and numbers weekdays from Monday', () => {
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
  assert.deepEqual(rangeKeys('2026-10-26', 3), ['2026-10-24', '2026-10-25', '2026-10-26'])
  assert.equal(weekdayOf('2026-10-26'), 0) // Monday
  assert.equal(weekdayOf('2026-10-25'), 6) // Sunday
  assert.equal(new Date(dayStartMs('2026-10-26')).getHours(), 0)
})

test('buildDays pads missing days and sums models per day', () => {
  const daily = {
    '2026-10-25': { a: counter({ inputTokens: 10, costs: { CNY: 1 } }), b: counter({ outputTokens: 5, costs: { CNY: 2, USD: 1 } }) },
  }
  const days = buildDays(daily, ['2026-10-24', '2026-10-25'])
  assert.equal(days[0].total.calls, 0)
  assert.equal(days[1].total.calls, 2)
  assert.equal(days[1].total.costs.CNY, 3)
  const total = sumDays(days)
  assert.equal(total.inputTokens + total.outputTokens, 15)
  assert.deepEqual(currenciesOf(days).map((c) => c.cur), ['CNY', 'USD'])
})

test('model filter narrows days, totals and currencies; null keeps everything', () => {
  const daily = {
    d1: { a: counter({ inputTokens: 10, peakCalls: 1, tierCalls: 2, costs: { CNY: 1 } }), b: counter({ inputTokens: 5, costs: { USD: 4 } }) },
  }
  assert.equal(allows(null, 'x'), true)
  assert.equal(allows(new Set(['a']), 'b'), false)
  const all = buildDays(daily, ['d1'])
  assert.equal(all[0].total.calls, 2)
  assert.equal(all[0].total.peakCalls, 1)
  assert.equal(all[0].total.tierCalls, 2)
  const onlyA = buildDays(daily, ['d1'], new Set(['a']))
  assert.deepEqual(Object.keys(onlyA[0].models), ['a'])
  assert.equal(onlyA[0].total.inputTokens, 10)
  assert.deepEqual(currenciesOf(onlyA).map((c) => c.cur), ['CNY'])
  assert.equal(buildDays(daily, ['d1'], new Set(['zzz']))[0].total.calls, 0)
})

test('stackByModel keeps colour slots stable, folds the tail into "other" and drops zero-cost models', () => {
  const models = { big: counter({ costs: { CNY: 9 } }), mid: counter({ costs: { CNY: 5 } }), small: counter({ costs: { CNY: 1 } }), free: counter() }
  const order = modelOrder(models)
  assert.deepEqual(order.slice(0, 3), ['big', 'mid', 'small'])
  const days = buildDays({
    d1: { mid: counter({ costs: { CNY: 2 } }), small: counter({ costs: { CNY: 1 } }), free: counter(), unknown: counter({ costs: { CNY: 4 } }) },
  }, ['d1'])
  // Only the top 2 models get their own slot; "small" and the unknown model fold together.
  const { series, rows } = stackByModel(days, 'CNY', order, 2)
  assert.deepEqual(series.map((s) => s.key), ['mid', '__other'])
  assert.deepEqual(series.map((s) => s.slot), [1, null])
  assert.deepEqual(rows[0].values, [2, 5])
  assert.equal(rows[0].total, 7)
  // "mid" keeps slot 1 even when "big" is absent from the range.
  assert.equal(stackByModel(days, 'CNY', order, 7).series.find((s) => s.key === 'mid').slot, 1)
})

test('tokenMix, hit rate and model ranking', () => {
  const days = buildDays({
    d1: { a: counter({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 5, costs: { CNY: 2 } }) },
    d2: { a: counter({ inputTokens: 100, costs: { CNY: 1 } }), b: counter({ outputTokens: 50, costs: { CNY: 10 } }) },
  }, ['d1', 'd2'])
  assert.deepEqual(tokenMix(days)[0].values, [100, 20, 300, 5])
  assert.equal(hitRateOf(days[0].total), 300 / 405, 'cache writes count as prompt that was not served from cache')
  assert.equal(hitRateOf({}), null)
  const rank = rankModels(days, 'CNY')
  assert.deepEqual(rank.map((r) => r.model), ['b', 'a'])
  assert.equal(rank[1].cost, 3)
  assert.equal(rank[1].calls, 2)
  assert.equal(rank[0].billedElsewhere, false)
  assert.deepEqual(rank[1].costs, { CNY: 3 })
  const usd = rankModels(buildDays({ d: { x: counter({ costs: { USD: 3 } }), y: counter() } }, ['d']), 'CNY')
  assert.deepEqual(usd.map((r) => [r.model, r.billedElsewhere]), [['x', true], ['y', false]])
})

test('sessionRows filters by activity window, sorts and picks the main model', () => {
  const sessions = {
    old: { updatedAt: 1000, firstAt: 900, costs: { CNY: 9 }, models: { x: counter() } },
    'abcdefghijkl': { updatedAt: 5000, firstAt: 4000, costs: { CNY: 1 }, models: { x: counter({ inputTokens: 10 }), y: counter({ inputTokens: 500, cacheReadTokens: 100 }) } },
    new: { updatedAt: 6000, firstAt: 5500, costs: { CNY: 3 }, models: { x: counter({ calls: 7, inputTokens: 5 }) } },
  }
  const recent = sessionRows(sessions, 2000, 9000, 'CNY', 'recent')
  assert.deepEqual(recent.map((r) => r.id), ['new', 'abcdefghijkl'])
  assert.equal(recent[1].label, 'ghijkl')
  assert.equal(recent[1].main, 'y')
  assert.equal(recent[1].modelCount, 2)
  assert.deepEqual(recent[1].mix, [510, 0, 100, 0])
  assert.deepEqual(recent[0].costs, { CNY: 3 })
  assert.deepEqual(sessionRows(sessions, 2000, 9000, 'CNY', 'calls').map((r) => r.id), ['new', 'abcdefghijkl'])
  assert.deepEqual(sessionRows(sessions, 2000, 9000, 'CNY', 'tokens').map((r) => r.id), ['abcdefghijkl', 'new'])
  assert.deepEqual(sessionRows(sessions, 0, 9000, 'CNY', 'cost').map((r) => r.id), ['old', 'new', 'abcdefghijkl'])
  // Duration sorts by first call → last activity; sessions recorded before 0.6.0 have no start and count as 0.
  assert.deepEqual(sessionRows(sessions, 0, 9000, 'CNY', 'duration').map((r) => [r.id, r.spanMs]), [['abcdefghijkl', 1000], ['new', 500], ['old', 100]])
})

test('sessionRows follows the model filter and the text query', () => {
  const sessions = {
    one: { updatedAt: 5000, firstAt: 4000, costs: { CNY: 99 }, models: { x: counter({ calls: 2, inputTokens: 10, costs: { CNY: 1 } }), y: counter({ inputTokens: 500, costs: { CNY: 3 } }) } },
    two: { updatedAt: 6000, firstAt: 5000, costs: { CNY: 2 }, models: { y: counter({ costs: { CNY: 2 } }) } },
  }
  // Only the selected model's tokens and cost count; a session that never used it disappears.
  const onlyX = sessionRows(sessions, 0, 9000, 'CNY', 'recent', new Set(['x']))
  assert.deepEqual(onlyX.map((r) => r.id), ['one'])
  assert.equal(onlyX[0].cost, 1)
  assert.equal(onlyX[0].calls, 2)
  assert.equal(onlyX[0].modelCount, 1)
  assert.equal(onlyX[0].main, 'x')
  // Without a filter the session's own (backfill-aware) total is used.
  assert.equal(sessionRows(sessions, 0, 9000, 'CNY', 'recent')[1].cost, 99)
  assert.deepEqual(sessionRows(sessions, 0, 9000, 'CNY', 'recent', null, 'ONE').map((r) => r.id), ['one'])
  assert.deepEqual(sessionRows(sessions, 0, 9000, 'CNY', 'recent', null, 'x').map((r) => r.id), ['one'])
  assert.deepEqual(sessionRows(sessions, 0, 9000, 'CNY', 'recent', null, 'nothing'), [])
})

test('slowestRows keeps order and applies range and model filters', () => {
  const list = [{ at: 5000, model: 'a', durationMs: 9 }, { at: 100, model: 'a', durationMs: 8 }, { at: 6000, model: 'b', durationMs: 7 }]
  assert.deepEqual(slowestRows(list, 1000).map((e) => e.durationMs), [9, 7])
  assert.deepEqual(slowestRows(list, 0, new Set(['b'])).map((e) => e.durationMs), [7])
  assert.deepEqual(slowestRows(undefined, 0), [])
})

test('hourStats aggregates by weekday and hour; peak, busiest day and shares', () => {
  const hourly = {
    '2026-10-26': { 9: { m: { calls: 3, tokens: 300 } }, 14: { m: { calls: 4, tokens: 60 }, n: { calls: 1, tokens: 40 } } }, // Monday
    '2026-10-27': { 14: { m: { calls: 1, tokens: 50 } }, 2: { n: { calls: 1, tokens: 10 } } }, // Tuesday
  }
  const stats = hourStats(hourly, ['2026-10-25', '2026-10-26', '2026-10-27'])
  assert.equal(stats.grid[0][14].calls, 5)
  assert.equal(stats.grid[1][14].calls, 1)
  assert.equal(stats.hours[14].calls, 6)
  assert.equal(stats.calls, 10)
  assert.deepEqual(stats.busiest, { key: '2026-10-26', calls: 8 })
  assert.equal(peakHour(stats.hours, 'calls'), 14)
  assert.equal(peakHour(stats.hours, 'tokens'), 9)
  assert.equal(peakHour(hourStats({}, ['2026-10-26']).hours, 'calls'), null)
  assert.equal(hourShare(stats.hours, 'calls', 0, 6), 0.1)
  assert.equal(hourShare(stats.hours, 'calls', 9, 18), 0.9)
  assert.equal(hourShare(hourStats({}, []).hours, 'calls', 0, 6), null)
  // The model filter picks model slots inside each hour.
  const onlyN = hourStats(hourly, ['2026-10-26', '2026-10-27'], new Set(['n']))
  assert.equal(onlyN.calls, 2)
  assert.equal(onlyN.hours[14].calls, 1)
  assert.equal(onlyN.hours[2].calls, 1)
  assert.equal(onlyN.tokens, 50)
  assert.equal(onlyN.hours[9].calls, 0)
})

test('axis helpers: nice ticks, compact numbers and label spacing', () => {
  assert.deepEqual(niceTicks(0).ticks, [0, 1])
  const t = niceTicks(0.87, 4)
  assert.equal(t.max, 1)
  assert.deepEqual(t.ticks, [0, 0.25, 0.5, 0.75, 1])
  assert.deepEqual(niceTicks(1234, 4).ticks, [0, 500, 1000, 1500])
  assert.equal(compactNumber(950), '950')
  assert.equal(compactNumber(12300), '12.3K')
  assert.equal(compactNumber(4_200_000), '4.2M')
  assert.equal(compactNumber(0.125), '0.13')
  assert.equal(labelEvery(90, 600), 9)
  assert.equal(labelEvery(7, 600), 1)
})

test('sessions and models billed in another currency keep their own costs instead of vanishing', () => {
  const sessions = { mixed: { updatedAt: 5000, firstAt: 4000, costs: { CNY: 2, USD: 0.5 }, models: { cn: counter({ calls: 1, costs: { CNY: 2 } }), us: counter({ calls: 1, cacheReadTokens: 900, costs: { USD: 0.5 } }) } } }
  const all = sessionRows(sessions, 0, 9000, 'CNY', 'recent')
  assert.deepEqual(all[0].costs, { CNY: 2, USD: 0.5 })
  assert.equal(all[0].cost, 2, 'sorting and the chart figure still follow the chosen currency')
  const onlyUs = sessionRows(sessions, 0, 9000, 'CNY', 'recent', new Set(['us']))
  assert.deepEqual(onlyUs[0].costs, { USD: 0.5 })
  assert.deepEqual(onlyUs[0].mix, [0, 0, 900, 0], 'usage never depends on the currency')
})

test('convertCosts keeps amounts already in the target currency and converts the rest with the user rate', () => {
  assert.deepEqual(convertCosts({ CNY: 10, USD: 2 }, 'CNY', 7), { CNY: 24 })
  const toUsd = convertCosts({ CNY: 14, USD: 2 }, 'USD', 7)
  assert.ok(Math.abs(toUsd.USD - 4) < 1e-9)
  assert.deepEqual(convertCosts({ CNY: 5 }, 'CNY', 7), { CNY: 5 }, 'a model already in the chosen currency is not touched')
  assert.deepEqual(convertCosts({ USD: 3 }, 'USD', 7), { USD: 3 })
  assert.deepEqual(convertCosts({}, 'CNY', 7), {})
  assert.deepEqual(convertCosts(undefined, 'CNY', 7), {})
})

test('convertCosts leaves currencies without a rate as billed and refuses a missing or invalid rate for USD', () => {
  assert.deepEqual(convertCosts({ USD: 1, EUR: 4 }, 'CNY', 7), { CNY: 7, EUR: 4 })
  assert.equal(cnyPer('CNY', 7), 1)
  assert.equal(cnyPer('USD', 7), 7)
  assert.equal(cnyPer('USD', 0), null)
  assert.equal(cnyPer('USD', NaN), null)
  assert.equal(cnyPer('EUR', 7), null)
  assert.deepEqual(convertCosts({ USD: 2, CNY: 1 }, 'CNY', 0), { USD: 2, CNY: 1 }, 'no usable rate: nothing is converted')
})

test('convertedFrom lists the currencies that were folded into the target', () => {
  assert.deepEqual(convertedFrom({ CNY: 1, USD: 2, EUR: 3 }, 'CNY', 7), ['USD'])
  assert.deepEqual(convertedFrom({ CNY: 1 }, 'CNY', 7), [])
  assert.deepEqual(convertedFrom({ USD: 0 }, 'CNY', 7), [])
  assert.deepEqual(convertedFrom({ USD: 1 }, 'CNY', 0), [])
})

test('converted days, models and sessions flow through the existing aggregation: no model is dropped, totals add up', () => {
  const daily = {
    '2026-10-25': { cheap: counter({ costs: { CNY: 1 } }), glm: counter({ costs: { USD: 2 } }) },
    '2026-10-26': { glm: counter({ costs: { USD: 1 } }), eur: counter({ costs: { EUR: 5 } }) },
  }
  const keys = ['2026-10-25', '2026-10-26']
  const days = buildDays(convertDaily(daily, 'CNY', 7), keys)
  const total = sumDays(days)
  assert.ok(Math.abs(total.costs.CNY - 22) < 1e-9, '1 + (2 + 1) × 7')
  assert.equal(total.costs.EUR, 5)
  assert.deepEqual(rankModels(days, 'CNY').map((r) => r.model), ['glm', 'cheap', 'eur'])
  const stacked = stackByModel(days, 'CNY', modelOrder({ cheap: { calls: 1 }, glm: { calls: 1 } }))
  assert.ok(stacked.series.length >= 2, 'the chart now carries models billed in both currencies')
  assert.equal(daily['2026-10-25'].glm.costs.USD, 2, 'the input is not mutated')

  const models = convertModels({ glm: counter({ costs: { USD: 2 } }) }, 'CNY', 7)
  assert.equal(models.glm.costs.CNY, 14)
  const sessions = convertSessions({ s1: { updatedAt: 5, costs: { CNY: 1, USD: 1 }, models: { glm: counter({ costs: { USD: 1 } }), cheap: counter({ costs: { CNY: 1 } }) } } }, 'USD', 7)
  assert.ok(Math.abs(sessions.s1.costs.USD - (1 / 7 + 1)) < 1e-9)
  assert.ok(Math.abs(sessionRows(sessions, 0, 10, 'USD', 'cost', null, '')[0].cost - (1 / 7 + 1)) < 1e-9)
})
