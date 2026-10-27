// Right-sidebar page: the cost of the session on screen, per model, refreshed with the shared snapshot poll.
// The host owns the column; this file only supplies the page type's body and the controller used to open it.

const SIDE_KIND = 'cost-meter'
const SIDE_ID = '@norixor/dsh-cost-meter/side'
const RECENT_SHOWN = 12
// Keep in sync with CALLS_PER_SESSION in calllog.js: the Host keeps this many finished calls per session.
const CALLS_KEPT = 80

// Set by apply() once the host offers the right sidebar; stays null on hosts without it (the open link is then hidden).
let sideRight = null
const setSideRight = (controller) => { sideRight = controller }
const canOpenSide = () => sideRight !== null
function openSideTab() {
  try { if (sideRight) sideRight.openTab(SIDE_KIND) } catch { /* no session on screen, or the host refused the page */ }
}

const clockText = (ms) => {
  const d = new Date(ms)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

const sideLabel = { fontSize: 11, color: TERTIARY, letterSpacing: 0.2 }
const sideNote = { fontSize: 11, lineHeight: '16px', color: TERTIARY }

/** A thin bar showing `share` (0–1) of the session's cost. */
function ShareBar(props) {
  return h('div', { style: { height: 3, borderRadius: 2, background: FILL, overflow: 'hidden' } },
    h('div', { style: { height: '100%', width: (props.share === null ? 0 : Math.max(2, props.share * 100)) + '%', borderRadius: 2, background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 50%, transparent)' } }))
}

function SideModelRow(props) {
  const { row } = props
  const hit = formatHitRate(row.inTok, row.cacheRead)
  const tokens = t('msgInOut', { i: formatTok(row.inTok + row.cacheRead + row.cacheWrite), o: formatTok(row.outTok) })
  const rest = (row.cacheRead > 0 ? [t('hitRate') + ' ' + hit] : []).concat(t('tipCalls', { n: row.counter.calls || 0 })).join(' · ')
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 } },
      h('span', { title: row.model, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: PRIMARY } }, row.model),
      h('span', { style: { whiteSpace: 'nowrap', fontSize: 13, fontVariantNumeric: 'tabular-nums', color: row.counter.unpriced > 0 && !formatCosts(row.costs) ? LIGHT.red : PRIMARY } },
        formatCosts(row.costs) || (row.counter.unpriced > 0 ? t('msgNoCost') : t('noCost')))),
    h(ShareBar, { share: row.share }),
    h('div', { style: Object.assign({}, sideNote, { fontVariantNumeric: 'tabular-nums' }) }, tokens),
    h('div', { style: Object.assign({}, sideNote, { fontVariantNumeric: 'tabular-nums' }) }, rest),
    row.counter.unpriced > 0 ? h('div', { style: Object.assign({}, sideNote, { color: LIGHT.red }) }, t('unpriced', { n: row.counter.unpriced })) : null)
}

