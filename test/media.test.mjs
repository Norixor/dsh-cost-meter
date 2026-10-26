// Run: node --test test/media.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RULES, MEDIA_TEMPLATES, OBSERVED_CAP, argsOf, compileRules, matchRule, modelOf, observeTool, quantityOf, sanitizeObserved, sanitizeRules, toolMatcher,
} from '../media.js'
import { startHost } from './host-harness.mjs'

const rule = (over = {}) => ({ tool: 'gen_image', kind: 'image', model: 'img-1', currency: 'CNY', price: 0.2, ...over })

test('toolMatcher: exact names ignore case, /regex/ is case-insensitive, bad regex and blanks are rejected', () => {
  assert.equal(toolMatcher('Gen_Image')('gen_image'), true)
  assert.equal(toolMatcher('gen_image')('gen_image2'), false)
  assert.equal(toolMatcher('/^tts_/')('TTS_speak'), true)
  assert.equal(toolMatcher('/([/'), null)
  assert.equal(toolMatcher('  '), null)
})

test('sanitizeRules keeps well-formed rules, fills defaults and caps the list', () => {
  const rules = sanitizeRules([
    rule(),
    rule({ tool: 'say', kind: 'speech', model: '', modelArg: 'model', price: '0.015', currency: 'usd' }),
    rule({ kind: 'video' }), // unknown kind
    rule({ tool: '' }), // no tool
    rule({ model: '', modelArg: '' }), // no model at all
    rule({ price: -1 }),
    rule({ tool: '/([/' }), // invalid regex
    null,
  ])
  assert.equal(rules.length, 2)
  assert.equal(rules[0].qtyArg, 'n')
  assert.equal(rules[1].qtyArg, 'text')
  assert.equal(rules[1].currency, 'USD')
  assert.equal(rules[1].price, 0.015)
  assert.equal(sanitizeRules(Array.from({ length: 40 }, (_, i) => rule({ tool: 't' + i }))).length, MAX_RULES)
  assert.deepEqual(sanitizeRules('nope'), [])
})

test('quantity: images default to 1, speech counts thousands of characters, transcription converts seconds to minutes', () => {
  const [image, speech, stt] = sanitizeRules([rule(), rule({ tool: 'say', kind: 'speech', qtyArg: 'input' }), rule({ tool: 'listen', kind: 'transcribe' })])
  assert.deepEqual(quantityOf(image, {}), { qty: 1, known: true })
  assert.deepEqual(quantityOf(image, { n: 3 }), { qty: 3, known: true })
  assert.deepEqual(quantityOf(image, { n: 'x' }), { qty: 1, known: true })
  assert.deepEqual(quantityOf(speech, { input: 'a'.repeat(2500) }), { qty: 2.5, known: true })
  assert.deepEqual(quantityOf(speech, { text: 'ignored' }), { qty: 0, known: false })
  assert.deepEqual(quantityOf(stt, { duration: 90 }), { qty: 1.5, known: true })
  assert.deepEqual(quantityOf(stt, {}), { qty: 0, known: false })
})

test('modelOf prefers the argument named by modelArg and falls back to the fixed model', () => {
  const r = sanitizeRules([rule({ modelArg: 'model' })])[0]
  assert.equal(modelOf(r, { model: ' wan2.6-t2i ' }), 'wan2.6-t2i')
  assert.equal(modelOf(r, { model: 5 }), 'img-1')
  assert.equal(modelOf(sanitizeRules([rule({ model: '', modelArg: 'm' })])[0], {}), 'gen_image')
})

test('argsOf accepts objects and JSON strings only', () => {
  assert.deepEqual(argsOf({ a: 1 }), { a: 1 })
  assert.deepEqual(argsOf('{"a":2}'), { a: 2 })
  assert.deepEqual(argsOf('nope'), {})
  assert.deepEqual(argsOf(null), {})
  assert.deepEqual(argsOf('[1]'), {})
  assert.deepEqual(argsOf([1]), {})
})

test('observeTool stores names and argument names only, newest first, capped', () => {
  const observed = {}
  observeTool(observed, 'gen_image', { prompt: 'secret prompt', size: '1024' }, 10)
  observeTool(observed, 'gen_image', {}, 20)
  assert.equal(observed.gen_image.calls, 2)
  assert.equal(observed.gen_image.last, 20)
  assert.deepEqual(observed.gen_image.argKeys, ['prompt', 'size'])
  assert.equal(JSON.stringify(observed).includes('secret'), false)
  for (let i = 0; i < OBSERVED_CAP + 10; i += 1) observeTool(observed, 'tool' + i, {}, 100 + i)
  assert.equal(Object.keys(observed).length, OBSERVED_CAP)
  assert.equal(observed.gen_image, undefined) // the oldest entry was evicted
  assert.deepEqual(sanitizeObserved({ x: { calls: 2, last: 5, argKeys: ['a', 3] }, y: 'bad' }), { x: { calls: 2, last: 5, argKeys: ['a'], modelArg: '', models: [] } })
})

