// Run: node --test test/peak.test.mjs
// The peak / off-peak status shown in the dock strip and on the sidebar page (src/client/lib/84-peak.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { isPeakAt } from '../pricing.js'
import { PRESET_PRICES } from '../presets.js'
import { isPeakNow, peakState, formatCountdown, windowsText, peakMultiplier, peakSchedules, allPeakSchedules, hasPeakWindows } from '../src/client/lib/84-peak.js'

const utc = (iso) => Date.parse(iso)
const DEEPSEEK = { enabled: true, weekdaysOnly: true, windows: [{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }] }

test('the client-side window test agrees with the billing one at every sampled minute', () => {
  const configs = [
    DEEPSEEK,
    { enabled: true, weekdaysOnly: true, windows: [{ start: '22:00', end: '06:00' }] },
    { enabled: true, weekdaysOnly: false, windows: [{ start: '22:00', end: '06:00' }, { start: '12:00', end: '13:30' }] },
    { enabled: true, windows: [{ start: '00:00', end: '23:59' }] },
    { enabled: false, weekdaysOnly: true, windows: [{ start: '00:00', end: '23:59' }] },
    { enabled: true, weekdaysOnly: false, windows: [{ start: '08:00', end: '08:00' }, { start: '25:00', end: '26:00' }, { start: 'x', end: '09:00' }] },
    { enabled: true, weekdaysOnly: false, windows: [] },
    { enabled: true },
    undefined,
  ]
  const from = utc('2026-10-26T00:00:00Z')
  for (const peak of configs) {
    for (let at = from; at < from + 14 * 86400000; at += 7 * 60000) {
      assert.equal(isPeakNow(peak, at), isPeakAt(peak, at), JSON.stringify(peak) + ' @ ' + new Date(at).toISOString())
    }
  }
})

test('peakState reports the state now and the first whole minute at which it flips', () => {
  // 2026-10-28 is a Wednesday.
  assert.deepEqual(peakState(DEEPSEEK, utc('2026-10-28T00:30:00Z')), { peak: false, changeAt: utc('2026-10-28T01:00:00Z') })
  assert.deepEqual(peakState(DEEPSEEK, utc('2026-10-28T02:00:00Z')), { peak: true, changeAt: utc('2026-10-28T04:00:00Z') })
  assert.deepEqual(peakState(DEEPSEEK, utc('2026-10-28T05:00:00Z')), { peak: false, changeAt: utc('2026-10-28T06:00:00Z') })
  // The last minute of a window is still peak; the flip is the next whole minute.
  assert.deepEqual(peakState(DEEPSEEK, utc('2026-10-28T09:59:30Z')), { peak: true, changeAt: utc('2026-10-28T10:00:00Z') })
  // Seconds inside the minute do not matter.
  assert.deepEqual(peakState(DEEPSEEK, utc('2026-10-28T00:59:59Z')), { peak: false, changeAt: utc('2026-10-28T01:00:00Z') })
})

test('weekends are skipped for weekday-only schedules and the next flip lands on Monday', () => {
  // Friday 10:00 UTC is off-peak; the next peak is Monday 01:00 UTC.
  assert.deepEqual(peakState(DEEPSEEK, utc('2026-10-30T10:00:00Z')), { peak: false, changeAt: utc('2026-11-02T01:00:00Z') })
  assert.deepEqual(peakState(DEEPSEEK, utc('2026-10-31T03:00:00Z')), { peak: false, changeAt: utc('2026-11-02T01:00:00Z') })
  // A window wrapping midnight ends when Saturday begins, because the weekday is judged per instant like billing does.
  const night = { enabled: true, weekdaysOnly: true, windows: [{ start: '22:00', end: '06:00' }] }
  assert.deepEqual(peakState(night, utc('2026-10-30T23:00:00Z')), { peak: true, changeAt: utc('2026-10-31T00:00:00Z') })
  assert.deepEqual(peakState(night, utc('2026-10-26T03:00:00Z')), { peak: true, changeAt: utc('2026-10-26T06:00:00Z') })
})

test('a schedule that is off or has no usable window never flips', () => {
  assert.deepEqual(peakState({ ...DEEPSEEK, enabled: false }, utc('2026-10-28T02:00:00Z')), { peak: false, changeAt: null })
  assert.deepEqual(peakState({ enabled: true, windows: [{ start: '08:00', end: '08:00' }] }, utc('2026-10-28T08:00:00Z')), { peak: false, changeAt: null })
  assert.deepEqual(peakState(undefined, utc('2026-10-28T08:00:00Z')), { peak: false, changeAt: null })
  assert.equal(hasPeakWindows({ enabled: true, windows: [] }), false)
  assert.equal(hasPeakWindows(DEEPSEEK), true)
})

