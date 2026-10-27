// Run: node --test test/balance.test.mjs
// Account balances: what each provider's answer is read as, what a custom account may point at, that keys stay on the
// Host side and in an owner-only file, and the failure codes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTO_MIN_GAP_MS, MAX_ACCOUNTS, cleanUrl, createBalanceService, valueAt } from '../balance.js'
import { startHost } from './host-harness.mjs'

const KEY = 'sk-test-0123456789abcdef'
const reply = (json, init) => new Response(typeof json === 'string' ? json : JSON.stringify(json), init)

const DEEPSEEK = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }, { currency: 'USD', total_balance: '2.5', granted_balance: '0', topped_up_balance: '2.5' }] }
const KIMI = { code: 123, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: '0x0', status: true }
const SILICONFLOW = { code: 20000, message: 'OK', status: true, data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88', status: 'normal' } }
const OPENROUTER = { data: { total_credits: 100.5, total_usage: 25.75 } }

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'cost-meter-balance-'))
  return { dir, file: join(dir, 'balance.json') }
}
/** A service whose fetch is `respond(url, init)`; `seen` records the requests. */
function serviceWith(respond, extra) {
  const { file } = fresh()
  const seen = []
  const service = createBalanceService(Object.assign({ file, fetchImpl: async (url, init) => { seen.push({ url, init }); return respond(url, init) } }, extra))
  return { service, seen, file }
}
const add = (service, input) => {
  const out = service.save(input)
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.id
}
const accountOf = (service, id) => service.snapshot().accounts.find((account) => account.id === id)

test('each provider answer is read into money rows, asked at its own address with the key as a bearer token', async () => {
  const cases = [
    ['deepseek', DEEPSEEK, 'https://api.deepseek.com/user/balance', [['CNY', 110, [['granted', 10], ['toppedUp', 100]]], ['USD', 2.5, [['granted', 0], ['toppedUp', 2.5]]]]],
    ['kimi-cn', KIMI, 'https://api.moonshot.cn/v1/users/me/balance', [['CNY', 49.58894, [['granted', 46.58893], ['toppedUp', 3.00001]]]]],
    ['kimi-global', KIMI, 'https://api.moonshot.ai/v1/users/me/balance', [['USD', 49.58894, [['granted', 46.58893], ['toppedUp', 3.00001]]]]],
    ['siliconflow', SILICONFLOW, 'https://api.siliconflow.cn/v1/user/info', [['CNY', 88.88, [['granted', 0.88], ['toppedUp', 88]]]]],
    ['openrouter', OPENROUTER, 'https://openrouter.ai/api/v1/credits', [['USD', 74.75, [['toppedUp', 100.5], ['used', 25.75]]]]],
  ]
  for (const [provider, json, url, rows] of cases) {
    const { service, seen } = serviceWith(() => reply(json))
    const id = add(service, { provider, key: KEY })
    const out = await service.refresh(id)
    assert.deepEqual([out.ok, out.code], [true, 'ok'], provider)
    assert.equal(seen[0].url, url)
    assert.equal(seen[0].init.headers.authorization, 'Bearer ' + KEY)
    assert.equal(seen[0].init.redirect, 'error', 'a redirect could carry the key to another host')
    const shown = accountOf(service, id).result.rows.map((row) => [row.currency, row.total, row.parts.map((part) => [part.kind, part.amount])])
    assert.deepEqual(shown, rows, provider)
    assert.equal(accountOf(service, id).error, null)
  }
})

test('DeepSeek says when the balance no longer covers calls; Kimi decides by shape, not by its inconsistent code', async () => {
  const { service } = serviceWith(() => reply(Object.assign({}, DEEPSEEK, { is_available: false })))
  const id = add(service, { provider: 'deepseek', key: KEY })
  await service.refresh(id)
  assert.equal(accountOf(service, id).result.available, false)

  const kimi = serviceWith(() => reply({ code: 0, data: { available_balance: -2, voucher_balance: 0, cash_balance: -2 } }))
  const kid = add(kimi.service, { provider: 'kimi-cn', key: KEY })
  await kimi.service.refresh(kid)
  assert.equal(accountOf(kimi.service, kid).result.rows[0].total, -2)
  assert.equal(accountOf(kimi.service, kid).result.available, false)
})

