// Pure aggregation for the statistics page. No React, no translator, no imports: the build inlines this
// file into client.js (stripping `export`) and tests import it as a plain ES module.

const pad2 = (n) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' shifted by `delta` days (calendar arithmetic, immune to time zones and DST). */
export function shiftDay(key, delta) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10)
}

/** Weekday of a day key, Monday = 0 … Sunday = 6. */
export function weekdayOf(key) {
  const [y, m, d] = key.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

/** Local midnight (ms) at the start of a day key. */
export function dayStartMs(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** The `days` keys ending at `today`, oldest first. */
export function rangeKeys(today, days) {
  const keys = []
  for (let i = days - 1; i >= 0; i -= 1) keys.push(shiftDay(today, -i))
  return keys
}

/** '2026-10-26' → '10/26'. */
export const shortDay = (key) => key.slice(5).replace('-', '/')

export function emptyTotals() {
  return { calls: 0, failed: 0, unpriced: 0, peakCalls: 0, tierCalls: 0, units: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costs: {} }
}

function addInto(target, counter) {
  target.calls += counter.calls || 0
  target.failed += counter.failed || 0
  target.unpriced += counter.unpriced || 0
  target.peakCalls += counter.peakCalls || 0
  target.tierCalls += counter.tierCalls || 0
  // Media (image / speech) buckets count units instead of tokens and say which kind they are.
  target.units += counter.units || 0
  if (counter.media) target.media = counter.media
  target.inputTokens += counter.inputTokens || 0
  target.outputTokens += counter.outputTokens || 0
  target.cacheReadTokens += counter.cacheReadTokens || 0
  target.cacheWriteTokens += counter.cacheWriteTokens || 0
  for (const cur of Object.keys(counter.costs || {})) target.costs[cur] = (target.costs[cur] || 0) + counter.costs[cur]
  return target
}

export const tokensOf = (c) => (c.inputTokens || 0) + (c.outputTokens || 0) + (c.cacheReadTokens || 0) + (c.cacheWriteTokens || 0)

/** Cache hit rate = cache read ÷ (input + cache read); null when there was no input-side traffic. */
export function hitRateOf(c) {
  const denom = (c.inputTokens || 0) + (c.cacheReadTokens || 0)
  return denom > 0 ? (c.cacheReadTokens || 0) / denom : null
}

/** Model filter: null / undefined lets every model through, otherwise a Set of model ids. */
export const allows = (models, id) => !models || models.has(id)

/**
 * One entry per key: { key, models: { model: counter }, total } — days without data are empty entries.
 * With a model filter only the selected models are kept, so everything built on top of the days follows it.
 */
export function buildDays(daily, keys, models) {
  return keys.map((key) => {
    const all = (daily && daily[key]) || {}
    const picked = {}
    const total = emptyTotals()
    for (const model of Object.keys(all)) {
      if (!allows(models, model)) continue
      picked[model] = all[model]
      addInto(total, all[model])
    }
    return { key, models: picked, total }
  })
}

export function sumDays(days) {
  const total = emptyTotals()
  for (const day of days) addInto(total, day.total)
  return total
}

/** Currencies that have cost in the range, biggest first: [{ cur, amount }]. */
export function currenciesOf(days) {
  const sums = sumDays(days).costs
  return Object.keys(sums).filter((cur) => sums[cur] > 0).sort((a, b) => sums[b] - sums[a]).map((cur) => ({ cur, amount: sums[cur] }))
}

/**
 * Model names ordered by all-time cost, then calls, then name. The position is the model's colour slot,
 * so it does not change with the selected range or currency (colour follows the entity, not its rank in view).
 */
export function modelOrder(models) {
  const cost = (c) => Object.values((c && c.costs) || {}).reduce((sum, v) => sum + (Number(v) || 0), 0)
  return Object.keys(models || {}).sort((a, b) => cost(models[b]) - cost(models[a]) || (models[b].calls || 0) - (models[a].calls || 0) || a.localeCompare(b))
}

/**
 * Daily cost stacked by model for one currency.
 * Models inside the first `slots` places of `order` keep their own colour slot; the rest (and models unknown to
 * `order`) fold into one "other" series (slot null). Series are bottom-to-top in slot order, "other" last.
 */
export function stackByModel(days, cur, order, slots = 7) {
  const slotOf = (model) => {
    const index = order.indexOf(model)
    return index >= 0 && index < slots ? index : null
  }
  const present = new Set()
  for (const day of days) for (const model of Object.keys(day.models)) if ((day.models[model].costs[cur] || 0) > 0) present.add(model)
  const series = []
  let hasOther = false
  for (const model of order.slice(0, slots)) if (present.has(model)) series.push({ key: model, slot: slotOf(model) })
  for (const model of present) if (slotOf(model) === null) hasOther = true
  if (hasOther) series.push({ key: '__other', slot: null })
  const rows = days.map((day) => {
    const values = series.map(() => 0)
    for (const model of Object.keys(day.models)) {
      const amount = day.models[model].costs[cur] || 0
      if (amount <= 0) continue
      const slot = slotOf(model)
      const at = series.findIndex((s) => (slot === null ? s.slot === null : s.key === model))
      if (at >= 0) values[at] += amount
    }
    return { key: day.key, values, total: values.reduce((a, b) => a + b, 0) }
  })
  return { series, rows }
}

/** Daily token mix: values = [input, output, cache read, cache write]. */
export function tokenMix(days) {
  return days.map((day) => {
    const c = day.total
    const values = [c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens]
    return { key: day.key, values, total: values.reduce((a, b) => a + b, 0) }
  })
}

/** Per-model totals over the days in view: { model: totals }. */
export function modelTotals(days) {
  const by = {}
  for (const day of days) for (const model of Object.keys(day.models)) addInto(by[model] || (by[model] = emptyTotals()), day.models[model])
  return by
}

/** Every model seen in the range: biggest cost in `cur` first, then tokens. Usage figures never depend on the currency. */
export function rankModels(days, cur) {
  const by = modelTotals(days)
  return Object.keys(by).map((model) => ({
    model,
    cost: by[model].costs[cur] || 0,
    // Cost in every currency the model was billed in: a model is never hidden because it is billed in another one.
    costs: by[model].costs,
    // True when the model has cost in some other currency (so a zero here is not "unpriced").
    billedElsewhere: Object.keys(by[model].costs).some((other) => other !== cur && by[model].costs[other] > 0),
    tokens: tokensOf(by[model]),
    calls: by[model].calls,
    failed: by[model].failed,
    units: by[model].units,
    media: by[model].media || null,
    hit: hitRateOf(by[model]),
  })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model))
}

/**
 * Sessions with activity inside [fromMs, toMs], with their (lifetime) totals.
 * sort: 'recent' | 'cost' | 'calls' | 'tokens' | 'duration' (first call → last activity).
 * `models` restricts the totals to the selected models and hides sessions that never used them;
 * `query` keeps sessions whose id or any model id contains the text.
 */
export function sessionRows(sessions, fromMs, toMs, cur, sort, models, query) {
  const rows = []
  const needle = String(query || '').trim().toLowerCase()
  for (const id of Object.keys(sessions || {})) {
    const s = sessions[id]
    if (!(s.updatedAt >= fromMs && s.updatedAt <= toMs)) continue
    const names = Object.keys(s.models || {})
    if (needle && !id.toLowerCase().includes(needle) && !names.some((m) => m.toLowerCase().includes(needle))) continue
    const total = emptyTotals()
    let main = null
    let mainTokens = -1
    let modelCount = 0
    let pickedCost = 0
    for (const model of names) {
      if (!allows(models, model)) continue
      modelCount += 1
      addInto(total, s.models[model])
      pickedCost += (s.models[model].costs && s.models[model].costs[cur]) || 0
      const tokens = tokensOf(s.models[model])
      if (tokens > mainTokens) { main = model; mainTokens = tokens }
    }
    if (modelCount === 0) continue
    rows.push({
      id,
      label: id.length > 8 ? id.slice(-6) : id,
      main,
      modelCount,
      firstAt: s.firstAt || 0,
      updatedAt: s.updatedAt,
      spanMs: s.firstAt ? Math.max(0, s.updatedAt - s.firstAt) : 0,
      calls: total.calls,
      tokens: tokensOf(total),
      mix: [total.inputTokens, total.outputTokens, total.cacheReadTokens, total.cacheWriteTokens],
      cost: models ? pickedCost : (s.costs && s.costs[cur]) || 0,
      costs: models ? total.costs : (s.costs || {}),
    })
  }
  const key = { recent: 'updatedAt', cost: 'cost', calls: 'calls', tokens: 'tokens', duration: 'spanMs' }[sort] || 'updatedAt'
  return rows.sort((a, b) => b[key] - a[key] || b.updatedAt - a.updatedAt)
}

/** The slowest-call list (already longest first) limited to the range and the model filter. */
export function slowestRows(list, fromMs, models) {
  return (Array.isArray(list) ? list : []).filter((e) => e.at >= fromMs && allows(models, e.model))
}

/**
 * Usage by time of day from the hourly buckets of the range (hourly[day][hour][model] = { calls, tokens }).
 * grid[weekday][hour] = { calls, tokens }; hours[hour] totals over weekdays; busiest = the day with most calls.
 */
export function hourStats(hourly, keys, models) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ calls: 0, tokens: 0 })))
  const hours = Array.from({ length: 24 }, () => ({ calls: 0, tokens: 0 }))
  let busiest = null
  let calls = 0
  let tokens = 0
  for (const key of keys) {
    const day = (hourly && hourly[key]) || {}
    const wd = weekdayOf(key)
    let dayCalls = 0
    for (const hour of Object.keys(day)) {
      const at = Number(hour)
      if (!(at >= 0 && at < 24)) continue
      for (const model of Object.keys(day[hour] || {})) {
        if (!allows(models, model)) continue
        const slot = day[hour][model]
        grid[wd][at].calls += slot.calls || 0
        grid[wd][at].tokens += slot.tokens || 0
        hours[at].calls += slot.calls || 0
        hours[at].tokens += slot.tokens || 0
        dayCalls += slot.calls || 0
        tokens += slot.tokens || 0
      }
    }
    calls += dayCalls
    if (dayCalls > 0 && (busiest === null || dayCalls > busiest.calls)) busiest = { key, calls: dayCalls }
  }
  return { grid, hours, busiest, calls, tokens }
}

