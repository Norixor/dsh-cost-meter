// OpenRouter price catalog in the settings: the section that fetches it and applies it in bulk, the hint next to a model that
// has no price, and the picker inside a model's editor. The Host fetches and matches (catalog.js, catalog-apply.js); the browser
// only asks. Responses carry a stable `code`; the texts below are chosen by it.

const CATALOG_ERROR_KEYS = { network: 'catErrNetwork', timeout: 'catErrTimeout', 'too-large': 'catErrTooLarge', 'bad-format': 'catErrFormat', busy: 'catErrBusy' }
const CATALOG_SEARCH_DELAY_MS = 250
const NO_CATALOG = { fetchedAt: null, count: 0, refreshing: false, error: null, fillable: 0, stale: 0, matches: {} }

const catalogOf = (snap) => (snap && snap.catalog) || NO_CATALOG
const catalogSourceOf = (price) => (price && price.source && price.source.kind === 'catalog' ? price.source : null)

/** "Input $3 / Output $15": base rates per million tokens (the unit is stated once, above the price list). */
const catalogRates = (price) => t('rIn') + ' ' + formatRate('USD', price.input) + ' / ' + t('rOut') + ' ' + formatRate('USD', price.output)

/** Failure text of a Host answer or of the last refresh (`{ code, status }`). */
function catalogError(res) {
  if (res.code === 'http') return t('catErrHttp', { status: res.status })
  if (CATALOG_ERROR_KEYS[res.code]) return t(CATALOG_ERROR_KEYS[res.code])
  return t('catFailed', { error: res.error || res.code || 'unknown' })
}

/** One Host call; always resolves to an object with `ok`. */
const catalogCall = (body) => postAction(body)
  .then((res) => res || { ok: false, code: 'empty' })
  .catch((err) => ({ ok: false, code: 'network', error: (err && err.message) || String(err) }))

/** Settings → fetch the catalog, fill the models that have no price, bring catalog prices up to date, opt in to the daily routine. */
function CatalogSettings(props) {
  const cat = catalogOf(props.snap)
  const prefs = usePrefs()
  const [busy, setBusy] = React.useState(null)
  const [outcome, setOutcome] = React.useState(null)
  const working = busy !== null || cat.refreshing

  const run = (body, describe) => {
    setBusy(body.action + (body.mode || ''))
    setOutcome(null)
    catalogCall(body)
      .then((res) => setOutcome({ text: res.ok ? describe(res) : catalogError(res), bad: !res.ok }))
      .then(() => store.refresh())
      .then(() => setBusy(null))
  }
  const refresh = () => run({ action: 'catalog-refresh' }, (res) => t('catRefreshed', { n: res.count }))
  const bulk = (mode, key) => run({ action: 'catalog-apply-all', mode }, (res) => (res.applied > 0 ? t(key, { n: res.applied }) : t('catNothing')))

  const status = cat.fetchedAt ? t('catCached', { n: cat.count, when: historyWhen(cat.fetchedAt) }) : t('catNever')
  const line = (text, bad) => h('div', { style: { fontSize: 12, lineHeight: '18px', color: bad ? LIGHT.red : SECONDARY } }, text)

  return h('div', null,
    settingRow({ key: 'catStatus' }, t('catStatus'), status,
      btn(busy === 'catalog-refresh' || cat.refreshing ? t('catRefreshing') : t('catRefresh'), refresh, null, working)),
    cat.error ? h('div', { style: { padding: '10px 0 0' } }, line(catalogError(cat.error), true)) : null,
    outcome ? h('div', { style: { padding: '10px 0 0' } }, line(outcome.text, outcome.bad)) : null,
    settingRow({ key: 'catAuto' }, t('catAuto'), t('catAutoHint'), toggle(prefs.catalogAuto, (on) => store.setPrefs({ catalogAuto: on }), t('catAuto'))),
    cat.count > 0 ? settingRow({ key: 'catFill' }, t('catFillTitle'), t('catFillHint'),
      btn(t('catFillBtn', { n: cat.fillable }), () => bulk('unpriced', 'catFilled'), null, working || cat.fillable === 0)) : null,
    cat.count > 0 ? settingRow({ key: 'catSync' }, t('catSyncTitle'), t('catSyncHint'),
      btn(t('catSyncBtn', { n: cat.stale }), () => bulk('applied', 'catSynced'), null, working || cat.stale === 0)) : null,
    h('div', { style: Object.assign({}, ui.desc, { padding: '12px 0 0' }) }, t('catNote')))
}

/**
 * Under a model that has no price: the catalog entry its name matches (or why it did not), with a button to take its price.
 * `match` is the Host's answer for this model in the snapshot (`snap.catalog.matches[model]`).
 */
function CatalogHint(props) {
  const { model, match, onApplied } = props
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  if (!match) return null
  const style = Object.assign({}, ui.desc, { marginTop: 6 })
  if (match.ambiguous) return h('div', { style }, t('catAmbiguous', { ids: match.ambiguous.join(', ') }))
  const notes = [t('catHint', { id: match.id, rates: catalogRates(match) })]
  if (match.how === 'dated') notes.push(t('catDated'))
  if (match.timeBased) notes.push(t('catTimeBased'))
  const fill = () => {
    setBusy(true)
    setError(null)
    catalogCall({ action: 'catalog-apply', model }).then((res) => {
      setBusy(false)
      if (res.ok) onApplied(res)
      else setError(catalogError(res))
    })
  }
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
    h('span', { style: Object.assign({}, style, { marginTop: 0 }) }, notes.join(' · ')),
    btn(t('catFill'), fill, null, busy),
    error ? small(LIGHT.red, error) : null)
}

/** Inside a model's editor: search the whole catalog by name and take any entry's price for this model. */
function CatalogPicker(props) {
  const { model, replacing, onApplied } = props
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    if (query.trim() === '') { setResults(null); return undefined }
    let live = true
    const id = setTimeout(() => {
      catalogCall({ action: 'catalog-search', query }).then((res) => { if (live) setResults(res.ok ? res.results : []) })
    }, CATALOG_SEARCH_DELAY_MS)
    return () => { live = false; clearTimeout(id) }
  }, [query])

  const take = (entry) => {
    if (replacing && typeof window !== 'undefined' && window.confirm && !window.confirm(t('catReplaceConfirm'))) return
    setBusy(entry.id)
    setError(null)
    catalogCall({ action: 'catalog-apply', model, id: entry.id }).then((res) => {
      setBusy(null)
      if (res.ok) onApplied(res)
      else setError(catalogError(res))
    })
  }

  if (!open) return h('div', { style: { padding: '12px 0 0' } }, btn(t('catPick'), () => setOpen(true)))
  return h('div', { style: { padding: '12px 0 0', display: 'flex', flexDirection: 'column', gap: 8 } },
    h('input', { style: ui.input, value: query, placeholder: t('catSearchPlaceholder'), 'aria-label': t('catPick'), autoFocus: true, onChange: (e) => setQuery(e.target.value) }),
    error ? small(LIGHT.red, error) : null,
    results && results.length === 0 ? h('div', { style: ui.desc }, t('catNoResults')) : null,
    (results || []).map((entry) => h('div', { key: entry.id, style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { title: entry.id, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: PRIMARY } }, entry.id),
        h('div', { style: { fontSize: 11, color: TERTIARY, fontVariantNumeric: 'tabular-nums' } },
          catalogRates(entry.price) + (entry.timeBased ? ' · ' + t('catTimeBased') : ''))),
      btn(t('catFill'), () => take(entry), null, busy !== null))))
}