test('a custom account reads one number at a dot path, from a number or a numeric string', async () => {
  const body = { data: { wallet: [{ left: '12.5' }], plain: 7 } }
  const { service, seen } = serviceWith(() => reply(body))
  const id = add(service, { provider: 'custom', label: 'Gateway', url: 'https://gw.example.com/api/balance', path: 'data.wallet.0.left', currency: 'cny', key: KEY })
  assert.equal(accountOf(service, id).currency, 'CNY')
  await service.refresh(id)
  assert.deepEqual(accountOf(service, id).result.rows, [{ currency: 'CNY', total: 12.5, parts: [] }])
  assert.equal(seen[0].url, 'https://gw.example.com/api/balance')

  service.save({ id, provider: 'custom', url: 'https://gw.example.com/api/balance', path: 'data.plain', currency: 'CNY' })
  await service.refresh(id)
  assert.equal(accountOf(service, id).result.rows[0].total, 7)

  service.save({ id, provider: 'custom', url: 'https://gw.example.com/api/balance', path: 'data.missing', currency: 'CNY' })
  const lost = await service.refresh(id)
  assert.deepEqual([lost.ok, lost.code], [false, 'no-value'])
  assert.equal(valueAt({ a: {} }, 'a.__proto__'), undefined, 'only own properties are followed')
  assert.equal(valueAt({ a: [5] }, 'a.0'), 5)
})

test('what a custom account may point at: https (http only on this machine), no credentials, query, fragment or odd paths', () => {
  assert.equal(cleanUrl('https://gw.example.com/v1/balance'), 'https://gw.example.com/v1/balance')
  assert.equal(cleanUrl('http://127.0.0.1:3000/balance'), 'http://127.0.0.1:3000/balance')
  assert.equal(cleanUrl('http://localhost/balance'), 'http://localhost/balance')
  for (const bad of ['http://gw.example.com/balance', 'ftp://gw.example.com/x', 'https://user:pass@gw.example.com/x', 'https://gw.example.com/x?token=abc', 'https://gw.example.com/x#top', 'not a url', '', 42, 'https://' + 'a'.repeat(300) + '.com']) {
    assert.equal(cleanUrl(bad), null, String(bad))
  }
  const { service } = serviceWith(() => reply({}))
  const base = { provider: 'custom', url: 'https://gw.example.com/b', path: 'data.balance', currency: 'USD' }
  assert.equal(service.save(Object.assign({}, base, { url: 'http://gw.example.com/b' })).code, 'bad-url')
  for (const path of ['', 'data..balance', 'data.balance[0]', '../x', 'a b']) assert.equal(service.save(Object.assign({}, base, { path })).code, 'bad-path', path)
  for (const currency of ['', 'US', 'DOLLAR', '12$', undefined]) assert.equal(service.save(Object.assign({}, base, { currency })).code, 'bad-currency', String(currency))
  for (const key of ['has space', 'new\nline', 'x'.repeat(513), 5]) assert.equal(service.save(Object.assign({}, base, { key })).code, 'bad-key', String(key).slice(0, 12))
  assert.equal(service.save({ provider: 'nope' }).code, 'bad-provider')
  assert.equal(service.save({ provider: '__proto__' }).code, 'bad-provider')
  assert.equal(service.save({ id: 'b9', provider: 'deepseek' }).code, 'missing-account')
  assert.equal(service.snapshot().accounts.length, 0, 'a rejected save stores nothing')
})