/** Share (0–1) of `metric` falling in the hours [from, to) ; null when the total is zero. */
export function hourShare(hours, metric, from, to) {
  const total = hours.reduce((sum, slot) => sum + slot[metric], 0)
  if (total <= 0) return null
  return hours.slice(from, to).reduce((sum, slot) => sum + slot[metric], 0) / total
}

/** Hour (0–23) with the most of `metric`, or null when everything is zero. */
export function peakHour(hours, metric) {
  let best = -1
  let bestValue = 0
  hours.forEach((slot, hour) => { if (slot[metric] > bestValue) { best = hour; bestValue = slot[metric] } })
  return best >= 0 ? best : null
}

/** Round `max` up to a "nice" axis maximum and return evenly spaced ticks from 0. */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] }
  const rough = max / count
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  const frac = rough / pow
  const step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10) * pow
  const top = Math.ceil(max / step - 1e-9) * step
  const ticks = []
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(Number(v.toPrecision(12)))
  return { max: top, ticks }
}

/** Compact number: 950 → '950', 12_300 → '12.3K', 4_200_000 → '4.2M'; small values keep up to 2 decimals. */
export function compactNumber(n) {
  const v = Number(n) || 0
  const abs = Math.abs(v)
  if (abs >= 1e9) return String(Number((v / 1e9).toFixed(1))) + 'B'
  if (abs >= 1e6) return String(Number((v / 1e6).toFixed(1))) + 'M'
  if (abs >= 1e3) return String(Number((v / 1e3).toFixed(1))) + 'K'
  if (abs >= 100) return String(Math.round(v))
  if (abs >= 10) return String(Number(v.toFixed(1)))
  return String(Number(v.toFixed(2)))
}

