/**
 * Account balance queries: the user adds a provider account and its API key, the Host asks that provider's own balance
 * endpoint on a click (or, opt-in, on a timer) and keeps the last answer.
 *
 * Keys live only in a separate file ($DSH_HOME/cost-meter.balance.json, mode 0600 where the OS has modes) and are only ever
 * sent as `Authorization: Bearer` to the account's own endpoint. They never leave this module: the snapshot carries
 * `hasKey`, and an error carries a code, never a response body or a message that could echo a secret. Preset accounts talk to a fixed
 * address; a custom account's address is the user's and a key is dropped when its host changes, so an edited address cannot
 * carry a saved key somewhere else. No redirects are followed (fetch-json.js).
 *
 * Codes (every answer has `ok` and `code`): ok, missing-account, no-key, busy, changed (the account was edited during the
 * request), bad-provider, bad-url, bad-path, bad-currency, bad-key, too-many, write-failed, plus the answer's own failures:
 * network, timeout, unauthorized (401/403), http (with `status`), too-large, bad-format (not the expected shape), no-value
 * (a custom path that does not lead to a number).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchJson } from './fetch-json.js'

export const MAX_ACCOUNTS = 8
export const FETCH_TIMEOUT_MS = 15_000
export const MAX_BODY_BYTES = 256 * 1024
/** The opt-in timer skips an account that was asked more recently than this. */
export const AUTO_MIN_GAP_MS = 5 * 60_000
const FILE_VERSION = 1
const MAX_KEY_LENGTH = 512
const MAX_LABEL_LENGTH = 40
const MAX_URL_LENGTH = 300
const PATH_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
const KEY_PATTERN = /^[\x21-\x7e]+$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

// ---- reading an answer ----

const own = (obj, key) => obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)

/** A finite number from a number or a plain numeric string (providers send either); null for anything else. */
export function amountOf(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** The value at a dot path ("data.balance", "items.0.amount"); only own properties are followed. */
export function valueAt(json, path) {
  let cur = json
  for (const part of String(path).split('.')) {
    if (!own(cur, part)) return undefined
    cur = cur[part]
  }
  return cur
}

const row = (currency, total, parts) => ({ currency, total, parts: parts.filter((part) => part.amount !== null) })
const part = (kind, value) => ({ kind, amount: amountOf(value) })

function parseDeepSeek(json) {
  const infos = json && Array.isArray(json.balance_infos) ? json.balance_infos : null
  if (!infos) return null
  const rows = []
  for (const info of infos) {
    const total = amountOf(info && info.total_balance)
    const currency = info && typeof info.currency === 'string' ? info.currency.toUpperCase() : ''
    if (total !== null && /^[A-Z]{3}$/.test(currency)) rows.push(row(currency, total, [part('granted', info.granted_balance), part('toppedUp', info.topped_up_balance)]))
  }
  return rows.length > 0 ? { rows, available: typeof json.is_available === 'boolean' ? json.is_available : undefined } : null
}

/** Moonshot / Kimi: `code` is documented inconsistently, so the shape decides, not the code. Cash can be negative on overdraft. */
const parseKimi = (currency) => (json) => {
  const data = json && json.data
  const total = amountOf(data && data.available_balance)
  if (total === null) return null
  return { rows: [row(currency, total, [part('granted', data.voucher_balance), part('toppedUp', data.cash_balance)])], available: total > 0 }
}

function parseSiliconFlow(json) {
  const data = json && json.data
  if (!data || typeof data !== 'object') return null
  const gift = amountOf(data.balance)
  const charged = amountOf(data.chargeBalance)
  const total = amountOf(data.totalBalance) !== null ? amountOf(data.totalBalance) : gift !== null && charged !== null ? gift + charged : null
  return total === null ? null : { rows: [row('CNY', total, [part('granted', data.balance), part('toppedUp', data.chargeBalance)])] }
}

/** OpenRouter /credits: purchased minus used, in USD. Needs a management key. */
function parseOpenRouter(json) {
  const data = json && json.data
  const bought = amountOf(data && data.total_credits)
  const used = amountOf(data && data.total_usage)
  if (bought === null || used === null) return null
  return { rows: [row('USD', Number((bought - used).toFixed(6)), [part('toppedUp', bought), part('used', used)])] }
}

export const PROVIDERS = {
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/user/balance', parse: parseDeepSeek },
  'kimi-cn': { name: 'Kimi (moonshot.cn)', url: 'https://api.moonshot.cn/v1/users/me/balance', parse: parseKimi('CNY') },
  'kimi-global': { name: 'Kimi (moonshot.ai)', url: 'https://api.moonshot.ai/v1/users/me/balance', parse: parseKimi('USD') },
  siliconflow: { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1/user/info', parse: parseSiliconFlow },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/credits', parse: parseOpenRouter, keyKind: 'management' },
}
export const CUSTOM = 'custom'

/** What to ask and how to read it for one account: `{ url, read(json) → { rows, available? } | { code } }`. */
function endpointOf(account) {
  if (account.provider === CUSTOM) {
    return {
      url: account.url,
      read(json) {
        const total = amountOf(valueAt(json, account.path))
        return total === null ? { code: 'no-value' } : { rows: [row(account.currency, total, [])] }
      },
    }
  }
  const preset = PROVIDERS[account.provider]
  return { url: preset.url, read: (json) => preset.parse(json) || { code: 'bad-format' } }
}

// ---- validating what the user typed ----

/** A custom endpoint: https (http only for this machine), no credentials, query or fragment; null when not acceptable. */
export function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null
  let url
  try { url = new URL(value.trim()) } catch { return null }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  if (!secure || url.hostname === '' || url.username || url.password || url.search || url.hash) return null
  return url.href
}

