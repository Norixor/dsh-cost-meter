// Pure latency aggregation for the statistics page (self-contained: inlined into client.js and imported by tests).
// Counters come from the Host (timing.js): sums plus log-scale histograms whose upper bounds ship with the stats reply.

export function emptyLatency(bounds) {
  const hist = () => new Array(bounds.length + 1).fill(0)
  return { timed: 0, durationMs: 0, ttftCalls: 0, ttftMs: 0, genTokens: 0, genMs: 0, durHist: hist(), ttftHist: hist() }
}

/** Add one counter's timing fields into `target`; counters without timing (older data) contribute nothing. */
export function addLatency(target, counter) {
  if (!counter || !counter.timed) return target
  target.timed += counter.timed
  target.durationMs += counter.durationMs || 0
  target.ttftCalls += counter.ttftCalls || 0
  target.ttftMs += counter.ttftMs || 0
  target.genTokens += counter.genTokens || 0
  target.genMs += counter.genMs || 0
  for (let i = 0; i < target.durHist.length; i += 1) {
    target.durHist[i] += (counter.durHist && counter.durHist[i]) || 0
    target.ttftHist[i] += (counter.ttftHist && counter.ttftHist[i]) || 0
  }
  return target
}

export function mergeLatency(counters, bounds) {
  const merged = emptyLatency(bounds)
  for (const counter of counters) addLatency(merged, counter)
  return merged
}

/**
 * Estimate the q-quantile (0–1) from a histogram by linear interpolation inside the bucket that holds it.
 * The open-ended last bucket reports its lower bound. Returns null for an empty histogram.
 */
export function percentile(hist, bounds, q) {
  const total = hist.reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  const target = q * total
  let seen = 0
  for (let i = 0; i < hist.length; i += 1) {
    if (hist[i] > 0 && seen + hist[i] >= target) {
      const lo = i === 0 ? 0 : bounds[i - 1]
      const hi = i < bounds.length ? bounds[i] : lo
      return lo + (hi - lo) * ((target - seen) / hist[i])
    }
    seen += hist[i]
  }
  return null
}

/** Calls that took longer than `ms`, counting whole buckets whose lower bound is at least `ms`. */
export function countAbove(hist, bounds, ms) {
  let n = 0
  for (let i = 0; i < hist.length; i += 1) {
    const lo = i === 0 ? 0 : bounds[i - 1]
    if (lo >= ms) n += hist[i]
  }
  return n
}

/** Headline figures of a merged latency record; every field is null when nothing was measured. */
export function summarizeLatency(m, bounds) {
  return {
    calls: m.timed,
    totalMs: m.durationMs,
    avgMs: m.timed > 0 ? m.durationMs / m.timed : null,
    p50: percentile(m.durHist, bounds, 0.5),
    p95: percentile(m.durHist, bounds, 0.95),
    ttftAvgMs: m.ttftCalls > 0 ? m.ttftMs / m.ttftCalls : null,
    ttftP95: percentile(m.ttftHist, bounds, 0.95),
    tokensPerSec: m.genMs > 0 ? m.genTokens / (m.genMs / 1000) : null,
    // Average time spent waiting for the first token vs generating, for the composition bars.
    ttftShare: m.durationMs > 0 && m.ttftCalls > 0 ? Math.min(1, (m.ttftMs / m.ttftCalls) / (m.durationMs / m.timed)) : null,
  }
}

/** Per-model latency rows for the days in view, longest cumulative wait first. */
export function latencyByModel(days, bounds) {
  const by = {}
  for (const day of days) {
    for (const model of Object.keys(day.models)) addLatency(by[model] || (by[model] = emptyLatency(bounds)), day.models[model])
  }
  return Object.keys(by).filter((model) => by[model].timed > 0)
    .map((model) => Object.assign({ model }, summarizeLatency(by[model], bounds)))
    .sort((a, b) => b.totalMs - a.totalMs || a.model.localeCompare(b.model))
}

/** One point per day: average total time and average time-to-first-token (null on days without data). */
export function latencyByDay(days, bounds) {
  return days.map((day) => {
    const m = mergeLatency(Object.values(day.models), bounds)
    return { key: day.key, calls: m.timed, avgMs: m.timed > 0 ? m.durationMs / m.timed : null, ttftMs: m.ttftCalls > 0 ? m.ttftMs / m.ttftCalls : null }
  })
}

/** "850ms", "1.2s", "45s", "2m05s", "1h20m", "5d13h"; null → "—". */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return Math.round(ms) + 'ms'
  const seconds = ms / 1000
  if (seconds < 10) return String(Number(seconds.toFixed(1))) + 's'
  if (seconds < 60) return Math.round(seconds) + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm' + String(Math.round(seconds - minutes * 60)).padStart(2, '0') + 's'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
  return Math.floor(hours / 24) + 'd' + String(hours % 24).padStart(2, '0') + 'h'
}

/** Histogram as chart rows: key is the bucket label ("≤1s", ">2m00s"), count the number of calls. */
export function histRows(hist, bounds) {
  return hist.map((count, i) => ({
    key: i < bounds.length ? '≤' + formatDuration(bounds[i]) : '>' + formatDuration(bounds[bounds.length - 1]),
    count,
  }))
}