test('templates are valid rules once a tool is chosen', () => {
  const filled = MEDIA_TEMPLATES.map((tpl) => ({ ...tpl, tool: 'some_tool' }))
  assert.equal(sanitizeRules(filled.slice(0, MAX_RULES)).length, MEDIA_TEMPLATES.length)
})

test('compileRules/matchRule pick the first matching rule', () => {
  const rules = sanitizeRules([rule({ tool: '/^gen_/', model: 'first' }), rule({ tool: 'gen_image', model: 'second' })])
  assert.equal(matchRule(compileRules(rules), 'GEN_image', {}).model, 'first')
  assert.equal(matchRule(compileRules(rules), 'other', {}), null)
  assert.equal(matchRule(compileRules(rules), 'gen_image').model, 'first', 'arguments are optional for unconditional rules')
})

test('a rule with a content condition applies only when the argument matches; the first match wins', () => {
  const compiled = compileRules(sanitizeRules([
    rule({ model: 'qwen', whenArg: 'model', whenValue: 'qwen-image-3.0' }),
    rule({ model: 'wan', whenArg: 'model', whenValue: '/^wan/' }),
    rule({ model: 'fallback' }),
    rule({ tool: 'sized', model: 'big', whenArg: 'n', whenValue: '4' }),
  ]))
  const pick = (name, args) => { const r = matchRule(compiled, name, args); return r && r.model }
  assert.equal(pick('gen_image', { model: 'QWEN-image-3.0' }), 'qwen', 'exact values ignore case')
  assert.equal(pick('gen_image', { model: 'wan2.6-t2i' }), 'wan', '/regex/ values are supported')
  assert.equal(pick('gen_image', { model: 'other' }), 'fallback')
  assert.equal(pick('gen_image', {}), 'fallback', 'a missing argument fails the condition, the catch-all still applies')
  assert.equal(pick('gen_image', { model: { nested: 1 } }), 'fallback', 'only strings and numbers are compared')
  assert.equal(pick('sized', { n: 4 }), 'big', 'numbers are compared as text')
  assert.equal(pick('sized', { n: 3 }), null, 'no catch-all: the call is not metered')
  assert.equal(pick('sized', {}), null)
})

test('sanitizeRules discards a rule whose condition is half-given or has an invalid regex instead of widening it', () => {
  const rules = sanitizeRules([
    rule({ whenArg: 'model' }),
    rule({ whenValue: 'x' }),
    rule({ whenArg: 'model', whenValue: '/([/' }),
    rule({ whenArg: ' model ', whenValue: ' qwen ' }),
    rule(),
  ])
  assert.equal(rules.length, 2)
  assert.equal(rules[0].whenArg, 'model')
  assert.equal(rules[0].whenValue, 'qwen')
  assert.equal(rules[1].whenArg, '')
  assert.equal(rules[1].whenValue, '')
})

test('observeTool keeps the values of a model-naming argument only, newest last, de-duplicated and capped', () => {
  const observed = {}
  observeTool(observed, 'gen_image', { prompt: 'secret prompt', model: 'a' }, 1)
  observeTool(observed, 'gen_image', { prompt: 'other secret', model: 'b' }, 2)
  observeTool(observed, 'gen_image', { model: 'a' }, 3)
  assert.equal(observed.gen_image.modelArg, 'model')
  assert.deepEqual(observed.gen_image.models, ['b', 'a'])
  assert.equal(JSON.stringify(observed).includes('secret'), false)
  for (let i = 0; i < 12; i += 1) observeTool(observed, 'gen_image', { model: 'm' + i }, 10 + i)
  assert.equal(observed.gen_image.models.length, 8)
  assert.equal(observed.gen_image.models.at(-1), 'm11')
  observeTool(observed, 'plain', { prompt: 'x', model: 5, engine: '  ' }, 20)
  assert.equal(observed.plain.models, undefined, 'non-string or blank values are not remembered')
  observeTool(observed, 'alt', { engine_x: 'nope', engine: 'e1' }, 21)
  assert.equal(observed.alt.modelArg, 'engine')
  assert.deepEqual(sanitizeObserved(observed).gen_image.models.length, 8)
})