/** Label every N-th tick so labels stay at least `minPx` apart. */
export const labelEvery = (count, widthPx, minPx = 56) => Math.max(1, Math.ceil(minPx / Math.max(1, widthPx / Math.max(1, count))))

/** Local 'MM/DD HH:mm' of a timestamp. */
export function formatStamp(ms) {
  const d = new Date(ms)
  return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

// ---------- Currency conversion (display only) ----------
// Costs are stored per billing currency and never converted at write time. The statistics page can show everything in
// one currency: amounts already in that currency are kept as they are, the others are multiplied by the user's rate.
// Only CNY and USD have a rate (CNY per 1 USD); any other currency stays as billed and is shown next to the total.

/** CNY per one unit of `code`, or null when there is no rate for it. */
export function cnyPer(code, usdCny) {
  if (code === 'CNY') return 1
  if (code === 'USD') return Number.isFinite(usdCny) && usdCny > 0 ? usdCny : null
  return null
}

/** { cur: amount } → the same money in `to` (amounts already in `to` untouched); currencies without a rate stay as billed. */
export function convertCosts(costs, to, usdCny) {
  const out = {}
  const target = cnyPer(to, usdCny)
  for (const cur of Object.keys(costs || {})) {
    const amount = Number(costs[cur]) || 0
    const from = cnyPer(cur, usdCny)
    if (cur === to) out[to] = (out[to] || 0) + amount
    else if (target !== null && from !== null) out[to] = (out[to] || 0) + amount * from / target
    else out[cur] = (out[cur] || 0) + amount
  }
  return out
}

const convertCounter = (counter, to, usdCny) => Object.assign({}, counter, { costs: convertCosts(counter.costs, to, usdCny) })
const mapCounters = (counters, to, usdCny) => {
  const out = {}
  for (const model of Object.keys(counters || {})) out[model] = convertCounter(counters[model], to, usdCny)
  return out
}

/** daily[day][model] with every counter's costs converted into `to`. */
export function convertDaily(daily, to, usdCny) {
  const out = {}
  for (const day of Object.keys(daily || {})) out[day] = mapCounters(daily[day], to, usdCny)
  return out
}

/** Per-model counters (the snapshot's `models`) converted into `to`. */
export const convertModels = mapCounters

/** The snapshot's sessions with their totals and per-model counters converted into `to`. */
export function convertSessions(sessions, to, usdCny) {
  const out = {}
  for (const id of Object.keys(sessions || {})) {
    const s = sessions[id]
    out[id] = Object.assign({}, s, { costs: convertCosts(s.costs, to, usdCny), models: mapCounters(s.models, to, usdCny) })
  }
  return out
}

/** Currencies in `costs` that were converted into `to` (they had cost and a rate): the ones the page should footnote. */
export function convertedFrom(costs, to, usdCny) {
  return Object.keys(costs || {}).filter((cur) => cur !== to && costs[cur] > 0 && cnyPer(cur, usdCny) !== null && cnyPer(to, usdCny) !== null)
}