const cleanLabel = (value, fallback) => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL_LENGTH) : ''
  return text || fallback
}

const newId = (accounts) => {
  for (let n = 1; ; n++) if (!accounts.some((account) => account.id === 'b' + n)) return 'b' + n
}

// ---- storage ----

function cleanAccount(raw) {
  if (!raw || typeof raw.id !== 'string' || !/^b\d+$/.test(raw.id)) return null
  const provider = raw.provider
  if (provider !== CUSTOM && !own(PROVIDERS, provider)) return null
  const account = { id: raw.id, provider, label: cleanLabel(raw.label, provider === CUSTOM ? raw.id : PROVIDERS[provider].name), key: typeof raw.key === 'string' && KEY_PATTERN.test(raw.key) && raw.key.length <= MAX_KEY_LENGTH ? raw.key : '' }
  if (provider === CUSTOM) {
    const url = cleanUrl(raw.url)
    if (url === null || typeof raw.path !== 'string' || !PATH_PATTERN.test(raw.path) || !/^[A-Z]{3}$/.test(raw.currency)) return null
    Object.assign(account, { url, path: raw.path, currency: raw.currency })
  }
  const result = raw.result
  if (result && Number.isFinite(result.at) && Array.isArray(result.rows)) {
    const rows = result.rows.filter((r) => r && /^[A-Z]{3}$/.test(r.currency) && amountOf(r.total) !== null)
      .map((r) => row(r.currency, r.total, (Array.isArray(r.parts) ? r.parts : []).map((p) => part(p && p.kind, p && p.amount)).filter((p) => ['granted', 'toppedUp', 'used'].includes(p.kind))))
    if (rows.length > 0) account.result = { at: result.at, rows, available: typeof result.available === 'boolean' ? result.available : undefined }
  }
  if (raw.error && Number.isFinite(raw.error.at) && typeof raw.error.code === 'string') account.error = { at: raw.error.at, code: raw.error.code, status: Number.isInteger(raw.error.status) ? raw.error.status : undefined }
  return account
}

function readAccounts(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || raw.version !== FILE_VERSION || !Array.isArray(raw.accounts)) return []
    return raw.accounts.map(cleanAccount).filter(Boolean).slice(0, MAX_ACCOUNTS)
  } catch { return [] }
}

/** Atomic write, owner-only; false when it failed. */
function writeAccounts(file, accounts) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, accounts }), { mode: 0o600 })
    try { chmodSync(temp, 0o600) } catch { /* the file system has no modes */ }
    renameSync(temp, file)
    return true
  } catch { return false }
}

// ---- the service ----

/**
 * `deps`: `file`; `now`, `fetchImpl` (defaults to the global fetch, looked up per call) and `timeoutMs` are for tests.
 */