test('keys never reach the snapshot; the file holds them and is owner-only', async (t) => {
  const { service, file } = serviceWith(() => reply(OPENROUTER))
  const id = add(service, { provider: 'openrouter', key: KEY })
  await service.refresh(id)
  const shown = JSON.stringify(service.snapshot())
  assert.equal(shown.includes(KEY), false)
  assert.equal(accountOf(service, id).hasKey, true)
  assert.equal(readFileSync(file, 'utf8').includes(KEY), true)
  if (process.platform === 'win32') t.skip('no file modes on Windows')
  else assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('a key is replaced, cleared on request, and dropped when a custom address moves to another host', async () => {
  const { service } = serviceWith(() => reply({ v: 1 }))
  const body = { provider: 'custom', url: 'https://gw.example.com/b', path: 'v', currency: 'USD' }
  const id = add(service, Object.assign({ key: KEY }, body))
  assert.equal(accountOf(service, id).hasKey, true)

  // Editing without a key keeps it, also when only the path or the label changes.
  assert.equal(service.save(Object.assign({ id }, body, { label: 'Renamed', path: 'w' })).keyDropped, false)
  assert.equal(accountOf(service, id).hasKey, true)

  // Same host, other path on it: still the same destination for the key.
  service.save(Object.assign({ id }, body, { url: 'https://gw.example.com/other' }))
  assert.equal(accountOf(service, id).hasKey, true)

  // Another host: the key does not travel with the new address.
  const moved = service.save(Object.assign({ id }, body, { url: 'https://other.example.net/b' }))
  assert.deepEqual([moved.ok, moved.keyDropped], [true, true])
  assert.equal(accountOf(service, id).hasKey, false)
  assert.equal((await service.refresh(id)).code, 'no-key')

  // A new key given together with the new host is kept.
  service.save(Object.assign({ id, key: 'sk-second-key' }, body, { url: 'https://third.example.org/b' }))
  assert.equal(accountOf(service, id).hasKey, true)

  assert.equal(service.save(Object.assign({ id, clearKey: true }, body, { url: 'https://third.example.org/b' })).keyDropped, false)
  assert.equal(accountOf(service, id).hasKey, false)
})

test('failures come back as stable codes and keep the last good answer', async () => {
  let respond = () => reply(DEEPSEEK)
  const { service } = serviceWith((url, init) => respond(url, init), { timeoutMs: 30 })
  const id = add(service, { provider: 'deepseek', key: KEY })
  await service.refresh(id)
  const good = accountOf(service, id).result
  assert.equal(good.rows.length, 2)

  const failures = [
    [() => { throw new Error('connect ECONNREFUSED with ' + KEY) }, 'network', undefined],
    [(url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), 'timeout', undefined],
    [() => reply('nope', { status: 401 }), 'unauthorized', 401],
    [() => reply('nope', { status: 403 }), 'unauthorized', 403],
    [() => reply('nope', { status: 500 }), 'http', 500],
    [() => reply('<html>'), 'bad-format', undefined],
    [() => reply({ unexpected: true }), 'bad-format', undefined],
    [() => reply('{"a":"' + 'x'.repeat(300_000) + '"}'), 'too-large', undefined],
  ]
  for (const [make, code, status] of failures) {
    respond = make
    const out = await service.refresh(id)
    assert.deepEqual([out.ok, out.code, out.status], [false, code, status], code)
    const view = accountOf(service, id)
    assert.equal(view.error.code, code)
    assert.deepEqual(view.result, good, 'the last good answer stays visible')
    assert.equal(JSON.stringify(service.snapshot()).includes(KEY), false, 'an error never echoes the key')
  }
  respond = () => reply(DEEPSEEK)
  await service.refresh(id)
  assert.equal(accountOf(service, id).error, null, 'a good answer clears the error')
})

test('a request is dropped when its account was edited meanwhile, and a second one is refused while one runs', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { service } = serviceWith(async () => { await gate; return reply(DEEPSEEK) })
  const id = add(service, { provider: 'deepseek', key: KEY })
  const first = service.refresh(id)
  assert.equal(accountOf(service, id).busy, true)
  assert.equal((await service.refresh(id)).code, 'busy')
  service.save({ id, key: 'sk-replaced-key' })
  release()
  assert.equal((await first).code, 'changed')
  assert.equal(accountOf(service, id).result, null, 'an answer to the old key is not stored')
  assert.equal(accountOf(service, id).busy, false)
})

test('accounts survive a restart with their key and last answer; a damaged or foreign file is ignored', async () => {
  const { service, file } = serviceWith(() => reply(SILICONFLOW))
  const id = add(service, { provider: 'siliconflow', label: 'Mine', key: KEY })
  await service.refresh(id)
  const again = createBalanceService({ file })
  assert.deepEqual(again.snapshot().accounts, service.snapshot().accounts)
  assert.equal((await createBalanceService({ file, fetchImpl: async () => reply(SILICONFLOW) }).refresh(id)).code, 'ok', 'the stored key is still usable')

  writeFileSync(file, '{ not json')
  assert.deepEqual(createBalanceService({ file }).snapshot().accounts, [])
  writeFileSync(file, JSON.stringify({ version: 1, accounts: [{ id: 'b1', provider: 'ghost', key: KEY }, { id: 'b2', provider: 'custom', url: 'http://evil.example.com/x', path: 'a', currency: 'USD' }, { id: 'oops', provider: 'deepseek' }, { id: 'b3', provider: 'deepseek', key: 'bad key with spaces' }] }))
  const loaded = createBalanceService({ file }).snapshot().accounts
  assert.deepEqual(loaded.map((account) => [account.id, account.hasKey]), [['b3', false]])
})

test('the number of accounts is capped and ids are not reused while their account exists', () => {
  const { service } = serviceWith(() => reply({}))
  const ids = []
  for (let n = 0; n < MAX_ACCOUNTS; n++) ids.push(add(service, { provider: 'deepseek' }))
  assert.equal(new Set(ids).size, MAX_ACCOUNTS)
  assert.equal(service.save({ provider: 'deepseek' }).code, 'too-many')
  assert.equal(service.remove(ids[0]).code, 'ok')
  assert.equal(service.remove(ids[0]).code, 'missing-account')
  assert.equal(add(service, { provider: 'deepseek' }), ids[0])
})

test('the timer asks only accounts with a key that were not asked in the last minutes', async () => {
  let clock = 1_000_000
  const { service, seen } = serviceWith(() => reply(DEEPSEEK), { now: () => clock })
  add(service, { provider: 'deepseek', key: KEY })
  add(service, { provider: 'deepseek' })
  assert.deepEqual(Object.keys(await service.refreshAll(true)).length, 1)
  assert.equal(seen.length, 1)
  clock += AUTO_MIN_GAP_MS - 1
  await service.refreshAll(true)
  assert.equal(seen.length, 1, 'asked a moment ago')
  clock += 2
  await service.refreshAll(true)
  assert.equal(seen.length, 2)
  await service.refreshAll(false)
  assert.equal(seen.length, 3, 'the button always asks')
})

async function withBalance(body) {
  if (!process.env.DSH_HOME) process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cost-meter-'))
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return reply(DEEPSEEK) }
  const host = await startHost()
  try {
    await body(host, requests)
  } finally {
    globalThis.fetch = original
    host.dispose()
  }
}