/** One finished call of the log: time, model, cost, and a line of turn / tokens / first-token delay. */
function SideCallRow(props) {
  const { call, show } = props
  const cost = call.cost !== null && call.currency ? formatCosts(show(call.currency, call.cost)) : null
  const detail = []
  if (Number.isInteger(call.turn)) detail.push(t('sideTurn', { n: call.turn }))
  if (call.media) detail.push(call.media + (call.units ? ' ×' + call.units : ''))
  else if (call.ok || call.input + call.output + call.cacheRead + call.cacheWrite > 0) detail.push(t('msgInOut', { i: formatTok(call.input + call.cacheRead + call.cacheWrite), o: formatTok(call.output) }))
  if (call.ttftMs !== null && call.ttftMs !== undefined) detail.push(t('sideTtft', { time: formatDuration(call.ttftMs) }))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
      h('span', { style: { fontSize: 11, color: TERTIARY, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' } }, clockText(call.end)),
      h('span', { title: call.model, style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: SECONDARY } }, call.model),
      call.ok ? null : h('span', { style: { fontSize: 11, color: LIGHT.red, flex: '0 0 auto' } }, t('sideFailed')),
      h('span', { style: { fontSize: 12, color: SECONDARY, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' } }, cost || '—')),
    h('div', { style: Object.assign({}, sideNote, { paddingLeft: 0, fontVariantNumeric: 'tabular-nums' }) }, detail.join(' · ')))
}

/** Body of the right-sidebar page type; `sessionId` is a standard prop of the session-scoped seat. */
function SideCostTab(props) {
  const sid = sessionKey(props.sessionId)
  const state = useStore()
  const prefs = usePrefs()
  const log = useCalls(sid)
  const snap = state.snap
  const wrap = { boxSizing: 'border-box', height: '100%', overflowY: 'auto', padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', gap: 18, color: PRIMARY, fontSize: 13 }
  if (!sid) return h('div', { style: Object.assign({}, wrap, { color: TERTIARY }) }, t('sideNoSession'))
  if (!snap) return h('div', { style: Object.assign({}, wrap, { color: state.error ? LIGHT.red : TERTIARY }) }, state.error ? t('loadFailed', { error: state.error }) : t('statsLoading'))

  // Money is shown in the display currency chosen in the settings (amounts already in it are kept), as billed otherwise.
  const money = moneyView(prefs)
  const show = (currency, amount) => money.convert({ [currency]: amount })
  const b = sessionBreakdown(snap, sid, money.convert)
  const fx = money.note(b.session ? b.session.costs : {})

  const budget = snap.budget
  const spent = b.session && b.session.costs && budget ? (b.session.costs[budget.currency] || 0) : 0
  const light = lightFor(spent, budget)
  const recent = log.calls.slice(-RECENT_SHOWN).reverse()
  const hasData = b.rows.length > 0 || recent.length > 0
  const peaks = peakSchedules(snap, sid)

  return h('div', { style: wrap },
    h(HistoryPrompt, { snap }),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: sideLabel }, t('session')),
        h('span', { style: Object.assign({}, sideLabel, { display: 'inline-flex', alignItems: 'center', gap: 5 }), title: t('sideLive', { s: POLL_MS / 1000 }) },
          dot(LIGHT.green, 6), t('sideLive', { s: POLL_MS / 1000 }))),
      h('div', { style: { fontSize: 26, lineHeight: '32px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, formatCosts(b.costs) || t('noCost')),
      hasData ? h('div', { style: Object.assign({}, sideNote, { fontVariantNumeric: 'tabular-nums' }) },
        [t('tipCalls', { n: b.calls }), formatTok(b.tokens), t('hitRate') + ' ' + formatHitRate(b.inTok, b.cacheRead)].join(' · ')) : null,
      fx ? h('div', { style: sideNote }, fx) : null,
      light.pct !== null ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
        h('div', { style: { height: 4, borderRadius: 2, background: FILL, overflow: 'hidden' } },
          h('div', { style: { height: '100%', width: Math.min(100, light.pct) + '%', background: light.color } })),
        h('div', { style: sideNote }, (light.pct >= 100 ? t('overBudget') : t('budgetUsed', { pct: light.pct.toFixed(0) })) + ' · ' + money.one(budget.currency, spent) + ' / ' + money.one(budget.currency, budget.amount))) : null),

    hasData ? null : h('div', { style: { fontSize: 13, color: TERTIARY } }, t('sideEmpty')),

    prefs.sidePeak && peaks.length > 0 ? h('section', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h('div', { style: sideLabel }, t('peakTag')),
      peaks.map((schedule) => h(PeakBlock, { key: schedule.key, schedule, countdown: true, detail: prefs.sidePeakDetail }))) : null,

    prefs.sideBalance ? h(BalanceBlock, { snap }) : null,

    b.rows.length > 0 ? h('section', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h('div', { style: sideLabel }, t('sideModels')),
      b.rows.map((row) => h(SideModelRow, { key: row.model, row }))) : null,

    recent.length > 0 ? h('section', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      h('div', { style: sideLabel }, t('sideRecent')),
      recent.map((call) => h(SideCallRow, { key: call.end + ':' + call.model + ':' + call.at, call, show })),
      h('div', { style: sideNote }, t('sideNote', { n: CALLS_KEPT }))) : null,

    b.unpriced > 0 ? h('div', { style: Object.assign({}, sideNote, { color: LIGHT.red }) }, t('unpricedNamed', { models: b.unpricedModels.join(', '), n: b.unpriced })) : null)
}