export function createBalanceService(deps) {
  const { file, now = Date.now, timeoutMs = FETCH_TIMEOUT_MS } = deps
  let accounts = readAccounts(file)
  const busy = new Set()

  const find = (id) => accounts.find((account) => account.id === id)
  const triedAt = (account) => Math.max(account.result ? account.result.at : 0, account.error ? account.error.at : 0)

  /** Replace the account list on disk first; the in-memory list only follows a successful write. */
  const commit = (next) => {
    if (!writeAccounts(file, next)) return false
    accounts = next
    return true
  }

  /** The browser's view of an account: everything but the key. */
  const view = (account) => {
    const out = { id: account.id, provider: account.provider, label: account.label, hasKey: account.key !== '', busy: busy.has(account.id), result: account.result || null, error: account.error || null }
    if (account.provider === CUSTOM) Object.assign(out, { url: account.url, path: account.path, currency: account.currency })
    return out
  }

  const snapshot = () => ({
    max: MAX_ACCOUNTS,
    providers: Object.keys(PROVIDERS).map((id) => ({ id, name: PROVIDERS[id].name, keyKind: PROVIDERS[id].keyKind || 'standard' })),
    accounts: accounts.map(view),
  })

  /**
   * Create (no `id`) or edit an account. `key` replaces the stored key, `clearKey` removes it; an edited custom address on
   * another host drops the stored key unless a new one comes along. A preset's provider cannot change.
   */
  function save(body) {
    const input = body && typeof body === 'object' ? body : {}
    const existing = input.id !== undefined ? find(String(input.id)) : null
    if (input.id !== undefined && !existing) return { ok: false, code: 'missing-account' }
    if (!existing && accounts.length >= MAX_ACCOUNTS) return { ok: false, code: 'too-many' }
    const provider = existing ? existing.provider : input.provider
    if (provider !== CUSTOM && !own(PROVIDERS, provider)) return { ok: false, code: 'bad-provider' }

    const next = { id: existing ? existing.id : newId(accounts), provider, label: '', key: existing ? existing.key : '' }
    if (provider === CUSTOM) {
      const url = cleanUrl(input.url)
      if (url === null) return { ok: false, code: 'bad-url' }
      if (typeof input.path !== 'string' || !PATH_PATTERN.test(input.path.trim())) return { ok: false, code: 'bad-path' }
      const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
      if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, code: 'bad-currency' }
      Object.assign(next, { url, path: input.path.trim(), currency })
      if (existing && new URL(existing.url).host !== new URL(url).host) next.key = ''
    }
    next.label = cleanLabel(input.label, provider === CUSTOM ? new URL(next.url).hostname : PROVIDERS[provider].name)
    if (input.clearKey === true) next.key = ''
    if (input.key !== undefined && input.key !== '') {
      if (typeof input.key !== 'string' || input.key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(input.key)) return { ok: false, code: 'bad-key' }
      next.key = input.key
    }
    // The old answer belongs to the old endpoint, key and path.
    const same = existing && next.key === existing.key && next.url === existing.url && next.path === existing.path && next.currency === existing.currency
    if (same && existing.result) next.result = existing.result
    if (same && existing.error) next.error = existing.error

    if (!commit(existing ? accounts.map((account) => (account === existing ? next : account)) : accounts.concat(next))) return { ok: false, code: 'write-failed' }
    return { ok: true, code: 'ok', id: next.id, keyDropped: Boolean(existing && existing.key !== '' && next.key === '' && input.clearKey !== true) }
  }

  function remove(id) {
    const account = find(String(id))
    if (!account) return { ok: false, code: 'missing-account' }
    return commit(accounts.filter((item) => item !== account)) ? { ok: true, code: 'ok' } : { ok: false, code: 'write-failed' }
  }

  /** Ask one account's provider. The answer is dropped when the account was edited or removed while the request ran. */
  async function refresh(id) {
    const account = find(String(id))
    if (!account) return { ok: false, code: 'missing-account' }
    if (account.key === '') return { ok: false, code: 'no-key' }
    if (busy.has(account.id)) return { ok: false, code: 'busy' }
    busy.add(account.id)
    try {
      const target = endpointOf(account)
      const out = await fetchJson(target.url, { fetchImpl: deps.fetchImpl, headers: { authorization: 'Bearer ' + account.key }, timeoutMs, maxBytes: MAX_BODY_BYTES })
      const current = find(account.id)
      if (!current || current.key !== account.key || current.url !== account.url || current.path !== account.path || current.currency !== account.currency) return { ok: false, code: 'changed' }
      const at = now()
      let failure = null
      let read = null
      if (!out.ok) failure = { code: out.code === 'http' && (out.status === 401 || out.status === 403) ? 'unauthorized' : out.code, status: out.code === 'http' ? out.status : undefined }
      else {
        read = target.read(out.json)
        if (read.code) failure = { code: read.code }
      }
      const updated = Object.assign({}, current)
      if (failure) updated.error = { at, code: failure.code, status: failure.status }
      else {
        updated.result = { at, rows: read.rows, available: read.available }
        delete updated.error
      }
      // Memory follows even when the disk write fails: the answer is cheap to ask again and is not a setting.
      const next = accounts.map((item) => (item === current ? updated : item))
      writeAccounts(file, next)
      accounts = next
      return failure ? Object.assign({ ok: false, code: failure.code }, failure.status !== undefined ? { status: failure.status } : null) : { ok: true, code: 'ok' }
    } finally {
      busy.delete(account.id)
    }
  }

  /** Every account with a key, one after the other; `onlyDue` skips the ones asked recently (the timer). */
  async function refreshAll(onlyDue) {
    const results = {}
    for (const account of accounts.slice()) {
      if (account.key === '') continue
      if (onlyDue && now() - triedAt(account) < AUTO_MIN_GAP_MS) continue
      results[account.id] = await refresh(account.id)
    }
    return results
  }

  /** The Host action surface; null for an action that is not about balances. */
  function handle(body) {
    const answer = (res) => Object.assign({}, res, { balance: snapshot() })
    switch (body && body.action) {
      case 'balance-save': return answer(save(body))
      case 'balance-remove': return answer(remove(body.id))
      case 'balance-refresh':
        return (body.id === undefined ? refreshAll(false).then((results) => ({ ok: true, code: 'ok', results })) : refresh(body.id)).then(answer)
      default: return null
    }
  }

  return { snapshot, save, remove, refresh, refreshAll, handle, count: () => accounts.length }
}
