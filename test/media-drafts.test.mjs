// Run: node --test test/media-drafts.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { MEDIA_TEMPLATES, sanitizeRules } from '../media.js'
import { MEDIA_HINT, blankDraft, draftIssue, draftsForObserved, guessKind, mergeDrafts, queryMatcher, ruleToDraft, shadowedRules, templateFor } from '../src/client/lib/77-media-drafts.js'

const draft = (over = {}) => Object.assign(blankDraft('image'), { tool: 'gen', model: 'm', price: '0.2' }, over)

test('guessKind and MEDIA_HINT classify tool names', () => {
  assert.equal(guessKind('mcp_x_image'), 'image')
  assert.equal(guessKind('text_to_speech'), 'speech')
  assert.equal(guessKind('whisper_transcribe'), 'transcribe')
  assert.equal(MEDIA_HINT.test('mcp_norixor_image'), true)
  assert.equal(MEDIA_HINT.test('read_file'), false)
})

test('templateFor finds a shipped template by model id, ignoring case and spaces', () => {
  assert.equal(templateFor(MEDIA_TEMPLATES, ' Qwen-Image-3.0 ').price, 0.18)
  assert.equal(templateFor(MEDIA_TEMPLATES, 'tts-1').kind, 'speech')
  assert.equal(templateFor(MEDIA_TEMPLATES, 'gpt-image-2').price, 0.053, 'the preferred template wins when a model has several')
  assert.equal(templateFor(MEDIA_TEMPLATES, 'gemini-3-pro-image').price, 0.134)
  assert.equal(templateFor(MEDIA_TEMPLATES, 'nope'), null)
  assert.equal(templateFor(MEDIA_TEMPLATES, ''), null)
  assert.equal(templateFor(undefined, 'x'), null)
})

test('draftsForObserved makes one conditional, pre-priced rule per observed model value', () => {
  const drafts = draftsForObserved({ name: 'mcp_x_image', modelArg: 'model', models: ['qwen-image-3.0', 'wan2.6-t2i', 'mystery-model'] }, MEDIA_TEMPLATES)
  assert.equal(drafts.length, 3)
  assert.deepEqual(drafts.map((d) => [d.tool, d.model, d.whenArg, d.whenValue, d.price, d.currency]), [
    ['mcp_x_image', 'qwen-image-3.0', 'model', 'qwen-image-3.0', '0.18', 'CNY'],
    ['mcp_x_image', 'wan2.6-t2i', 'model', 'wan2.6-t2i', '0.2', 'CNY'],
    ['mcp_x_image', 'mystery-model', 'model', 'mystery-model', '', 'CNY'],
  ])
  assert.equal(draftIssue(drafts[0]), null)
  assert.equal(draftIssue(drafts[2]), 'price', 'a model without a template stays blank and blocks saving until priced')
  // The template decides the kind when the model is a known speech / transcription model.
  assert.equal(draftsForObserved({ name: 'say', modelArg: 'model', models: ['tts-1'] }, MEDIA_TEMPLATES)[0].kind, 'speech')
})

test('draftsForObserved falls back to one blank rule for tools without model values', () => {
  const drafts = draftsForObserved({ name: 'text_to_speech', modelArg: '', models: [] }, MEDIA_TEMPLATES)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].kind, 'speech')
  assert.equal(drafts[0].tool, 'text_to_speech')
  assert.equal(drafts[0].whenArg, '')
  assert.equal(draftIssue(drafts[0]), 'model')
})

test('mergeDrafts skips conditional drafts that already exist but always appends unconditional ones', () => {
  const existing = [draft({ whenArg: 'model', whenValue: 'qwen-image-3.0' })]
  const merged = mergeDrafts(existing, [
    draft({ whenArg: 'model', whenValue: 'QWEN-image-3.0' }),
    draft({ whenArg: 'model', whenValue: 'wan2.6-t2i' }),
    draft(),
  ])
  assert.deepEqual(merged.map((d) => d.whenValue), ['qwen-image-3.0', 'wan2.6-t2i', ''])
  assert.equal(mergeDrafts([], []).length, 0)
})

