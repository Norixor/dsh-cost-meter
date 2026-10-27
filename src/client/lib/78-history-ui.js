// Importing past usage from DSH's own session logs: the one-time question, the settings section and a hint in the dock
// strip. The Host does the reading and the booking (history.js); this file shows what it found and sends the answer.

const HISTORY_MODELS_SHOWN = 5

/** The question is open while the Host has found importable calls and nobody has answered it yet. */
const historyAsk = (snap) => Boolean(snap && snap.history && snap.history.prompt === 'pending' && snap.history.scan && snap.history.scan.calls > 0)

const historyDay = (ms) => {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}
const historyWhen = (ms) => historyDay(ms) + ' ' + clockText(ms).slice(0, 5)

/** One Host call of the history panel; always resolves to an object with `ok` and `code`. */
const historyCall = (action) => postAction({ action })
  .then((res) => res || { ok: false, code: 'empty' })
  .catch((err) => ({ ok: false, code: 'network', error: (err && err.message) || String(err) }))

/** What a scan found as lines of text: counts and range, the estimate, and (unless `brief`) whatever could not be read. */
function historyFacts(scan, money, brief) {
  const lines = []
  if (scan.calls === 0) lines.push({ text: t('histScanNone') })
  else {
    lines.push({ text: t('histScanFound', { calls: scan.calls, sessions: scan.sessions, from: historyDay(scan.from), to: historyDay(scan.to) }) })
    const cost = formatCosts(money.convert(scan.costs))
    if (cost) lines.push({ text: t('histScanCost', { cost }) })
    const fx = money.note(scan.costs)
    if (fx) lines.push({ text: fx })
    if (scan.unpriced > 0) lines.push({ text: t('histScanUnpriced', { n: scan.unpriced }), warn: true })
  }
  if (brief) return lines
  const skipped = scan.skipped || {}
  if (skipped.unsupported > 0) lines.push({ text: t('histSkipUnsupported', { n: skipped.unsupported }) })
  if (skipped.damaged > 0) lines.push({ text: t('histSkipDamaged', { n: skipped.damaged }) })
  if (skipped.seeded > 0) lines.push({ text: t('histSkipSeeded', { n: skipped.seeded }) })
  if (scan.legacyPruned) lines.push({ text: t('histPruned') })
  return lines
}

/** The answer of an import as lines of text. */
function historyOutcome(res, money) {
  if (!res.ok) return [{ text: res.code === 'busy' ? t('histBusy') : t('histFailed', { error: res.error || res.code || 'unknown' }), warn: true }]
  const lines = [{ text: t('histDone', { calls: res.calls, sessions: res.sessions }) }]
  const cost = formatCosts(money.convert(res.costs))
  if (cost) lines.push({ text: t('histDoneCost', { cost }) })
  if (res.unpriced > 0) lines.push({ text: t('histScanUnpriced', { n: res.unpriced }), warn: true })
  return lines
}

const historyLines = (lines) => lines.map((line, i) => h('div', { key: i, style: { fontSize: 12, lineHeight: '18px', color: line.warn ? LIGHT.red : SECONDARY } }, line.text))

/** The top models of a scan: name on the left, calls and estimated cost on the right. */
function historyModels(scan, money) {
  const rows = Array.isArray(scan.models) ? scan.models.slice(0, HISTORY_MODELS_SHOWN) : []
  if (rows.length === 0) return null
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '2px 16px', marginTop: 6 } }, rows.map((row) => [
    h('span', { key: row.model + 'n', title: row.model, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: SECONDARY } }, row.model),
    h('span', { key: row.model + 'v', style: { fontSize: 12, color: TERTIARY, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
      t('tipCalls', { n: row.calls }) + ' · ' + (formatCosts(money.convert(row.costs)) || '—')),
  ]))
}

/**
 * The one-time question. Shown on the settings page, the statistics page and the right-sidebar page while it is open;
 * after "import" it stays for a few seconds with the result, then disappears.
 */
