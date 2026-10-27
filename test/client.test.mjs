// Run: node --test test/client.test.mjs
// Guards the generated client.js: it must match its sources, stay buildable as a classic script,
// and register/unregister the slots the way the preferences ask.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { buildClient } from '../scripts/build-client.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('client.js is up to date with src/client (run `npm run build` after editing the sources)', () => {
  assert.equal(readFileSync(join(ROOT, 'client.js'), 'utf8'), buildClient())
})

test('hand-written sources stay under 1000 lines each', () => {
  const dirs = ['src/client/lib', 'src/client/apply', 'scripts', 'test', '.']
  for (const dir of dirs) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!/\.(m?js)$/.test(name) || name === 'client.js') continue
      const lines = readFileSync(join(ROOT, dir, name), 'utf8').split('\n').length
      assert.ok(lines <= 1000, `${dir}/${name} has ${lines} lines`)
    }
  }
})

test('zh and en dictionaries have the same keys and cover every literal t() key used by the sources', () => {
  const keysOf = (file) => new Set([...readFileSync(join(ROOT, 'src/client/lib', file), 'utf8').matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]))
  const zh = keysOf('20-locale-zh.js')
  const en = keysOf('21-locale-en.js')
  assert.deepEqual([...zh].filter((k) => !en.has(k)), [], 'keys missing in en')
  assert.deepEqual([...en].filter((k) => !zh.has(k)), [], 'keys missing in zh')
  const used = new Set()
  for (const name of readdirSync(join(ROOT, 'src/client/lib'))) {
    if (!/\.js$/.test(name) || /locale/.test(name)) continue
    for (const m of readFileSync(join(ROOT, 'src/client/lib', name), 'utf8').matchAll(/\bt\('([A-Za-z0-9_]+)'\s*[,)]/g)) used.add(m[1])
  }
  assert.deepEqual([...used].filter((k) => !zh.has(k)), [], 'keys used but not defined')
  // Keys built at run time: insight sentences (ins_<id>) and weekday names (wd0–wd6).
  const dynamic = ['failed', 'unpriced', 'lowHit', 'peak', 'tier', 'concentrated', 'slowP95', 'slowFirst', 'longCalls'].map((id) => 'ins_' + id)
    .concat(Array.from({ length: 7 }, (_, i) => 'wd' + i))
  assert.deepEqual(dynamic.filter((k) => !zh.has(k)), [], 'dynamic keys not defined')
})

test('the browser-side preference defaults and enums mirror prefs.js', async () => {
  const host = await import('../prefs.js')
  const names = ['DEFAULT_PREFS', 'DOCK_STYLES', 'DOCK_FONTS', 'DOCK_SIZES', 'STATS_RANGES', 'MSG_STYLES', 'STATS_CURRENCIES']
  const mirror = new Function(readFileSync(join(ROOT, 'src/client/lib/35-prefs.js'), 'utf8') + ';return {' + names.join(',') + '}')()
  for (const name of names) assert.deepEqual(mirror[name], host[name], name)
})

/** Runs client.js in a sandbox with just enough of a browser, React and the slots service to call apply(). */
async function loadClient(snapshotPrefs, cachedSidebar, localeService, hostServices) {
  const registered = []
  const active = new Set()
  const storage = new Map(cachedSidebar === undefined ? [] : [['dsh-cost-meter:sidebar', cachedSidebar]])
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (def) => { definition = def } },
      localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v) },
    },
    fetch: async () => ({ json: async () => ({ ok: true, prefs: snapshotPrefs, models: {}, sessions: {}, prices: {}, presets: {}, budget: { currency: 'CNY', amount: 0 } }) }),
    setInterval: () => 0,
    clearInterval: () => {},
  }
  vm.runInNewContext(readFileSync(join(ROOT, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })
  assert.equal(definition.id, '@norixor/dsh-cost-meter')
  const fakeReact = new Proxy({ createElement: () => ({}) }, { get: (target, key) => target[key] || (() => undefined) })
  const plugin = definition.factory((name) => { assert.equal(name, 'react'); return fakeReact })
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])

  const slots = {
    inject(key, callback) {
      const off = callback()
      const token = { key, off }
      active.add(token)
      return () => { if (active.delete(token)) off() }
    },
    register(spec) {
      registered.push(spec)
      return () => { registered.splice(registered.indexOf(spec), 1) }
    },
  }
  const services = { slots, locale: localeService }
  // `ctx.inject(names, callback)` runs the callback only when every named service exists, like the host does.
  const inject = (names, callback) => {
    if (!hostServices || !names.every((name) => hostServices[name])) return
    callback(Object.assign({ slots, effect: (fn) => fn() }, hostServices))
  }
  plugin.apply({ get: (name) => services[name], effect: (fn) => fn(), inject })
  await new Promise((resolve) => setImmediate(resolve))
  return { registered, storage, names: () => registered.map((r) => r.name + ':' + (r.id || r.key)).sort() }
}

test('apply registers the dock, the message slots, the settings section and (by default) the sidebar entry with its page', async () => {
  const client = await loadClient({ sidebar: true })
  assert.deepEqual(client.names(), [
    'conversation.chat.assistant-actions:cost-meter',
    'conversation.chat.turnTail:cost-meter',
    'conversation.composer.dock:cost-meter',
    'main:cost-meter',
    'settings.section:cost-meter',
    'sidebar.panellist:cost-meter',
  ])
})