test('host: add, ask, edit and remove an account through the actions; the key is not in what the page polls', async () => {
  await withBalance(async (host, requests) => {
    assert.deepEqual(host.get().balance.accounts, [])
    assert.equal(host.get().balance.providers.some((p) => p.id === 'openrouter' && p.keyKind === 'management'), true)

    const saved = await host.post({ action: 'balance-save', provider: 'deepseek', key: KEY })
    assert.deepEqual([saved.ok, saved.id], [true, 'b1'])
    assert.equal(requests.length, 0, 'saving contacts nobody')
    assert.equal(JSON.stringify(saved).includes(KEY), false)

    const asked = await host.post({ action: 'balance-refresh', id: 'b1' })
    assert.deepEqual([asked.ok, requests.length], [true, 1])
    assert.equal(requests[0].init.headers.authorization, 'Bearer ' + KEY)
    assert.equal(host.get().balance.accounts[0].result.rows[0].total, 110)
    assert.equal(JSON.stringify(host.get()).includes(KEY), false)

    const all = await host.post({ action: 'balance-refresh' })
    assert.deepEqual([all.ok, Object.keys(all.results)], [true, ['b1']])
    assert.equal((await host.post({ action: 'balance-refresh', id: 'nope' })).code, 'missing-account')
    assert.equal((await host.post({ action: 'balance-save', id: 'b1', label: 'Work' })).ok, true)
    assert.equal(host.get().balance.accounts[0].label, 'Work')
    assert.equal((await host.post({ action: 'balance-remove', id: 'b1' })).balance.accounts.length, 0)
  })
})

test('host: nothing is asked on a timer until that is switched on, and switching it on asks at once', async () => {
  await withBalance(async (host, requests) => {
    assert.deepEqual([host.get().prefs.balanceAuto, host.get().prefs.sideBalance], [false, true])
    await host.post({ action: 'balance-save', provider: 'deepseek', key: KEY })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(requests.length, 0)
    await host.post({ action: 'set-prefs', prefs: { balanceAuto: true } })
    for (let i = 0; i < 100 && requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(requests.length, 1)
  })
})