test('draftIssue names the first thing that blocks a save', () => {
  assert.equal(draftIssue(draft()), null)
  assert.equal(draftIssue(draft({ tool: ' ' })), 'tool')
  assert.equal(draftIssue(draft({ model: '', modelArg: '' })), 'model')
  assert.equal(draftIssue(draft({ model: '', modelArg: 'model' })), null)
  assert.equal(draftIssue(draft({ whenArg: 'model' })), 'when')
  assert.equal(draftIssue(draft({ whenValue: 'x' })), 'when')
  assert.equal(draftIssue(draft({ price: '' })), 'price')
  assert.equal(draftIssue(draft({ price: '-1' })), 'price')
  assert.equal(draftIssue(draft({ price: '0' })), null, 'zero is a valid price (free)')
})

test('shadowedRules flags rules an earlier rule of the same tool always wins over', () => {
  const rules = [
    draft({ tool: 'a', whenArg: 'model', whenValue: 'x' }),
    draft({ tool: 'a', whenArg: 'model', whenValue: 'y' }),
    draft({ tool: 'A' }),
    draft({ tool: 'a', whenArg: 'model', whenValue: 'z' }), // behind the catch-all
    draft({ tool: 'a', whenArg: 'model', whenValue: 'y' }), // also behind the catch-all
    draft({ tool: 'b' }),
    draft({ tool: 'b' }),
  ]
  assert.deepEqual(shadowedRules(rules), [3, 4, 6])
  assert.deepEqual(shadowedRules([]), [])
})

test('ruleToDraft round-trips a sanitized rule, including its condition', () => {
  const [rule] = sanitizeRules([{ tool: 't', kind: 'image', model: 'm', whenArg: 'model', whenValue: 'm', currency: 'usd', price: 0.5 }])
  const d = ruleToDraft(rule)
  assert.deepEqual([d.whenArg, d.whenValue, d.price, d.currency, d.qtyArg], ['model', 'm', '0.5', 'USD', 'n'])
  assert.deepEqual(sanitizeRules([Object.assign({}, d, { price: Number(d.price) })]), [rule])
})

test('queryMatcher: blank matches all, terms are ANDed ignoring case, /regex/ is supported and a broken regex matches nothing', () => {
  const labels = ['gpt-image-2 · USD 0.053', 'gemini-3-pro-image · Nano Banana Pro', 'wan2.6-t2i · CNY 0.2']
  const pick = (q) => labels.filter(queryMatcher(q))
  assert.equal(pick('').length, 3)
  assert.equal(pick('   ').length, 3)
  assert.deepEqual(pick('BANANA'), [labels[1]])
  assert.deepEqual(pick('gpt 0.053'), [labels[0]], 'every term has to appear')
  assert.deepEqual(pick('/^(gpt|wan)/'), [labels[0], labels[2]])
  assert.deepEqual(pick('/cny/'), [labels[2]])
  assert.deepEqual(pick('/([/'), [])
  assert.deepEqual(pick('/gpt'), [], 'an unfinished regex is plain text while typing')
})

test('shipped templates: valid, unique per model + note, at most one preferred per model, and the common image models are present', () => {
  const seen = new Set()
  const preferred = {}
  for (const tpl of MEDIA_TEMPLATES) {
    const key = tpl.model + '|' + (tpl.note || '')
    assert.equal(seen.has(key), false, 'duplicate template ' + key)
    seen.add(key)
    if (tpl.preferred) preferred[tpl.model] = (preferred[tpl.model] || 0) + 1
    assert.ok(tpl.price >= 0 && /^[A-Z]{3}$/.test(tpl.currency))
  }
  assert.ok(Object.values(preferred).every((n) => n === 1))
  for (const model of ['gpt-image-2', 'gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-image']) assert.ok(templateFor(MEDIA_TEMPLATES, model), model)
})