test('formatCountdown rounds up to the minute and drops empty units', () => {
  assert.equal(formatCountdown(1000), '1m')
  assert.equal(formatCountdown(59 * 60000), '59m')
  assert.equal(formatCountdown(59 * 60000 + 1), '1h')
  assert.equal(formatCountdown(80 * 60000), '1h 20m')
  assert.equal(formatCountdown(120 * 60000), '2h')
  assert.equal(formatCountdown(24 * 3600000), '1d')
  assert.equal(formatCountdown(25 * 3600000), '1d 1h')
  assert.equal(formatCountdown(3 * 86400000 - 9 * 3600000), '2d 15h')
})

test('windowsText shifts UTC windows into another zone and wraps around midnight', () => {
  assert.equal(windowsText(DEEPSEEK, 0), '01:00–04:00 · 06:00–10:00')
  assert.equal(windowsText(DEEPSEEK, 480), '09:00–12:00 · 14:00–18:00')
  assert.equal(windowsText(DEEPSEEK, -300), '20:00–23:00 · 01:00–05:00')
  assert.equal(windowsText({ windows: [{ start: '08:00', end: '08:00' }, { start: '10:15', end: '11:45' }] }, 0), '10:15–11:45')
})

test('peakMultiplier is the common ratio of the rates that have both a normal and a peak value', () => {
  assert.equal(peakMultiplier(PRESET_PRICES['deepseek-flash']), 2)
  assert.equal(peakMultiplier({ input: 1, output: 4, peak: { input: 2, output: 0, cacheWrite: 9 } }), 2)
  assert.equal(peakMultiplier({ input: 1, output: 4, peak: { input: 2, output: 4 } }), null)
  assert.equal(peakMultiplier({ input: 1, peak: { input: 0 } }), null)
  assert.equal(peakMultiplier({ input: 1 }), null)
})

test('peakSchedules follows the session\'s models, then models seen anywhere, then every priced model', () => {
  const other = { enabled: true, weekdaysOnly: false, windows: [{ start: '12:00', end: '14:00' }] }
  const snap = {
    presets: {
      a: { input: 1, output: 2, peak: { ...DEEPSEEK, input: 2, output: 4 } },
      b: { input: 1, output: 2, peak: { ...DEEPSEEK, input: 3, output: 6 } },
      c: { input: 1, output: 2, peak: { ...DEEPSEEK, input: 2, output: 4 } },
      d: { input: 1, output: 2 },
    },
    // A saved price replaces the preset of the same name as a whole: `c` loses its peak, `e` brings its own.
    prices: { c: { input: 1, output: 2 }, e: { input: 5, output: 5, peak: { ...other, input: 10 } } },
    models: { a: { calls: 4 }, d: { calls: 1 }, b: { calls: 0 } },
    sessions: { s1: { models: { a: {}, b: {}, d: {} } }, s2: { models: { d: {} } }, s3: { models: {} } },
  }
  const s1 = peakSchedules(snap, 's1')
  assert.equal(s1.length, 1, 'a and b share one schedule')
  assert.deepEqual(s1[0].models, ['a', 'b'])
  assert.equal(s1[0].multiplier, null, 'a is 2x and b is 3x, so there is no common ratio')
  assert.equal(s1[0].peak.windows.length, 2)

  assert.deepEqual(peakSchedules(snap, 's2'), [], 'a session that only used a model without peak windows shows nothing')

  const seen = peakSchedules(snap, 's3')
  assert.deepEqual(seen.map((g) => g.models), [['a']], 'an empty session falls back to the models seen with calls')
  assert.equal(seen[0].multiplier, 2)

  const fresh = peakSchedules({ ...snap, models: {} }, null)
  assert.deepEqual(fresh.map((g) => g.models).sort(), [['a', 'b'], ['e']], 'with nothing seen yet, every priced model counts (c lost its peak to the saved price)')
  assert.equal(fresh.find((g) => g.models[0] === 'e').multiplier, 2)

  // The settings page lists everything configured, whether or not a model was ever called.
  const all = allPeakSchedules(snap)
  assert.deepEqual(all.map((g) => g.models).sort(), [['a', 'b'], ['e']])
  assert.deepEqual(allPeakSchedules(null), [])

  assert.deepEqual(peakSchedules(null, 's1'), [])
  assert.deepEqual(peakSchedules({}, 's1'), [])
})