test('host: media metering is off by default, then books tool calls under the rule\'s model', async () => {
  const host = await startHost()
  const toolResult = (name, args, isError = false, session = 'sess-media') => host.tool({ name, arguments: args, agent: { session: { id: session } } }, { isError })

  // Off by default: nothing is observed or recorded.
  toolResult('gen_image', { prompt: 'x', n: 2 })
  assert.deepEqual(host.get().media.observed, [])
  assert.equal(host.get().prefs.mediaMeter, false)
  assert.ok(host.get().media.templates.length > 0)

  await host.post({ action: 'set-prefs', prefs: { mediaMeter: true } })
  const saved = await host.post({
    action: 'set-media-rules',
    rules: [rule({ tool: 'gen_image', model: 'img-1', price: 0.2 }), { tool: 'say', kind: 'speech', model: 'tts-1', currency: 'USD', price: 0.015, qtyArg: 'input' }, { tool: '', kind: 'image' }],
  })
  assert.equal(saved.rules.length, 2)

  toolResult('gen_image', { prompt: 'x', n: 3 })
  toolResult('say', { input: 'a'.repeat(2000) })
  toolResult('say', { other: 1 }) // quantity unknown → unpriced
  toolResult('gen_image', { n: 1 }, true) // failed call: counted, not billed
  toolResult('bash', { command: 'ls' }) // observed only

  const snap = host.get()
  const img = snap.models['img-1']
  assert.equal(img.calls, 2)
  assert.equal(img.failed, 1)
  assert.equal(img.units, 3)
  assert.equal(img.media, 'image')
  assert.ok(Math.abs(img.costs.CNY - 0.6) < 1e-9)
  const tts = snap.models['tts-1']
  assert.equal(tts.calls, 2)
  assert.equal(tts.unpriced, 1)
  assert.equal(tts.units, 2)
  assert.ok(Math.abs(tts.costs.USD - 0.03) < 1e-9)
  // The session carries both the cost and the per-model buckets, and the day bucket agrees.
  assert.ok(Math.abs(snap.sessions['sess-media'].costs.CNY - 0.6) < 1e-9)
  assert.equal(snap.sessions['sess-media'].models['img-1'].units, 3)
  const stats = await host.post({ action: 'stats' })
  assert.equal(stats.daily[stats.today]['img-1'].units, 3)
  assert.deepEqual(snap.media.observed.map((o) => o.name).sort(), ['bash', 'gen_image', 'say'])
  assert.deepEqual(snap.media.observed.find((o) => o.name === 'gen_image').argKeys, ['n'])

  // Rules survive "clear totals"; clearing the observed list is its own action.
  await host.post({ action: 'reset-totals' })
  assert.equal(host.get().media.rules.length, 2)
  assert.equal(Object.keys(host.get().models).length, 0)
  await host.post({ action: 'clear-observed' })
  assert.deepEqual(host.get().media.observed, [])

  // Switching it off stops recording again, and a malformed event never throws.
  await host.post({ action: 'set-prefs', prefs: { mediaMeter: false } })
  toolResult('gen_image', { n: 1 })
  assert.equal(host.get().models['img-1'], undefined)
  host.tool(null, null)
  host.tool({ name: 5 }, {})
  host.dispose()
})

test('host: one tool fronting several models is booked per model through conditional rules', async () => {
  const host = await startHost()
  try {
    await host.post({ action: 'set-prefs', prefs: { mediaMeter: true } })
    const saved = await host.post({
      action: 'set-media-rules',
      rules: [
        { tool: 'mcp_x_image', kind: 'image', model: 'qwen-image-3.0', whenArg: 'model', whenValue: 'qwen-image-3.0', currency: 'CNY', price: 0.18 },
        { tool: 'mcp_x_image', kind: 'image', model: 'wan2.6-t2i', whenArg: 'model', whenValue: 'wan2.6-t2i', currency: 'CNY', price: 0.2 },
        { tool: 'mcp_x_image', kind: 'image', model: 'half', whenArg: 'model' }, // discarded
      ],
    })
    assert.equal(saved.rules.length, 2)
    const run = (args) => host.tool({ name: 'mcp_x_image', arguments: args, agent: { session: { id: 'sess-x' } } }, { isError: false })
    run({ prompt: 'p', model: 'qwen-image-3.0', n: 2 })
    run({ prompt: 'p', model: 'wan2.6-t2i' })
    run({ prompt: 'p', model: 'unknown-model' }) // no rule matches: observed, not metered
    const snap = host.get()
    assert.equal(snap.models['qwen-image-3.0'].units, 2)
    assert.ok(Math.abs(snap.models['qwen-image-3.0'].costs.CNY - 0.36) < 1e-9)
    assert.equal(snap.models['wan2.6-t2i'].units, 1)
    assert.equal(snap.models['unknown-model'], undefined)
    const seen = snap.media.observed.find((o) => o.name === 'mcp_x_image')
    assert.equal(seen.modelArg, 'model')
    assert.deepEqual(seen.models, ['qwen-image-3.0', 'wan2.6-t2i', 'unknown-model'])
    assert.equal(seen.calls, 3)
    assert.equal(snap.media.rules[0].whenValue, 'qwen-image-3.0')
  } finally {
    host.dispose()
  }
})
