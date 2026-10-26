/**
 * Experimental image / speech metering (pure functions, unit-tested).
 *
 * The Host only sees chat-model traffic on `llm/stream`; image generation and speech run as tools, which a plugin can
 * observe through `tools/result`. A "media rule" maps one tool to a model, a unit price and a quantity source:
 *   image       quantity = images generated   (argument `qtyArg`, default 1 per call)        price per image
 *   speech      quantity = 1,000-character units of the text argument `qtyArg`               price per 1K characters
 *   transcribe  quantity = minutes, from a duration argument `qtyArg` given in seconds        price per minute
 * The price is applied when the call finishes and never recomputed afterwards (same write-time locking as tokens).
 *
 * One tool often fronts several models (the model is an argument). A rule may therefore carry a condition on the call's
 * content, `whenArg` / `whenValue`: it only applies when that argument equals the value (exact, case-insensitive, or a
 * "/regex/"). Rules are tried in list order and the first match wins, so put the specific ones before a catch-all.
 */

export const MEDIA_KINDS = ['image', 'speech', 'transcribe']
export const MAX_RULES = 24
export const OBSERVED_CAP = 60
const ARG_KEYS_CAP = 12
const MODEL_VALUES_CAP = 8
/** Arguments that name a model; their (short, non-sensitive) values are remembered per tool to write per-model rules. */
const MODEL_ARG = /^(model|model_?id|model_?name|engine)$/i

/** Argument each kind reads its quantity from when the rule does not name one. */
export const DEFAULT_QTY_ARG = Object.freeze({ image: 'n', speech: 'text', transcribe: 'duration' })

/**
 * One-click starting points (the tool name is left for the user to pick from the observed tools). Prices are list
 * prices per unit, checked 2026-10-26: OpenAI pricing page (tts / transcribe), Alibaba Cloud Model Studio pricing page
 * (Beijing region, per successfully generated image) and the Gemini API pricing page (paid tier, standard, per image).
 * OpenAI's gpt-image models bill per token (image output $30 per 1M tokens for gpt-image-2), so their per-image figures
 * are estimates for one 1024x1024 image at the named quality; real cost moves with size, quality and reference images.
 * `note` is shown next to the model; `preferred` marks the template used when a rule is made from an observed model
 * name that has several templates.
 */
export const MEDIA_TEMPLATES = Object.freeze([
  { kind: 'image', model: 'gpt-image-2', currency: 'USD', price: 0.006, note: '1024² low · est.' },
  { kind: 'image', model: 'gpt-image-2', currency: 'USD', price: 0.053, note: '1024² medium · est.', preferred: true },
  { kind: 'image', model: 'gpt-image-2', currency: 'USD', price: 0.211, note: '1024² high · est.' },
  { kind: 'image', model: 'gpt-image-2.5-sunburst', currency: 'USD', price: 0.053, note: '1024² medium · est.' },
  { kind: 'image', model: 'gpt-image-2.5-flare', currency: 'USD', price: 0.053, note: '1024² medium · est.' },
  { kind: 'image', model: 'gemini-2.5-flash-image', currency: 'USD', price: 0.039, note: 'Nano Banana' },
  { kind: 'image', model: 'gemini-3.1-flash-lite-image', currency: 'USD', price: 0.0336, note: 'Nano Banana 2 Lite · 1K' },
  { kind: 'image', model: 'gemini-nano-banana-2.1', currency: 'USD', price: 0.0336, note: 'Nano Banana 2.1 · 1K', preferred: true },
  { kind: 'image', model: 'gemini-nano-banana-2.1', currency: 'USD', price: 0.0504, note: 'Nano Banana 2.1 · 2K' },
  { kind: 'image', model: 'gemini-3.1-flash-image', currency: 'USD', price: 0.067, note: 'Nano Banana 2 · 1K', preferred: true },
  { kind: 'image', model: 'gemini-3.1-flash-image', currency: 'USD', price: 0.101, note: 'Nano Banana 2 · 2K' },
  { kind: 'image', model: 'gemini-3-pro-image', currency: 'USD', price: 0.134, note: 'Nano Banana Pro · 1K/2K', preferred: true },
  { kind: 'image', model: 'gemini-3-pro-image', currency: 'USD', price: 0.24, note: 'Nano Banana Pro · 4K' },
  { kind: 'image', model: 'qwen-image-3.0', currency: 'CNY', price: 0.18 },
  { kind: 'image', model: 'qwen-image-3.0-pro', currency: 'CNY', price: 0.25, note: '1K' },
  { kind: 'image', model: 'qwen-image-2.1-turbo', currency: 'CNY', price: 0.1 },
  { kind: 'image', model: 'wan2.6-t2i', currency: 'CNY', price: 0.2 },
  { kind: 'image', model: 'wan2.2-t2i-flash', currency: 'CNY', price: 0.14 },
  { kind: 'speech', model: 'tts-1', currency: 'USD', price: 0.015 },
  { kind: 'speech', model: 'tts-1-hd', currency: 'USD', price: 0.03 },
  { kind: 'transcribe', model: 'whisper-1', currency: 'USD', price: 0.006 },
  { kind: 'transcribe', model: 'gpt-4o-transcribe', currency: 'USD', price: 0.006 },
  { kind: 'transcribe', model: 'gpt-4o-mini-transcribe', currency: 'USD', price: 0.003 },
])

const text = (value, max) => String(value === undefined || value === null ? '' : value).trim().slice(0, max)
const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : NaN)

