// Run: node --test test/catalog.test.mjs
// The OpenRouter price catalog: conversion, name matching, fetching with its failure codes, and what the Host does with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertPricing, createCatalogService, parseCatalog } from '../catalog.js'
import { startHost } from './host-harness.mjs'

const model = (id, pricing, extra) => Object.assign({ id, canonical_slug: id, name: 'Vendor: ' + id, context_length: 100000, pricing }, extra)
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const FLASH = { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000003' }
const FLASH_PEAK = { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.000000006' }
const timed = (days, start, end, rates) => Object.assign({ utc_days: days, utc_start: start, utc_end: end }, rates)

const TERRA = { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.00000005', input_cache_write: '0.00000125', web_search: '0.01', overrides: [{ min_prompt_tokens: 272000, prompt: '0.000002', completion: '0.0000075', input_cache_read: '0.0000001', input_cache_write: '0.0000025' }] }
const catalogJson = (over) => ({
  data: [
    model('openai/gpt-6.1-terra', TERRA),
    model('openai/gpt-6.1-terra:batch', { prompt: '0.0000005', completion: '0.0000025' }),
    model('zed/zeta-1', TERRA),
    model('anthropic/claude-sonnet-4.5', { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' }, { canonical_slug: 'anthropic/claude-sonnet-4.5-20250929' }),
    model('deepseek/deepseek-v4.1-flash', Object.assign({}, FLASH, {
      overrides: [
        timed(['saturday', 'sunday'], undefined, undefined, FLASH),
        timed(WEEKDAYS, 0, 100, FLASH),
        timed(WEEKDAYS, 100, 400, FLASH_PEAK),
        timed(WEEKDAYS, 400, 600, FLASH),
        timed(WEEKDAYS, 600, 1000, FLASH_PEAK),
        timed(WEEKDAYS, 1000, 0, FLASH),
      ],
    })),
    model('typesafe/jev-router', { prompt: '-1', completion: '-1' }),
    model('acme/shared-name', { prompt: '0.000001', completion: '0.000002' }),
    model('other/shared-name', { prompt: '0.000002', completion: '0.000004' }),
    model('~acme/alias-latest', { prompt: '0.000001', completion: '0.000001' }),
    model('acme/free-model:free', { prompt: '0', completion: '0' }),
  ].concat(over || []),
})
const reply = (json, init) => new Response(typeof json === 'string' ? json : JSON.stringify(json), init)

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'cost-meter-catalog-'))
  return { dir, file: join(dir, 'catalog.json') }
}
const serviceWith = (respond, extra) => {
  const { file } = fresh()
  return createCatalogService(Object.assign({ file, fetchImpl: async (url, init) => respond(url, init) }, extra))
}

test('prices become USD per million tokens, with context tiers from the size overrides', () => {
  const { price, timeBased } = convertPricing(TERRA)
  assert.deepEqual(price, {
    currency: 'USD', input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
    tiers: [{ above: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
  })
  assert.equal(timeBased, false)
  assert.equal(convertPricing({ prompt: '0.000003', completion: '0.000015' }).price.input, 3, 'no floating point noise')
})

test('weekday time-of-day overrides that fit become a peak schedule; others are flagged, not guessed', () => {
  const flash = convertPricing(catalogJson().data.find((m) => m.id === 'deepseek/deepseek-v4.1-flash').pricing)
  assert.equal(flash.timeBased, false)
  assert.deepEqual(flash.price.peak, {
    enabled: true, weekdaysOnly: true, windows: [{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }],
    input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0,
  })
  const threeWindows = Object.assign({}, FLASH, { overrides: [timed(WEEKDAYS, 100, 200, FLASH_PEAK), timed(WEEKDAYS, 300, 400, FLASH_PEAK), timed(WEEKDAYS, 500, 600, FLASH_PEAK)] })
  const mixedRates = Object.assign({}, FLASH, { overrides: [timed(WEEKDAYS, 100, 200, FLASH_PEAK), timed(WEEKDAYS, 300, 400, { prompt: '0.0000009', completion: '0.000002' })] })
  const weekendDiffers = Object.assign({}, FLASH, { overrides: [timed(['saturday', 'sunday'], undefined, undefined, FLASH_PEAK)] })
  const noDays = Object.assign({}, FLASH, { overrides: [{ utc_start: 0, utc_end: 100, prompt: '0.0000009', completion: '0.000002' }] })
  for (const pricing of [threeWindows, mixedRates, weekendDiffers, noDays]) {
    const out = convertPricing(pricing)
    assert.equal(out.timeBased, true)
    assert.equal(out.price.peak, undefined)
    assert.equal(out.price.input, 0.15, 'the base price still comes through')
  }
})

test('models without a fixed price are left out; free models stay at zero', () => {
  const ids = parseCatalog(catalogJson()).map((entry) => entry.id)
  assert.equal(ids.includes('typesafe/jev-router'), false)
  const free = parseCatalog(catalogJson()).find((entry) => entry.id === 'acme/free-model:free')
  assert.deepEqual([free.price.input, free.price.output], [0, 0])
  assert.deepEqual(parseCatalog({ data: [null, { id: '' }, { id: 'x' }, { id: 'y', pricing: { prompt: 'abc', completion: '1' } }] }), [])
  assert.deepEqual(parseCatalog('nonsense'), [])
})

async function loaded(over) {
  const service = serviceWith(() => reply(catalogJson(over)))
  assert.equal((await service.refresh()).ok, true)
  return service
}

test('names match with or without the vendor, dots or hyphens, and the dated slug', async () => {
  const service = await loaded()
  const how = (name) => {
    const found = service.match(name)
    return found ? [found.entry ? found.entry.id : found.ambiguous, found.how] : null
  }
  assert.deepEqual(how('claude-sonnet-4.5'), ['anthropic/claude-sonnet-4.5', 'name'])
  assert.deepEqual(how('Claude-Sonnet-4-5'), ['anthropic/claude-sonnet-4.5', 'name'])
  assert.deepEqual(how('anthropic/claude-sonnet-4-5'), ['anthropic/claude-sonnet-4.5', 'id'])
  assert.deepEqual(how('claude-sonnet-4-5-20250929'), ['anthropic/claude-sonnet-4.5', 'slug'])
  assert.deepEqual(how('claude-sonnet-4-5-20251001'), ['anthropic/claude-sonnet-4.5', 'dated'], 'an unknown date suffix is only a hint')
  assert.deepEqual(how('gpt-6.1-terra'), ['openai/gpt-6.1-terra', 'name'], 'the plain model wins over :batch')
  assert.deepEqual(how('gpt-6.1-terra:batch'), ['openai/gpt-6.1-terra:batch', 'name'])
  assert.deepEqual(how('alias-latest'), ['~acme/alias-latest', 'name'])
  assert.deepEqual(how('shared-name'), [['acme/shared-name', 'other/shared-name'], 'name'], 'different prices under one name are ambiguous')
  assert.equal(how('no-such-model'), null)
  assert.equal(how(''), null)
})

test('names that only differ by vendor but share a price are not ambiguous', async () => {
  const service = await loaded([model('a/twin', { prompt: '0.000001', completion: '0.000002' }), model('b/twin', { prompt: '0.000001', completion: '0.000002' })])
  assert.equal(service.match('twin').entry.id, 'a/twin')
})

test('search finds by any words of the id or name, plain models first', async () => {
  const service = await loaded()
  assert.deepEqual(service.search('sonnet 4.5').map((e) => e.id), ['anthropic/claude-sonnet-4.5'])
  assert.deepEqual(service.search('terra').map((e) => e.id), ['openai/gpt-6.1-terra', 'openai/gpt-6.1-terra:batch'])
  assert.deepEqual(service.search('   '), [])
  assert.equal(service.search('e', 3).length, 3)
})

test('refresh stores a cache that a new service loads, and says what went wrong otherwise', async () => {
  const { file } = fresh()
  const service = createCatalogService({ file, fetchImpl: async () => reply(catalogJson()) })
  const done = await service.refresh()
  assert.deepEqual([done.ok, done.code, done.count], [true, 'ok', 9])
  const again = createCatalogService({ file, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(again.snapshot().count, 9, 'the cache survives a restart')
  assert.equal(again.match('gpt-6.1-terra').entry.id, 'openai/gpt-6.1-terra')

  const failing = async (code, respond, extra, status) => {
    const out = await createCatalogService(Object.assign({ file, fetchImpl: respond }, extra)).refresh()
    assert.equal(out.code, code)
    assert.equal(out.ok, false)
    if (status !== undefined) assert.equal(out.status, status)
  }
  await failing('network', async () => { throw new TypeError('fetch failed') })
  await failing('http', async () => reply('down', { status: 503 }), undefined, 503)
  await failing('too-large', async () => reply('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }))
  await failing('bad-format', async () => reply('<html>'))
  await failing('bad-format', async () => reply({ data: [] }))
  await failing('timeout', (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }), { timeoutMs: 20 })
  assert.equal(readFileSync(file, 'utf8').includes('claude-sonnet-4.5'), true, 'failures never touch the cache')
})

test('a failed refresh keeps the old catalog and reports the error; a second refresh while one runs is refused', async () => {
  let fail = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const service = serviceWith(async () => { await gate; return fail ? reply('x', { status: 500 }) : reply(catalogJson()) })
  const first = service.refresh()
  assert.deepEqual(await service.refresh(), { ok: false, code: 'busy' })
  assert.equal(service.snapshot().refreshing, true)
  release()
  assert.equal((await first).ok, true)
  fail = true
  assert.equal((await service.refresh()).code, 'http')
  const snap = service.snapshot()
  assert.deepEqual([snap.count, snap.error.code, snap.error.status, snap.refreshing], [9, 'http', 500, false])
})

test('a damaged cache file is ignored and bad entries are dropped', () => {
  const { file } = fresh()
  writeFileSync(file, '{not json')
  assert.equal(createCatalogService({ file }).snapshot().count, 0)
  writeFileSync(file, JSON.stringify({ version: 1, fetchedAt: 5, models: [null, { id: 'ok/one', price: { input: 1, output: 2, bogus: 9 } }, { id: 'no/price' }, { price: {} }] }))
  const service = createCatalogService({ file })
  assert.equal(service.snapshot().count, 1)
  assert.deepEqual(service.get('ok/one').price, { currency: 'USD', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
  assert.equal(createCatalogService({ file: join(fresh().dir, 'absent.json') }).snapshot().fetchedAt, null)
})

// ---- the Host half, with the global fetch stubbed ----

const USAGE = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function withCatalog(t, over, body) {
  if (!process.env.DSH_HOME) process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cost-meter-'))
  rmSync(join(process.env.DSH_HOME, 'cost-meter.catalog.json'), { force: true })
  const original = globalThis.fetch
  let current = catalogJson(over)
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return reply(current) }
  const host = await startHost()
  try {
    await body(host, { set: (next) => { current = next }, calls: () => calls })
  } finally {
    globalThis.fetch = original
    host.dispose()
  }
}

test('host: refresh, per-model fill with backfill, ambiguity and manual edits dropping the marker', async (t) => {
  await withCatalog(t, null, async (host) => {
    await host.call({ model: 'zeta-1', sessionId: 'a', usage: USAGE })
    assert.equal(host.get().models['zeta-1'].unpriced, 1)
    const refreshed = await host.post({ action: 'catalog-refresh' })
    assert.deepEqual([refreshed.ok, refreshed.count], [true, 9])
    const snap = host.get().catalog
    assert.deepEqual([snap.count, snap.fillable, snap.stale], [9, 1, 0])
    assert.equal(snap.matches['zeta-1'].id, 'zed/zeta-1')
    assert.equal(snap.matches['zeta-1'].input, 1)

    const found = await host.post({ action: 'catalog-search', query: 'terra' })
    assert.deepEqual(found.results.map((row) => row.id), ['openai/gpt-6.1-terra', 'openai/gpt-6.1-terra:batch'])

    const applied = await host.post({ action: 'catalog-apply', model: 'zeta-1' })
    assert.deepEqual([applied.ok, applied.id, applied.backfilled], [true, 'zed/zeta-1', 1])
    const price = host.get().prices['zeta-1']
    assert.deepEqual([price.input, price.tiers.length, price.source.kind, price.source.id], [1, 1, 'catalog', 'zed/zeta-1'])
    assert.ok(Math.abs(host.get().models['zeta-1'].costs.USD - (1 + 0.5)) < 1e-9, 'the earlier unpriced call is priced now')

    assert.deepEqual(await host.post({ action: 'catalog-apply', model: 'shared-name' }), { ok: false, code: 'ambiguous', ids: ['acme/shared-name', 'other/shared-name'] })
    assert.equal((await host.post({ action: 'catalog-apply', model: 'shared-name', id: 'other/shared-name' })).ok, true)
    assert.deepEqual(await host.post({ action: 'catalog-apply', model: 'nothing-like-it' }), { ok: false, code: 'no-match' })
    assert.deepEqual(await host.post({ action: 'catalog-apply', model: ' ' }), { ok: false, code: 'missing-model' })
    assert.deepEqual(await host.post({ action: 'catalog-apply', model: 'x', id: 'no/such' }), { ok: false, code: 'no-match' })

    await host.post({ action: 'set-price', model: 'zeta-1', currency: 'USD', input: 9, output: 9 })
    assert.equal(host.get().prices['zeta-1'].source, undefined, 'a hand-edited price is no longer the catalog\'s')
  })
})

test('host: bulk fill only takes unpriced models with a sure match; sync follows later catalog changes', async (t) => {
  await withCatalog(t, null, async (host, stub) => {
    for (const name of ['zeta-1', 'claude-sonnet-4-5-20251001', 'shared-name', 'deepseek-v4-pro', 'mystery']) await host.call({ model: name, sessionId: 'a', usage: USAGE })
    await host.post({ action: 'catalog-refresh' })
    assert.equal(host.get().catalog.fillable, 1, 'dated, ambiguous, preset-priced and unknown models are left alone')
    const bulk = await host.post({ action: 'catalog-apply-all', mode: 'unpriced' })
    assert.deepEqual([bulk.ok, bulk.applied, bulk.models], [true, 1, ['zeta-1']])
    assert.equal((await host.post({ action: 'catalog-apply-all', mode: 'unpriced' })).applied, 0)
    assert.equal(host.get().prices['claude-sonnet-4-5-20251001'], undefined)
    assert.deepEqual(await host.post({ action: 'catalog-apply-all', mode: 'nope' }), { ok: false, code: 'unknown-mode' })

    assert.equal(host.get().catalog.stale, 0)
    const cheaper = catalogJson()
    cheaper.data.find((m) => m.id === 'zed/zeta-1').pricing = Object.assign({}, TERRA, { prompt: '0.0000005' })
    stub.set(cheaper)
    await host.post({ action: 'catalog-refresh' })
    assert.equal(host.get().catalog.stale, 1)
    const synced = await host.post({ action: 'catalog-apply-all', mode: 'applied' })
    assert.deepEqual([synced.applied, host.get().prices['zeta-1'].input], [1, 0.5])
    assert.equal(host.get().catalog.stale, 0)
  })
})

test('host: a failed refresh reports its code and leaves prices alone', async (t) => {
  await withCatalog(t, null, async (host) => {
    globalThis.fetch = async () => { throw new TypeError('offline') }
    const out = await host.post({ action: 'catalog-refresh' })
    assert.deepEqual([out.ok, out.code], [false, 'network'])
    assert.equal(host.get().catalog.error.code, 'network')
    assert.equal(host.get().catalog.count, 0)
  })
})

test('host: nothing contacts the network until the daily routine is switched on', async (t) => {
  await withCatalog(t, null, async (host, stub) => {
    await host.call({ model: 'zeta-1', sessionId: 'a', usage: USAGE })
    assert.equal(host.get().prefs.catalogAuto, false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(stub.calls(), 0)
    await host.post({ action: 'set-prefs', prefs: { catalogAuto: true } })
    assert.equal(await until(() => host.get().prices['zeta-1'] !== undefined), true, 'switching it on refreshes and prices the unpriced model')
    assert.equal(stub.calls(), 1)
    assert.equal(host.get().prices['zeta-1'].source.id, 'zed/zeta-1')
  })
})
