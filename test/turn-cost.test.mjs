// Run: node --test test/turn-cost.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { callsOfTurn, summarizeCalls, turnNumberOf, turnOfMessage, turnTokens } from '../src/client/lib/88-turn-cost.js'

const call = (at, over = {}) => ({ at, end: at + 2000, model: 'm1', ok: true, cost: 0.01, currency: 'USD', input: 100, output: 50, cacheRead: 400, cacheWrite: 0, ttftMs: 300, ...over })

test('callsOfTurn keeps only the calls stamped with that turn; untagged calls never match', () => {
  const calls = [call(100, { turn: 1 }), call(200, { turn: 2 }), call(300, { turn: null }), call(400, { turn: 2 }), call(500)]
  assert.deepEqual(callsOfTurn(calls, 2).map((c) => c.at), [200, 400])
  assert.deepEqual(callsOfTurn(calls, 0), [])
  assert.deepEqual(callsOfTurn(calls, null), [])
  assert.deepEqual(callsOfTurn(calls, '2'), [])
  assert.deepEqual(callsOfTurn([], 1), [])
})

test('turnOfMessage looks a message id up and tolerates missing maps and ids', () => {
  assert.equal(turnOfMessage({ a: 3, b: 0 }, 'a'), 3)
  assert.equal(turnOfMessage({ a: 3, b: 0 }, 'b'), 0)
  assert.equal(turnOfMessage({ a: 3 }, 'zzz'), null)
  assert.equal(turnOfMessage({ a: 'x' }, 'a'), null)
  assert.equal(turnOfMessage(undefined, 'a'), null)
  assert.equal(turnOfMessage({ a: 3 }, undefined), null)
})

test('turnNumberOf accepts a turn number or a turn view object', () => {
  assert.equal(turnNumberOf(4), 4)
  assert.equal(turnNumberOf({ turn: 7, status: 'done' }), 7)
  assert.equal(turnNumberOf({ turn: '7' }), null)
  assert.equal(turnNumberOf(null), null)
  assert.equal(turnNumberOf(undefined), null)
  assert.equal(turnNumberOf({}), null)
})

test('summarizeCalls totals cost per currency, tokens and model time, and ranks models by cost', () => {
  const s = summarizeCalls([
    call(1000, { model: 'cheap', cost: 0.001 }),
    call(4000, { model: 'big', cost: 0.2, currency: 'CNY', input: 1000, output: 200, cacheRead: 0 }),
    call(8000, { model: 'big', cost: 0.1, currency: 'CNY' }),
    call(9000, { model: 'big', ok: false, cost: null, currency: '', input: 0, output: 0, cacheRead: 0 }),
    call(9500, { model: 'unpriced', cost: null, currency: '' }),
  ])
  assert.equal(s.calls, 5)
  assert.equal(s.failed, 1)
  assert.equal(s.unpriced, 1, 'a finished call without a price is counted; a failed call is not')
  assert.ok(Math.abs(s.costs.CNY - 0.3) < 1e-9)
  assert.ok(Math.abs(s.costs.USD - 0.001) < 1e-9)
  assert.equal(s.input, 100 + 1000 + 100 + 0 + 100)
  assert.equal(s.wallMs, 5 * 2000)
  assert.deepEqual(s.models.map((m) => m.model), ['big', 'cheap', 'unpriced'])
  assert.equal(s.models[0].calls, 3)
  assert.equal(turnTokens(s), s.input + s.output + s.cacheRead + s.cacheWrite)
})

test('summarizeCalls books media calls as cost and units, not as tokens or model time', () => {
  const s = summarizeCalls([
    call(1000),
    { at: 3000, end: 3000, model: 'img-1', ok: true, cost: 0.6, currency: 'CNY', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ttftMs: null, media: 'image', units: 3 },
    { at: 4000, end: 4000, model: 'img-1', ok: false, cost: null, currency: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ttftMs: null, media: 'image', units: 0 },
  ])
  assert.equal(s.wallMs, 2000)
  assert.equal(s.input, 100)
  const img = s.models.find((m) => m.model === 'img-1')
  assert.equal(img.media, 'image')
  assert.equal(img.units, 3)
  assert.equal(img.calls, 2)
  assert.equal(s.failed, 1)
  assert.ok(Math.abs(s.costs.CNY - 0.6) < 1e-9)
})
