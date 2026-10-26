// Run: node --test test/stats.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAILY_KEEP_DAYS, dayKey, firstDay, pruneDaily } from '../daily.js'
import { DEFAULT_PREFS, sanitizePrefs } from '../prefs.js'
import { startHost } from './host-harness.mjs'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`)

test('dayKey uses the local calendar date; pruneDaily keeps only the retention window', () => {
  assert.equal(dayKey(new Date(2026, 9, 5, 23, 59).getTime()), '2026-10-05')
  assert.equal(dayKey(new Date(2026, 0, 1, 0, 0).getTime()), '2026-01-01')
  const now = new Date(2026, 9, 26, 12, 0).getTime()
  const daily = {}
  for (let i = 0; i < DAILY_KEEP_DAYS + 10; i += 1) daily[dayKey(now - i * 86_400_000)] = {}
  pruneDaily(daily, now)
  const keys = Object.keys(daily).sort()
  assert.equal(keys.length, DAILY_KEEP_DAYS)
  assert.equal(keys[keys.length - 1], '2026-10-26')
  assert.equal(firstDay(daily), keys[0])
  assert.equal(firstDay({}), null)
})

test('sanitizePrefs keeps legal values, drops unknown keys, falls back on illegal ones', () => {
  assert.deepEqual(sanitizePrefs(undefined), DEFAULT_PREFS)
  const next = sanitizePrefs({ dockStyle: 'soft', statsRange: 7, dockSize: 'huge', sidebar: 'no', evil: 1, dock: false })
  assert.equal(next.dockStyle, 'soft')
  assert.equal(next.statsRange, 7)
  assert.equal(next.dockSize, DEFAULT_PREFS.dockSize)
  assert.equal(next.sidebar, true)
  assert.equal(next.dock, false)
  assert.equal('evil' in next, false)
  // Merging over a base keeps the base's value for keys that are missing or illegal.
  const merged = sanitizePrefs({ dockFont: 'mono', statsRange: 14 }, next)
  assert.equal(merged.dockStyle, 'soft')
  assert.equal(merged.dockFont, 'mono')
  assert.equal(merged.statsRange, 7)
})

test('sanitizePrefs validates the message style, the statistics currency and the exchange rate', () => {
  assert.equal(DEFAULT_PREFS.statsCurrency, 'CNY')
  assert.equal(DEFAULT_PREFS.msgStyle, 'plain')
  const ok = sanitizePrefs({ msgStyle: 'outline', msgFont: 'mono', statsCurrency: 'USD', usdCny: 7.25 })
  assert.deepEqual([ok.msgStyle, ok.msgFont, ok.statsCurrency, ok.usdCny], ['outline', 'mono', 'USD', 7.25])
  const bad = sanitizePrefs({ msgStyle: 'bar', msgFont: 'serif', statsCurrency: 'EUR', usdCny: 0 }, ok)
  assert.deepEqual([bad.msgStyle, bad.msgFont, bad.statsCurrency, bad.usdCny], ['outline', 'mono', 'USD', 7.25], 'illegal values keep the current ones')
  for (const rate of [-1, 0, NaN, Infinity, '7', null, 5000]) assert.equal(sanitizePrefs({ usdCny: rate }).usdCny, DEFAULT_PREFS.usdCny, String(rate))
})

test('host: calls land in per-day buckets, stats exposes them, backfill and reset reach them', async () => {
  const host = await startHost()

  // Call with no price yet: counted and tokens recorded, cost unpriced.
  await host.call({ model: 'day-model', usage: { inputTokens: 1000, outputTokens: 100 } })
  await host.call({ model: 'day-model', usage: null })
  let stats = await host.post({ action: 'stats' })
  assert.equal(stats.ok, true)
  assert.equal(stats.keepDays, DAILY_KEEP_DAYS)
  assert.equal(stats.since, stats.today)
  let bucket = stats.daily[stats.today]['day-model']
  assert.equal(bucket.calls, 2)
  assert.equal(bucket.failed, 1)
  assert.equal(bucket.unpriced, 1)
  assert.equal(bucket.inputTokens, 1000)

  // Hourly slots are keyed hour -> model; they count every call (failed ones too) and the tokens of those that reported usage.
  const slots = Object.values(stats.hourly[stats.today]).flatMap((hour) => Object.entries(hour))
  assert.deepEqual([...new Set(slots.map(([model]) => model))], ['day-model'])
  assert.equal(slots.reduce((sum, [, slot]) => sum + slot.calls, 0), 2)
  assert.equal(slots.reduce((sum, [, slot]) => sum + slot.tokens, 0), 1100)

  // Sessions remember when they were first seen, for the session analysis.
  assert.ok(host.get().sessions.s1.firstAt > 0)

  // The snapshot polled by the dock must not carry the per-day buckets.
  assert.equal('daily' in host.get(), false)
  assert.equal('hourly' in host.get(), false)

  // Pricing the model afterwards backfills the day bucket, same as the all-time one.
  const saved = await host.post({ action: 'set-price', model: 'day-model', currency: 'usd', input: 2, output: 4 })
  assert.equal(saved.ok, true)
  stats = await host.post({ action: 'stats' })
  bucket = stats.daily[stats.today]['day-model']
  assert.equal(bucket.unpriced, 0)
  // The failed call carries no usage, so it must not dilute the backfilled amount.
  close(bucket.costs.USD, (1000 * 2 + 100 * 4) / 1e6)

  // A priced call afterwards adds its full cost to the same day bucket.
  await host.call({ model: 'day-model', usage: { inputTokens: 500, outputTokens: 0 } })
  stats = await host.post({ action: 'stats' })
  bucket = stats.daily[stats.today]['day-model']
  assert.equal(bucket.calls, 3)
  close(bucket.costs.USD, (1000 * 2 + 100 * 4 + 500 * 2) / 1e6)
  // The all-time bucket agrees with the day bucket.
  close(host.get().models['day-model'].costs.USD, bucket.costs.USD)

  assert.equal((await host.post({ action: 'reset-totals' })).ok, true)
  stats = await host.post({ action: 'stats' })
  assert.deepEqual(stats.daily, {})
  assert.deepEqual(stats.hourly, {})
  assert.equal(stats.since, null)
  host.dispose()
})

test('host: set-prefs merges partial updates, validates them and flushes them to disk on dispose', async () => {
  const host = await startHost()
  assert.deepEqual(host.get().prefs, DEFAULT_PREFS)

  const first = await host.post({ action: 'set-prefs', prefs: { dockStyle: 'outline', sidebar: false } })
  assert.equal(first.ok, true)
  assert.equal(first.prefs.dockStyle, 'outline')
  assert.equal(first.prefs.sidebar, false)

  // A second partial update leaves earlier keys alone and ignores garbage.
  const second = await host.post({ action: 'set-prefs', prefs: { dockFont: 'mono', dockSize: 'nope', other: 1 } })
  assert.equal(second.prefs.dockStyle, 'outline')
  assert.equal(second.prefs.dockFont, 'mono')
  assert.equal(second.prefs.dockSize, DEFAULT_PREFS.dockSize)
  assert.equal(host.get().prefs.sidebar, false)

  // dispose flushes the debounced write synchronously.
  host.dispose()
  const onDisk = JSON.parse(readFileSync(join(host.home, 'cost-meter.json'), 'utf8'))
  assert.equal(onDisk.prefs.dockStyle, 'outline')
  assert.equal(onDisk.prefs.dockFont, 'mono')
  assert.ok(onDisk.daily && typeof onDisk.daily === 'object')
})
