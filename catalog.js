/**
 * OpenRouter price catalog: fetch the public model list, keep a compact cached copy, turn its prices into this plugin's
 * price shape and match them to the model names DSH reports.
 *
 * Only one fixed HTTPS address is ever contacted, nothing about the user is sent, and the browser half never talks to it:
 * the Host fetches, the page asks the Host. Prices are USD per million tokens (OpenRouter lists USD per token).
 * Nothing here decides when to fetch; index.js does (a button, or the opt-in daily refresh).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchJson } from './fetch-json.js'
import { PRICE_FIELDS, num, parsePeak, parseTiers } from './pricing.js'

export const CATALOG_URL = 'https://openrouter.ai/api/v1/models'
export const MAX_BODY_BYTES = 8 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 20_000
/** Match kinds that name the same model; "dated" (a version suffix was stripped) is only a hint a person should check. */
export const SURE_MATCHES = ['id', 'name', 'slug']
const CACHE_VERSION = 1
const FIELD_OF = { prompt: 'input', completion: 'output', input_cache_read: 'cacheRead', input_cache_write: 'cacheWrite' }
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/

/** USD per token (a string) → USD per million tokens; NaN for anything that is not a plain non-negative price. */
const perMillion = (value) => {
  if (value === undefined || value === null || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Number((n * 1e6).toPrecision(9)) : NaN
}

/** The stored shape of a price: known fields only, tiers and peak through the same sanitizers the settings use. */
function cleanPrice(src) {
  const price = { currency: 'USD' }
  for (const field of PRICE_FIELDS) price[field] = num(src && src[field])
  const tiers = parseTiers(src && src.tiers)
  if (tiers.length > 0) price.tiers = tiers
  const peak = parsePeak(src && src.peak)
  if (peak && peak.enabled && peak.windows.length > 0) price.peak = peak
  return price
}

/** Rates of one pricing block (the base or an override) in this plugin's field names; NaN marks a variable/invalid price. */
function ratesOf(block) {
  const rates = {}
  for (const key of Object.keys(FIELD_OF)) rates[FIELD_OF[key]] = perMillion(block && block[key])
  return rates
}

const sameRates = (a, b) => PRICE_FIELDS.every((field) => a[field] === b[field])
const hhmm = (n) => String(Math.floor(n / 100)).padStart(2, '0') + ':' + String(n % 100).padStart(2, '0')

/**
 * OpenRouter lists time-of-day prices as overrides by UTC day and start/end (HHMM). This plugin's peak model is
 * "one set of peak rates on weekdays inside up to two windows"; any listing that fits is converted, anything else is null.
 */
function derivePeak(base, overrides) {
  const windows = []
  let rates = null
  for (const o of overrides) {
    const days = Array.isArray(o.utc_days) ? o.utc_days : null
    if (days === null) return null
    const own = ratesOf(o)
    if (PRICE_FIELDS.some((field) => Number.isNaN(own[field]))) return null
    const same = sameRates(own, base)
    if (days.length === 2 && days.includes('saturday') && days.includes('sunday')) {
      if (!same) return null
      continue
    }
    if (days.length !== 5 || !WEEKDAYS.every((day) => days.includes(day))) return null
    if (!Number.isInteger(o.utc_start) || !Number.isInteger(o.utc_end)) return null
    if (same) continue
    if (rates !== null && !sameRates(rates, own)) return null
    rates = own
    windows.push({ start: hhmm(o.utc_start), end: hhmm(o.utc_end) })
  }
  if (windows.length === 0 || windows.length > 2) return null
  return Object.assign({ enabled: true, weekdaysOnly: true, windows }, rates)
}

/** One OpenRouter `pricing` block → { price, timeBased }, or null when the model has no fixed price (variable routers, bad data). */
export function convertPricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return null
  const base = ratesOf(pricing)
  if (PRICE_FIELDS.some((field) => Number.isNaN(base[field]))) return null
  const raw = Object.assign({}, base)
  const overrides = Array.isArray(pricing.overrides) ? pricing.overrides.filter((o) => o && typeof o === 'object') : []
  const timed = overrides.filter((o) => 'utc_days' in o || 'utc_start' in o || 'utc_end' in o)
  const sized = overrides.filter((o) => !timed.includes(o) && Number.isFinite(o.min_prompt_tokens))
  const tiers = []
  for (const o of sized) {
    const rates = ratesOf(o)
    if (PRICE_FIELDS.some((field) => Number.isNaN(rates[field]))) continue
    tiers.push(Object.assign({ above: o.min_prompt_tokens }, rates))
  }
  if (tiers.length > 0) raw.tiers = tiers
  let timeBased = false
  if (timed.length > 0) {
    const peak = derivePeak(base, timed)
    if (peak) raw.peak = peak
    else timeBased = true
  }
  return { price: cleanPrice(raw), timeBased }
}

const trimText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

function toEntry(item) {
  if (!item || typeof item.id !== 'string' || item.id === '') return null
  const converted = convertPricing(item.pricing)
  if (!converted) return null
  return {
    id: item.id.slice(0, 200),
    slug: trimText(item.canonical_slug, 200) || item.id.slice(0, 200),
    name: trimText(item.name, 120) || item.id.slice(0, 120),
    context: Number.isFinite(item.context_length) ? item.context_length : 0,
    price: converted.price,
    timeBased: converted.timeBased,
  }
}

