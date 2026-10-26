// Pure helpers behind the media-rule editor (76-media-settings.js): drafts are the editor's string-valued form of a rule.
// Inlined into client.js and imported by tests.

export const MEDIA_HINT = /image|img|draw|paint|photo|picture|speech|tts|voice|audio|transcri|stt|asr|sound|music|video/i

/** A best guess at what a tool does from its name, to preselect the rule's kind. */
export const guessKind = (name) => (/transcri|stt|asr|listen/i.test(name) ? 'transcribe' : /speech|tts|voice|audio|speak|say/i.test(name) ? 'speech' : 'image')

export const blankDraft = (kind) => ({ tool: '', kind, model: '', modelArg: '', whenArg: '', whenValue: '', qtyArg: '', currency: 'CNY', price: '' })

export const ruleToDraft = (rule) => ({
  tool: rule.tool, kind: rule.kind, model: rule.model, modelArg: rule.modelArg, whenArg: rule.whenArg || '', whenValue: rule.whenValue || '',
  qtyArg: rule.qtyArg, currency: rule.currency, price: String(rule.price),
})

/** The shipped template for a model id (case-insensitive): the one marked `preferred`, else the first; null when none. */
export function templateFor(templates, model) {
  const key = String(model || '').trim().toLowerCase()
  if (!key) return null
  const matches = (templates || []).filter((tpl) => tpl.model.toLowerCase() === key)
  return matches.find((tpl) => tpl.preferred) || matches[0] || null
}

/**
 * Predicate for a search box: blank matches everything, "/regex/" is a case-insensitive regex (an invalid one matches
 * nothing), anything else needs every whitespace-separated term to appear, case-insensitively.
 */
export function queryMatcher(query) {
  const raw = String(query || '').trim()
  if (raw === '') return () => true
  if (raw.length > 2 && raw.startsWith('/') && raw.endsWith('/')) {
    try {
      const re = new RegExp(raw.slice(1, -1), 'i')
      return (text) => re.test(text)
    } catch {
      return () => false
    }
  }
  const terms = raw.toLowerCase().split(/\s+/)
  return (text) => {
    const lower = String(text).toLowerCase()
    return terms.every((term) => lower.includes(term))
  }
}

/**
 * Drafts for one observed tool. A tool that was seen with model values gets one rule per model, each limited to its own
 * model through a condition on the model argument and pre-priced from the matching template; otherwise a single blank rule.
 */
export function draftsForObserved(observed, templates) {
  const guess = guessKind(observed.name)
  const models = Array.isArray(observed.models) ? observed.models : []
  if (!observed.modelArg || models.length === 0) return [Object.assign(blankDraft(guess), { tool: observed.name })]
  return models.map((value) => {
    const tpl = templateFor(templates, value)
    return Object.assign(blankDraft(tpl ? tpl.kind : guess), {
      tool: observed.name, model: value, whenArg: observed.modelArg, whenValue: value,
      currency: tpl ? tpl.currency : 'CNY', price: tpl ? String(tpl.price) : '',
    })
  })
}

/** Append drafts, skipping conditional ones whose tool + condition already has a rule (so the button is safe to press twice). */
export function mergeDrafts(rules, drafts) {
  const key = (r) => [r.tool.trim().toLowerCase(), r.whenArg.trim(), r.whenValue.trim().toLowerCase()].join('\u0000')
  const have = new Set(rules.filter((r) => r.whenArg.trim() !== '').map(key))
  return rules.concat(drafts.filter((d) => d.whenArg.trim() === '' || !have.has(key(d))))
}

/** What stops a draft from being saved, or null: 'tool', 'model', 'when' (half a condition) or 'price'. */
export function draftIssue(draft) {
  if (draft.tool.trim() === '') return 'tool'
  if (draft.model.trim() === '' && draft.modelArg.trim() === '') return 'model'
  if ((draft.whenArg.trim() === '') !== (draft.whenValue.trim() === '')) return 'when'
  if (String(draft.price).trim() === '' || !(Number(draft.price) >= 0)) return 'price'
  return null
}

/** Indices of rules that can never apply: an earlier rule of the same tool has no condition, or the same one. */
export function shadowedRules(rules) {
  const tool = (r) => r.tool.trim().toLowerCase()
  const cond = (r) => (r.whenArg.trim() !== '' && r.whenValue.trim() !== '' ? r.whenArg.trim() + '\u0000' + r.whenValue.trim().toLowerCase() : '')
  const out = []
  rules.forEach((rule, i) => {
    for (let j = 0; j < i; j += 1) {
      if (tool(rules[j]) === tool(rule) && (cond(rules[j]) === '' || cond(rules[j]) === cond(rule))) { out.push(i); break }
    }
  })
  return out
}