function HistoryPrompt(props) {
  const { snap } = props
  const prefs = usePrefs()
  const [busy, setBusy] = React.useState(false)
  const [outcome, setOutcome] = React.useState(null)
  React.useEffect(() => {
    if (!outcome) return undefined
    const id = setTimeout(() => setOutcome(null), 8000)
    return () => clearTimeout(id)
  }, [outcome])

  // `props.style` carries the caller's spacing, so a hidden prompt leaves no gap behind.
  const box = Object.assign({ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', borderRadius: 12, background: FILL, color: PRIMARY, minWidth: 0 }, props.style)
  const money = moneyView(prefs)
  if (outcome) return h('div', { style: box }, historyLines(historyOutcome(outcome, money)))
  if (!historyAsk(snap)) return null

  const answer = (action) => {
    setBusy(true)
    historyCall(action)
      .then((res) => { if (action === 'history-import') setOutcome(res) })
      .then(() => store.refresh())
      .then(() => setBusy(false))
  }
  return h('div', { style: box },
    h('div', { style: { fontSize: 14, lineHeight: '22px', fontWeight: 600 } }, t('histPromptTitle')),
    historyLines(historyFacts(snap.history.scan, money, true)),
    h('div', { style: { fontSize: 12, lineHeight: '18px', color: TERTIARY } }, t('histPromptWhere')),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
      btn(busy ? t('histImporting') : t('histImport'), () => answer('history-import'), 'primary', busy),
      btn(t('histPromptLater'), () => answer('history-dismiss'), null, busy)))
}

/** Dock strip item while the question is open: opens the right-sidebar page when the host has one. `item` is the strip's item style. */
function HistoryHint(props) {
  const { calls, item } = props
  const tip = t('histDockTip', { calls })
  const icon = uiIcon('history')
  const text = h('span', null, t('histDockHint'))
  if (!canOpenSide()) return h('span', { style: item, title: tip }, icon, text)
  return h('button', {
    type: 'button',
    title: tip,
    onClick: openSideTab,
    style: Object.assign({}, plainButton, item, { cursor: 'pointer', fontFamily: item.fontFamily || 'inherit' }),
  }, icon, text)
}

/** Settings → scan the logs, look at what would be imported, import it. */
function HistorySettings(props) {
  const hist = props.snap.history || { prompt: 'done', scan: null, scanning: false, importing: false, importedCalls: 0, lastImportAt: null }
  const prefs = usePrefs()
  const money = moneyView(prefs)
  const [busy, setBusy] = React.useState(null)
  const [outcome, setOutcome] = React.useState(null)
  const working = busy !== null || hist.scanning || hist.importing
  const scan = hist.scan

  const run = (action) => {
    setBusy(action)
    setOutcome(null)
    historyCall(action)
      .then((res) => { if (action === 'history-import') setOutcome(res) })
      .then(() => store.refresh())
      .then(() => setBusy(null))
  }
  const status = hist.lastImportAt ? t('histLast', { when: historyWhen(hist.lastImportAt), n: hist.importedCalls }) : t('histNever')

  return h('div', null,
    settingRow({ key: 'histStatus' }, t('histStatus'), status,
      btn(busy === 'history-scan' || hist.scanning ? t('histScanning') : t('histScan'), () => run('history-scan'), null, working),
      scan && scan.calls > 0 ? btn(busy === 'history-import' || hist.importing ? t('histImporting') : t('histImport'), () => run('history-import'), 'primary', working) : null),
    scan || outcome ? h('div', { style: { padding: '14px 0', borderBottom: BORDER, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
      outcome ? historyLines(historyOutcome(outcome, money)) : historyLines(historyFacts(scan, money)),
      outcome ? null : historyModels(scan, money)) : null,
    h('div', { style: Object.assign({}, ui.desc, { padding: '12px 0 0' }) }, t('histNote')))
}