/** The compact entries of an OpenRouter `/models` response; models without a fixed price are left out. */
export function parseCatalog(json) {
  const list = json && Array.isArray(json.data) ? json.data : []
  const entries = []
  for (const item of list) {
    const entry = toEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Cache entries are re-checked on load so a hand-edited file can only lose entries, never break the price list. */
function cleanEntry(entry) {
  if (!entry || typeof entry.id !== 'string' || entry.id === '' || !entry.price || typeof entry.price !== 'object') return null
  return {
    id: entry.id.slice(0, 200),
    slug: trimText(entry.slug, 200) || entry.id.slice(0, 200),
    name: trimText(entry.name, 120) || entry.id.slice(0, 120),
    context: Number.isFinite(entry.context) ? entry.context : 0,
    price: cleanPrice(entry.price),
    timeBased: entry.timeBased === true,
  }
}

// ---- matching ----

/** Lower case, no leading "~" (OpenRouter's alias marker), and version dots as hyphens: "claude-sonnet-4.5" = "claude-sonnet-4-5". */
const keyOf = (text) => String(text || '').trim().toLowerCase().replace(/^~/, '').replace(/(\d)\.(?=\d)/g, '$1-')
const nameOf = (id) => id.slice(id.indexOf('/') + 1)
const isPlain = (entry) => !entry.id.startsWith('~') && !entry.id.includes(':')

function buildIndex(entries) {
  const index = { id: new Map(), name: new Map(), slug: new Map(), byId: new Map() }
  const add = (map, key, entry) => {
    const list = map.get(key)
    if (!list) map.set(key, [entry])
    else if (!list.includes(entry)) list.push(entry)
  }
  for (const entry of entries) {
    index.byId.set(entry.id, entry)
    add(index.id, keyOf(entry.id), entry)
    add(index.name, keyOf(nameOf(entry.id)), entry)
    add(index.slug, keyOf(entry.slug), entry)
    add(index.slug, keyOf(nameOf(entry.slug)), entry)
  }
  return index
}

/** One candidate group → a single entry, or "ambiguous" when the candidates are priced differently (plain models win over variants and aliases). */
function pick(list) {
  const plain = list.filter(isPlain)
  const pool = plain.length > 0 ? plain : list
  const prices = new Set(pool.map((entry) => JSON.stringify(entry.price)))
  return prices.size === 1 ? { entry: pool[0] } : { ambiguous: pool.slice(0, 5).map((entry) => entry.id) }
}

function lookup(index, model) {
  const search = (key, suffix) => {
    for (const how of ['id', 'name', 'slug']) {
      const list = index[how].get(key)
      if (list) return Object.assign(pick(list), { how: suffix ? 'dated' : how })
    }
    return null
  }
  const key = keyOf(model)
  if (key === '') return null
  const found = search(key, false)
  if (found) return found
  return DATE_SUFFIX.test(key) ? search(key.replace(DATE_SUFFIX, ''), true) : null
}

// ---- fetching ----

function writeCache(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify(data))
    renameSync(temp, file)
    return true
  } catch { return false }
}

function readCache(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.models)) return null
    const entries = raw.models.map(cleanEntry).filter(Boolean)
    return { fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : null, entries }
  } catch { return null }
}

/**
 * The catalog service. `file` is the cache path. `fetchImpl` defaults to the global fetch, looked up on every call so tests
 * can stub it; `url` and `timeoutMs` are for tests too (the Host passes none of them).
 * Error codes of `refresh()`: busy, network, timeout, http (with `status`), too-large, bad-format.
 */
export function createCatalogService(deps) {
  const { file, now = Date.now, timeoutMs = FETCH_TIMEOUT_MS } = deps
  const url = deps.url || CATALOG_URL
  let entries = []
  let index = buildIndex(entries)
  let fetchedAt = null
  let error = null
  let refreshing = false

  const install = (list, at) => { entries = list; index = buildIndex(list); fetchedAt = at }
  const cached = readCache(file)
  if (cached) install(cached.entries, cached.fetchedAt)

  const fail = (code, status) => {
    error = { code, at: now() }
    if (status !== undefined) error.status = status
    return Object.assign({ ok: false, code }, status !== undefined ? { status } : null)
  }

  async function refresh() {
    if (refreshing) return { ok: false, code: 'busy' }
    refreshing = true
    try {
      const out = await fetchJson(url, { fetchImpl: deps.fetchImpl, timeoutMs, maxBytes: MAX_BODY_BYTES })
      if (!out.ok) return fail(out.code, out.status)
      const list = parseCatalog(out.json)
      if (list.length === 0) return fail('bad-format')
      install(list, now())
      error = null
      writeCache(file, { version: CACHE_VERSION, fetchedAt, models: list })
      return { ok: true, code: 'ok', count: list.length, fetchedAt }
    } finally {
      refreshing = false
    }
  }

  return {
    refresh,
    /** A model name → { entry, how } | { ambiguous: [ids], how } | null. */
    match: (model) => lookup(index, model),
    get: (id) => index.byId.get(String(id)) || null,
    /** Up to `limit` entries whose id or name contains every word of `query`; plain models first. */
    search(query, limit = 12) {
      const words = String(query || '').toLowerCase().split(/[\s/]+/).map(keyOf).filter(Boolean)
      if (words.length === 0) return []
      const rows = entries.filter((entry) => {
        const haystack = keyOf(entry.id) + ' ' + keyOf(entry.name)
        return words.every((word) => haystack.includes(word))
      })
      rows.sort((a, b) => (isPlain(a) ? 0 : 1) - (isPlain(b) ? 0 : 1) || a.id.length - b.id.length || a.id.localeCompare(b.id))
      return rows.slice(0, limit)
    },
    /** For the polled snapshot: small, no entries. */
    snapshot: () => ({ fetchedAt, count: entries.length, refreshing, error }),
    /** Cache age in ms, or Infinity without a cache. */
    age: () => (fetchedAt === null ? Infinity : now() - fetchedAt),
  }
}