/** Tool matcher: "/regex/" (case-insensitive) or an exact tool name (case-insensitive); null when the regex is invalid. */
export function toolMatcher(spec) {
  const raw = String(spec || '').trim()
  if (raw.length > 2 && raw.startsWith('/') && raw.endsWith('/')) {
    try {
      const re = new RegExp(raw.slice(1, -1), 'i')
      return (name) => re.test(name)
    } catch {
      return null
    }
  }
  const lower = raw.toLowerCase()
  return lower ? (name) => name.toLowerCase() === lower : null
}

/** Keep well-formed rules only: a tool matcher, a known kind, a model (fixed or read from an argument) and a price ≥ 0. */
export function sanitizeRules(raw) {
  if (!Array.isArray(raw)) return []
  const rules = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || rules.length >= MAX_RULES) continue
    const tool = text(item.tool, 120)
    const kind = MEDIA_KINDS.includes(item.kind) ? item.kind : null
    const model = text(item.model, 80)
    const modelArg = text(item.modelArg, 40)
    const price = finite(item.price)
    // A condition needs both halves and a valid matcher. A broken one discards the whole rule: dropping just the
    // condition would silently widen it to every call of the tool and bill them at this model's price.
    const whenArg = text(item.whenArg, 40)
    const whenValue = text(item.whenValue, 80)
    if ((whenArg !== '' || whenValue !== '') && (whenArg === '' || whenValue === '' || toolMatcher(whenValue) === null)) continue
    if (!tool || !kind || (!model && !modelArg) || !toolMatcher(tool) || !(price >= 0)) continue
    rules.push({
      tool, kind, model, modelArg, whenArg, whenValue,
      qtyArg: text(item.qtyArg, 40) || DEFAULT_QTY_ARG[kind],
      currency: text(item.currency, 3).toUpperCase() || 'USD',
      price,
    })
  }
  return rules
}

/** First rule whose tool matches `name`, or null. Rules are compiled once per set by the caller. */
export function compileRules(rules) {
  return rules.map((rule) => ({ rule, test: toolMatcher(rule.tool), when: rule.whenArg && rule.whenValue ? toolMatcher(rule.whenValue) : null }))
    .filter((entry) => entry.test)
}

/** First rule (in list order) whose tool matches `name` and whose argument condition, if any, holds for `args`. */
export function matchRule(compiled, name, args) {
  const given = args || {}
  const hit = compiled.find((entry) => {
    if (!entry.test(String(name || ''))) return false
    if (!entry.rule.whenArg) return true
    const value = given[entry.rule.whenArg]
    return entry.when !== null && (typeof value === 'string' || typeof value === 'number') && entry.when(String(value))
  })
  return hit ? hit.rule : null
}

/** Tool arguments arrive as an object, or occasionally as a JSON string. */
export function argsOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { /* not JSON */ }
  }
  return {}
}

/** The model id a call is booked under: the argument named by `modelArg` when present, else the rule's fixed model. */
export function modelOf(rule, args) {
  const fromArg = rule.modelArg && typeof args[rule.modelArg] === 'string' ? text(args[rule.modelArg], 80) : ''
  return fromArg || rule.model || rule.tool
}

/** Quantity in the rule's price unit; known=false when the argument it needs is missing (the call is then unpriced). */
export function quantityOf(rule, args) {
  const raw = args[rule.qtyArg]
  if (rule.kind === 'image') {
    const n = finite(raw)
    return { qty: n > 0 ? Math.floor(n) || 1 : 1, known: true }
  }
  if (rule.kind === 'speech') {
    const chars = typeof raw === 'string' ? raw.length : finite(raw)
    return chars > 0 ? { qty: chars / 1000, known: true } : { qty: 0, known: false }
  }
  const seconds = finite(raw)
  return seconds > 0 ? { qty: seconds / 60, known: true } : { qty: 0, known: false }
}

/**
 * Remember which tools were seen (name, call count, argument names only — never values), newest first,
 * so the settings page can offer them when writing a rule. Returns the same map.
 */
export function observeTool(observed, name, args, now) {
  const key = text(name, 120)
  if (!key) return observed
  const entry = observed[key] || (observed[key] = { calls: 0, last: 0, argKeys: [] })
  entry.calls += 1
  entry.last = now
  const names = Object.keys(args).slice(0, ARG_KEYS_CAP)
  if (names.length > 0) entry.argKeys = names
  // Only the value of a model-naming argument is kept (never prompts or other content): it tells which models a tool serves.
  const modelArg = names.find((n) => MODEL_ARG.test(n) && typeof args[n] === 'string' && args[n].trim() !== '')
  if (modelArg) {
    const value = text(args[modelArg], 80)
    const seen = (entry.models || []).filter((v) => v !== value)
    seen.push(value)
    entry.modelArg = modelArg
    entry.models = seen.slice(-MODEL_VALUES_CAP)
  }
  const keys = Object.keys(observed)
  if (keys.length > OBSERVED_CAP) {
    keys.sort((a, b) => observed[a].last - observed[b].last).slice(0, keys.length - OBSERVED_CAP).forEach((k) => { delete observed[k] })
  }
  return observed
}

/** Sanitise a persisted observed-tools map. */
export function sanitizeObserved(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(raw).slice(0, OBSERVED_CAP)) {
    const e = raw[key]
    if (!e || typeof e !== 'object') continue
    out[text(key, 120)] = {
      calls: Number.isFinite(e.calls) ? e.calls : 0,
      last: Number.isFinite(e.last) ? e.last : 0,
      argKeys: Array.isArray(e.argKeys) ? e.argKeys.filter((k) => typeof k === 'string').slice(0, ARG_KEYS_CAP) : [],
      modelArg: typeof e.modelArg === 'string' ? text(e.modelArg, 40) : '',
      models: Array.isArray(e.models) ? e.models.filter((v) => typeof v === 'string' && v !== '').map((v) => text(v, 80)).slice(-MODEL_VALUES_CAP) : [],
    }
  }
  return out
}