test('turning the sidebar off removes the entry and its page but keeps the dock, message slots and settings', async () => {
  const client = await loadClient({ sidebar: false })
  assert.deepEqual(client.names(), [
    'conversation.chat.assistant-actions:cost-meter',
    'conversation.chat.turnTail:cost-meter',
    'conversation.composer.dock:cost-meter',
    'settings.section:cost-meter',
  ])
  // The choice is remembered so the entry does not flash back in on the next start.
  assert.equal(client.storage.get('dsh-cost-meter:sidebar'), '0')
})

test('a cached "off" keeps the entry hidden before the first snapshot arrives', async () => {
  const client = await loadClient({ sidebar: false }, '0')
  assert.equal(client.names().some((n) => n.startsWith('sidebar.panellist')), false)
})

const LOCALE_FILES = { zh: '20-locale-zh.js', en: '21-locale-en.js', 'zh-hant': '22-locale-zh-hant.js', ja: '23-locale-ja.js', ko: '24-locale-ko.js', de: '25-locale-de.js', fr: '26-locale-fr.js', es: '27-locale-es.js', ru: '28-locale-ru.js' }
const placeholders = (text) => (String(text).match(/\{\w+\}/g) || []).sort().join(',')
const loadDictionary = (file, name) => new Function(readFileSync(join(ROOT, 'src/client/lib', file), 'utf8') + ';return ' + name)()

test('every shipped language has exactly the English keys and placeholders, a manifest locale file and a registered dictionary', async () => {
  const en = loadDictionary(LOCALE_FILES.en, 'EN')
  for (const [id, file] of Object.entries(LOCALE_FILES)) {
    const dict = loadDictionary(file, { zh: 'ZH', en: 'EN', 'zh-hant': 'ZH_HANT' }[id] || id.toUpperCase())
    assert.deepEqual(Object.keys(dict).filter((k) => !(k in en)), [], id + ': keys not in en')
    assert.deepEqual(Object.keys(en).filter((k) => !(k in dict)), [], id + ': keys missing')
    for (const key of Object.keys(en)) {
      assert.equal(typeof dict[key], 'string', id + '.' + key)
      assert.notEqual(dict[key].trim(), '', id + '.' + key + ' is empty')
      assert.equal(placeholders(dict[key]), placeholders(en[key]), id + '.' + key + ': placeholders differ')
    }
    const meta = JSON.parse(readFileSync(join(ROOT, 'locale', id + '.json'), 'utf8')).meta
    assert.ok(meta.title && meta.description, id + ': manifest meta')
  }
  assert.deepEqual(readdirSync(join(ROOT, 'locale')).map((f) => f.replace(/\.json$/, '')).sort(), Object.keys(LOCALE_FILES).sort(), 'locale/*.json matches the shipped languages')

  const registered = []
  const service = { register: (ns, id, dict) => { registered.push(id); return () => {} }, bind: () => (key) => key }
  await loadClient({ sidebar: true }, undefined, service)
  assert.deepEqual(registered.sort(), Object.keys(LOCALE_FILES).sort())
})

test('a host that rejects an extra language id still loads the plugin with zh and en', async () => {
  const registered = []
  const service = {
    register: (ns, id) => {
      if (id !== 'zh' && id !== 'en') throw new Error('unknown language ' + id)
      registered.push(id)
      return () => {}
    },
    bind: () => (key) => key,
  }
  const client = await loadClient({ sidebar: true }, undefined, service)
  assert.deepEqual(registered.sort(), ['en', 'zh'])
  assert.ok(client.names().includes('settings.section:cost-meter'))
})

test('with the right sidebar available the plugin adds its page type and body; without it nothing changes', async () => {
  const types = []
  const hostServices = { sidebarRight: { openTab: () => {} }, sidebarRightTabs: { register: (definition) => { types.push(definition); return () => {} } } }
  const client = await loadClient({ sidebar: true }, undefined, undefined, hostServices)
  assert.ok(client.names().includes('sidebar.right.pane.tab:@norixor/dsh-cost-meter/side'))
  assert.equal(types.length, 1)
  assert.equal(types[0].kind, 'cost-meter')
  assert.equal(types[0].id, '@norixor/dsh-cost-meter/side')
  assert.equal(typeof types[0].title(), 'string')
  assert.equal(types[0].guide.length, 1)
  assert.equal(typeof types[0].guide[0].description(), 'string')
  assert.equal(typeof types[0].guide[0].icon, 'function')

  const plain = await loadClient({ sidebar: true })
  assert.equal(plain.names().some((n) => n.startsWith('sidebar.right')), false)
})

test('a host whose right sidebar rejects the page type still gets the dock, message slots and settings', async () => {
  const hostServices = { sidebarRight: {}, sidebarRightTabs: { register: () => { throw new Error('kind already taken') } } }
  const client = await loadClient({ sidebar: true }, undefined, undefined, hostServices)
  assert.ok(client.names().includes('conversation.composer.dock:cost-meter'))
  assert.ok(client.names().includes('settings.section:cost-meter'))
  assert.equal(client.names().some((n) => n.startsWith('sidebar.right')), false)
})
