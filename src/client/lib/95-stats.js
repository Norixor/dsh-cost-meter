const STATS_POLL_MS = 10000

/**
 * Loads the per-day buckets; keeps the previous render while a refresh is in flight.
 * While `auto` is on it reloads every STATS_POLL_MS (paused when the tab is hidden); `reload()` is the manual refresh.
 */
function useStats(auto) {
  const [stats, setStats] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [updatedAt, setUpdatedAt] = React.useState(null)
  const alive = React.useRef(true)
  const load = React.useCallback(() => {
    setLoading(true)
    return postAction({ action: 'stats' }).then((data) => {
      if (!alive.current) return
      if (data && data.ok) { setStats(data); setError(null); setUpdatedAt(Date.now()) } else setError((data && data.error) || 'unknown')
    }).catch((err) => { if (alive.current) setError((err && err.message) || String(err)) })
      .then(() => { if (alive.current) setLoading(false) })
  }, [])
  React.useEffect(() => {
    alive.current = true
    load()
    return () => { alive.current = false }
  }, [load])
  React.useEffect(() => {
    if (!auto) return undefined
    const timer = setInterval(() => { if (!document.hidden) load() }, STATS_POLL_MS)
    return () => clearInterval(timer)
  }, [auto, load])
  return { stats, error, loading, updatedAt, reload: load }
}

const TAB_KEY = 'dsh-cost-meter:statsTab'
const STATS_TABS = ['overview', 'latency', 'models', 'sessions', 'time']

/** The last open tab is only a per-viewer convenience: storage may be unavailable or hold anything. */
function readTab() {
  try {
    const value = window.localStorage.getItem(TAB_KEY)
    return STATS_TABS.indexOf(value) >= 0 ? value : 'overview'
  } catch { return 'overview' }
}
function writeTab(value) {
  try { window.localStorage.setItem(TAB_KEY, value) } catch { /* storage unavailable */ }
}

/**
 * The sidebar page: statistics only. Header tabs pick the view; the filter row below them (range, models, currency)
 * scopes every tab, and each tab adds its own controls inside its cards.
 */
