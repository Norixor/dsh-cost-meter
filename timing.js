/**
 * Latency bookkeeping for the Host half (pure functions, unit-tested).
 *
 * A counter bucket (per model, per model-day) accumulates, for every completed call:
 *   timed / durationMs        calls with a measured wall-clock duration and their summed duration
 *   ttftCalls / ttftMs        calls that produced a first content chunk and their summed time-to-first-token
 *   genTokens / genMs         output tokens and the time spent after the first token, for the throughput rate
 *   durHist / ttftHist        log-scale histograms (LATENCY_BOUNDS_MS) from which the client estimates P50 / P95
 * Sums and histograms are additive, so any range of days can be merged without keeping raw samples.
 * Buckets written by older versions have none of these fields, hence the lazy initialisation.
 */

/** Upper bounds (ms) of the histogram buckets; the last bucket is open-ended. */
export const LATENCY_BOUNDS_MS = [300, 600, 1000, 1500, 2500, 4000, 6000, 10000, 15000, 25000, 40000, 60000, 120000]

export const SLOWEST_KEEP = 30

export function newHist() {
  return new Array(LATENCY_BOUNDS_MS.length + 1).fill(0)
}

export function histIndex(ms) {
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) {
    if (ms <= LATENCY_BOUNDS_MS[i]) return i
  }
  return LATENCY_BOUNDS_MS.length
}

function histOf(bucket, key) {
  const hist = bucket[key]
  return Array.isArray(hist) && hist.length === LATENCY_BOUNDS_MS.length + 1 ? hist : (bucket[key] = newHist())
}

/**
 * Add one completed call's timing to a bucket.
 * `timing` = { durationMs, ttftMs (null when no content chunk arrived), outputTokens }.
 */
export function addTiming(bucket, timing) {
  const duration = Number(timing.durationMs)
  if (!Number.isFinite(duration) || duration < 0) return
  bucket.timed = (bucket.timed || 0) + 1
  bucket.durationMs = (bucket.durationMs || 0) + duration
  histOf(bucket, 'durHist')[histIndex(duration)] += 1

  const ttft = timing.ttftMs
  if (ttft === null || ttft === undefined || !Number.isFinite(ttft) || ttft < 0) return
  const first = Math.min(ttft, duration)
  bucket.ttftCalls = (bucket.ttftCalls || 0) + 1
  bucket.ttftMs = (bucket.ttftMs || 0) + first
  histOf(bucket, 'ttftHist')[histIndex(first)] += 1

  // Throughput only makes sense when something was generated after the first token.
  const generating = duration - first
  const out = Number(timing.outputTokens) || 0
  if (out > 0 && generating >= 50) {
    bucket.genTokens = (bucket.genTokens || 0) + out
    bucket.genMs = (bucket.genMs || 0) + generating
  }
}

/**
 * Keep the SLOWEST_KEEP slowest calls inside the retention window, longest first.
 * Returns the (possibly new) list; the input array is not mutated.
 */
export function pushSlowest(list, entry, cutoffMs) {
  const kept = list.filter((e) => e && e.at >= cutoffMs)
  if (kept.length >= SLOWEST_KEEP && entry.durationMs <= kept[kept.length - 1].durationMs) return kept
  kept.push(entry)
  kept.sort((a, b) => b.durationMs - a.durationMs)
  return kept.slice(0, SLOWEST_KEEP)
}

/** Sanitise a persisted slowest-calls list; anything malformed is dropped. */
export function sanitizeSlowest(raw) {
  if (!Array.isArray(raw)) return []
  const ok = raw.filter((e) => e && typeof e === 'object' && Number.isFinite(e.at) && Number.isFinite(e.durationMs) && typeof e.model === 'string')
  ok.sort((a, b) => b.durationMs - a.durationMs)
  return ok.slice(0, SLOWEST_KEEP)
}
