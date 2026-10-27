/**
 * What the Host does with the price catalog (catalog.js): fill a model's price from it, fill every model that has none,
 * bring catalog-sourced prices up to date, and the opt-in daily refresh. Applied prices are ordinary custom prices
 * with a `source` marker ({ kind: 'catalog', id, at }); editing one by hand replaces it and drops the marker.
 *
 * Responses carry a stable `code`: ok, missing-model, no-match, ambiguous (with `ids`), unknown-mode, plus the
 * refresh codes of catalog.js.
 */
import { SURE_MATCHES } from './catalog.js'

export const AUTO_MAX_AGE_MS = 24 * 3_600_000
const APPLIED_SHOWN = 20

const withoutSource = (price) => {
  const copy = Object.assign({}, price)
  delete copy.source
  return copy
}
const catalogSource = (price) => (price && price.source && price.source.kind === 'catalog' && typeof price.source.id === 'string' ? price.source : null)

/**
 * `deps`: `catalog` (the service), `prices` / `models` (live state tables), `effectivePrice(model)`,
 * `backfill(model, price)` (re-prices the model's earlier unpriced calls, returns how many) and `persist()`.
 */
export function createCatalogActions(deps) {
  const { catalog, prices, models, effectivePrice, backfill, persist } = deps

  function apply(model, entry) {
    const price = JSON.parse(JSON.stringify(entry.price))
    price.source = { kind: 'catalog', id: entry.id, at: Date.now() }
    prices[model] = price
    const backfilled = backfill(model, price)
    persist()
    return backfilled
  }

  /** Models seen in use that have no price at all and a sure catalog match. */
  function fillable() {
    const rows = []
    for (const model of Object.keys(models)) {
      const bucket = models[model]
      if (!bucket || bucket.media || effectivePrice(model)) continue
      const found = catalog.match(model)
      if (found && found.entry && SURE_MATCHES.includes(found.how)) rows.push({ model, entry: found.entry })
    }
    return rows
  }

  /** Prices that came from the catalog and no longer equal its current entry (entries that left the catalog stay as they are). */
  function stale() {
    const rows = []
    for (const model of Object.keys(prices)) {
      const source = catalogSource(prices[model])
      const entry = source ? catalog.get(source.id) : null
      if (entry && JSON.stringify(withoutSource(prices[model])) !== JSON.stringify(entry.price)) rows.push({ model, entry })
    }
    return rows
  }

  function applyRows(rows) {
    let backfilled = 0
    for (const row of rows) backfilled += apply(row.model, row.entry)
    return { applied: rows.length, backfilled, models: rows.slice(0, APPLIED_SHOWN).map((row) => row.model) }
  }

  /** Per seen model: the matched catalog entry (id, how it matched, rates), or the ids that made the name ambiguous. */
  function matches() {
    const out = {}
    if (catalog.snapshot().count === 0) return out
    for (const model of Object.keys(models)) {
      const bucket = models[model]
      if (!bucket || bucket.media) continue
      const found = catalog.match(model)
      if (!found) continue
      out[model] = found.entry
        ? { id: found.entry.id, how: found.how, input: found.entry.price.input, output: found.entry.price.output, timeBased: found.entry.timeBased }
        : { how: found.how, ambiguous: found.ambiguous }
    }
    return out
  }

  /** The opt-in daily routine: refresh when the cache is old, bring catalog-sourced prices up to date, price newly seen models. */
  async function auto() {
    if (catalog.age() > AUTO_MAX_AGE_MS) {
      const res = await catalog.refresh()
      if (!res.ok) return res
      applyRows(stale())
    }
    return Object.assign({ ok: true, code: 'ok' }, applyRows(fillable()))
  }

  const summary = (entry) => ({ id: entry.id, name: entry.name, price: entry.price, timeBased: entry.timeBased })

  function handle(body) {
    switch (body && body.action) {
      case 'catalog-refresh':
        return catalog.refresh().then((res) => Object.assign({}, res, { catalog: snapshot() }))
      case 'catalog-search':
        return { ok: true, code: 'ok', results: catalog.search(body.query, 12).map(summary) }
      case 'catalog-apply': {
        const model = String((body && body.model) || '').trim()
        if (!model) return { ok: false, code: 'missing-model' }
        let entry = null
        if (body.id) entry = catalog.get(body.id)
        else {
          const found = catalog.match(model)
          if (found && found.ambiguous) return { ok: false, code: 'ambiguous', ids: found.ambiguous }
          entry = found ? found.entry : null
        }
        if (!entry) return { ok: false, code: 'no-match' }
        const backfilled = apply(model, entry)
        return { ok: true, code: 'ok', id: entry.id, backfilled, timeBased: entry.timeBased }
      }
      case 'catalog-apply-all': {
        if (body.mode === 'unpriced') return Object.assign({ ok: true, code: 'ok' }, applyRows(fillable()))
        if (body.mode === 'applied') return Object.assign({ ok: true, code: 'ok' }, applyRows(stale()))
        return { ok: false, code: 'unknown-mode' }
      }
      default:
        return null
    }
  }

  /** For the polled snapshot: the service state plus how many models each bulk action would touch, and the per-model matches. */
  function snapshot() {
    return Object.assign(catalog.snapshot(), { fillable: fillable().length, stale: stale().length, matches: matches() })
  }

  return { handle, snapshot, auto }
}