function StatsPage() {
  const state = useStore()
  const prefs = usePrefs()
  const auto = prefs.statsAuto !== false
  const { stats, error, loading, updatedAt, reload } = useStats(auto)
  // With auto-refresh off the page holds still: the shared snapshot (sessions, prices) is frozen like the daily data.
  const [held, setHeld] = React.useState(null)
  const [tab, setTabState] = React.useState(readTab)
  const [rangePick, setRangePick] = React.useState(null)
  const [modelPick, setModelPick] = React.useState(null)
  const [dark, probe] = useDark()
  const probeEl = h('span', { ref: probe, 'aria-hidden': true, style: { display: 'none', color: PRIMARY } })
  const snap = auto ? state.snap : (held || state.snap)
  // Money is converted into one currency for display (amounts already in it are kept), or left as billed.
  const mode = prefs.statsCurrency
  const converted = mode !== 'original'
  const rate = prefs.usdCny
  const rawDaily = stats ? stats.daily : null
  const rawSessions = snap ? snap.sessions : null
  const rawModels = snap ? snap.models : null
  const daily = React.useMemo(() => (converted ? convertDaily(rawDaily, mode, rate) : rawDaily), [rawDaily, converted, mode, rate])
  const sessions = React.useMemo(() => (converted ? convertSessions(rawSessions, mode, rate) : rawSessions || {}), [rawSessions, converted, mode, rate])
  const modelStats = React.useMemo(() => (converted ? convertModels(rawModels, mode, rate) : rawModels), [rawModels, converted, mode, rate])
  const setTab = (value) => { setTabState(value); writeTab(value) }
  const refreshNow = () => Promise.all([store.refresh(), reload()]).then(() => setHeld(store.state.snap))
  const setAuto = (on) => { if (!on) setHeld(store.state.snap); store.setPrefs({ statsAuto: on }) }

  if (!stats || !snap) {
    return h('div', { style: { padding: 24, color: error || state.error ? LIGHT.red : TERTIARY } }, probeEl,
      error || state.error ? t('loadFailed', { error: error || state.error }) : t('statsLoading'))
  }

  const viz = dark ? VIZ.dark : VIZ.light
  const range = rangePick || prefs.statsRange
  const keys = rangeKeys(stats.today, range)
  const order = modelOrder(modelStats)
  // A saved selection only counts for models that still exist; an empty result falls back to "all".
  const known = new Set(order)
  const kept = modelPick ? Array.from(modelPick).filter((m) => known.has(m)) : []
  const models = kept.length > 0 && kept.length < order.length ? new Set(kept) : null

  // Charts need one currency: the chosen one, or (as billed) the one with the most cost in the unfiltered range.
  const everything = buildDays(daily, keys)
  const currencies = currenciesOf(everything)
  const cur = converted ? mode : currencies.length > 0 ? currencies[0].cur : (snap.budget && snap.budget.currency) || 'CNY'
  // Currencies that were folded into the chosen one, for the footnote next to the control.
  const folded = converted ? convertedFrom(sumDays(buildDays(stats.daily, keys, models)).costs, mode, rate) : []

  const days = buildDays(daily, keys, models)
  const total = sumDays(days)
  const spent = total.costs[cur] || 0
  // Average over the days that can have data (recording starts at `since`), not over a mostly empty range.
  const sinceAt = stats.since ? keys.indexOf(stats.since) : -1
  const spanDays = sinceAt >= 0 ? keys.length - sinceAt : keys.length
  const bounds = Array.isArray(stats.latencyBounds) ? stats.latencyBounds : []
  const latMerged = mergeLatency(days.flatMap((d) => Object.values(d.models)), bounds)
  const lat = summarizeLatency(latMerged, bounds)
  const rank = rankModels(days, cur)
  const hit = hitRateOf(total)
  const top = rank.find((r) => r.cost > 0)
  const insights = insightsOf({
    calls: total.calls, failed: total.failed, unpriced: total.unpriced, peakCalls: total.peakCalls, tierCalls: total.tierCalls,
    hit, inputSide: total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens,
    models: rank.length, topModel: top ? top.model : null, topShare: top && spent > 0 ? top.cost / spent : 0,
    latency: { calls: lat.calls, p95Ms: lat.p95, ttftAvgMs: lat.ttftAvgMs, slowCalls: countAbove(latMerged.durHist, bounds, 60000) },
  })

  const view = {
    snap, stats, sessions, viz, keys, range, days, total, cur, order, models, bounds, latMerged, lat, rank, insights,
    spent, spanDays, hit, tokens: tokensOf(total),
  }
  const calls = {}
  for (const day of everything) for (const m of Object.keys(day.models)) calls[m] = (calls[m] || 0) + (day.models[m].calls || 0)
  const options = order.map((id) => ({ id, color: modelColor(viz, order, id), calls: calls[id] || 0 }))
  const tabs = [
    { value: 'overview', label: t('tabOverview') },
    { value: 'latency', label: t('tabLatency') },
    { value: 'models', label: t('tabModels') },
    { value: 'sessions', label: t('tabSessions') },
    { value: 'time', label: t('tabTime') },
  ]
  const Body = { overview: OverviewTab, latency: LatencyTab, models: ModelsTab, sessions: SessionsTab, time: TimeTab }[tab] || OverviewTab

  return h('div', { style: { padding: '20px clamp(16px, 4vw, 24px) 48px', boxSizing: 'border-box', minWidth: 0 } }, probeEl,
    h('div', { style: { marginBottom: 6, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { fontSize: 18, fontWeight: 600, color: PRIMARY } }, t('statsTitle')),
        h('div', { style: Object.assign({}, ui.desc, { marginTop: 4 }) }, stats.since ? t('statsSub', { since: stats.since }) : null)),
      h(StatsRefresh, { auto, onAuto: setAuto, onRefresh: refreshNow, loading, updatedAt })),
    h(HistoryPrompt, { snap: state.snap, style: { margin: '8px 0 10px' } }),
    h(StatsTabs, { tabs, value: tab, onChange: setTab }),
    // Secondary row: the filters that scope every tab.
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '14px 0 16px' } },
      segmented(range, STATS_RANGES.map((n) => ({ value: n, label: t('rangeDays', { n }) })), setRangePick, t('filterRange')),
      h(ModelFilter, { options, selected: models, onChange: setModelPick }),
      segmented(mode, [
        { value: 'CNY', label: t('curCny') },
        { value: 'USD', label: t('curUsd') },
        { value: 'original', label: t('curOriginal') },
      ], (value) => store.setPrefs({ statsCurrency: value }), t('currencyView')),
      folded.length > 0 ? h('span', { style: { fontSize: 12, color: TERTIARY } }, fxNoteText(folded, rate)) : null,
      models ? h('button', { type: 'button', onClick: () => setModelPick(null), style: Object.assign({}, plainButton, { fontSize: 12, color: TERTIARY, cursor: 'pointer' }) }, t('filterReset')) : null),
    error ? h('div', { style: { color: LIGHT.red, fontSize: 12, paddingBottom: 8 } }, t('loadFailed', { error })) : null,
    h('div', { role: 'tabpanel', id: 'dsh-cost-panel', 'aria-labelledby': 'dsh-cost-tab-' + tab }, h(Body, { view })))
}

/** `main` slot wrapper: the page scrolls inside the centre area, with a readable maximum width. */
function StatsMainPage() {
  return h('div', { style: { height: '100%', overflowY: 'auto', boxSizing: 'border-box' } },
    h('div', { style: { maxWidth: 1080, margin: '0 auto' } }, h(StatsPage)))
}
