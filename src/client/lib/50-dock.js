/**
 * The strip itself, shared by the real dock and the style previews in the settings page.
 * `view` carries ready-to-print text (and the peak schedule, drawn by PeakBadge); `popover` is only passed by the real dock.
 */
function DockStrip(props) {
  const { prefs, view } = props
  const theme = dockTheme(prefs)
  // A <button> that renders exactly like the surrounding text unless the preset styles it.
  const chipStyle = Object.assign({}, plainButton, theme.item, {
    cursor: props.onToggle ? 'pointer' : 'default',
    userSelect: 'none',
    fontFamily: theme.item.fontFamily || 'inherit',
  })
  return h('div', { style: theme.wrap },
    h('span', { style: theme.item, title: view.title },
      uiIcon('session'),
      prefs.dockLight ? dot(view.light.color, 7) : null,
      prefs.dockTokens ? h('span', null, formatTok(view.tokens)) : null,
      h('span', { style: { color: view.overBudget ? LIGHT.red : SECONDARY } }, view.costText)),

    // Model chip + detail popover (hidden while the session has no calls).
    prefs.dockModels && view.modelsLabel ? h('span', { style: { position: 'relative', display: 'inline-flex' } },
      h('button', {
        type: 'button',
        style: chipStyle,
        title: t('clickHint'),
        'aria-expanded': props.open === true,
        onClick: props.onToggle,
      },
        uiIcon('models'),
        h('span', null, view.modelsLabel),
        view.multiModel ? h('span', { style: { fontSize: 9, opacity: 0.7 } }, props.open ? '▴' : '▾') : null),
      props.popover || null) : null,

    // Peak / off-peak right now, for the models this session uses (hidden when none of them has peak windows).
    prefs.dockPeak && view.peak ? h(PeakBadge, { schedule: view.peak, prefs, item: theme.item }) : null,

    view.unpricedText ? h('span', {
      style: Object.assign({}, theme.item, { color: LIGHT.red }),
      title: view.unpricedHint,
    }, view.unpricedText) : null,

    // While the "import past usage?" question is open: number of importable calls (null otherwise).
    view.historyCalls ? h(HistoryHint, { calls: view.historyCalls, item: theme.item }) : null)
}

function CostPills(props) {
  const sid = props.sessionId || (props.session && props.session.id) || (props.zone && props.zone.session && props.zone.session.id)
  const state = useStore()
  const snap = state.snap
  const prefs = usePrefs()
  // 模型明细浮窗开关；点击胶囊切换，点页面其它地方或按 Esc 关闭。
  const [open, setOpen] = React.useState(false)
  // Horizontal nudge (px) that keeps the popover inside the viewport.
  const [shift, setShift] = React.useState(0)
  const popoverRef = React.useRef(null)

  React.useLayoutEffect(() => {
    const el = popoverRef.current
    if (!open || !el) { setShift(0); return }
    const rect = el.getBoundingClientRect()
    const margin = 8
    let dx = 0
    if (rect.left < margin) dx = margin - rect.left
    else if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right
    if (dx !== 0) setShift(shift + dx)
  }, [open, snap])

  React.useEffect(() => {
    if (!open) return undefined
    const close = () => setOpen(false)
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!sid || !prefs.dock) return null
  const session = snap && snap.sessions ? snap.sessions[sid] : undefined
  const budget = snap ? snap.budget : undefined
  // 每个模型一行的明细，供浮窗展示：费用、单价、输入/输出/缓存读写 token、调用次数；费用高的排前面。
  // Money is shown in the display currency chosen in the settings (as billed when set to "original").
  const money = moneyView(prefs)
  const breakdown = sessionBreakdown(snap, sid, money.convert)
  const { rows, unpriced, unpricedModels } = breakdown
  const sessionTokens = breakdown.tokens
  const sessionInTok = breakdown.inTok
  const sessionCacheRead = breakdown.cacheRead

  // 预算只按预算货币统计本会话的费用（红绿灯用原始金额算）；显示时再折成所选币种。
  const spent = session && session.costs && budget ? (session.costs[budget.currency] || 0) : 0
  const light = lightFor(spent, budget)
  const sessionCosts = formatCosts(breakdown.costs) || t('noCost')
  const fx = money.note(session && session.costs)
  let detail
  if (light.pct === null) detail = t('noBudget')
  else if (light.pct >= 100) detail = t('overBudget') + ' ' + money.one(budget.currency, spent) + ' / ' + money.one(budget.currency, budget.amount)
  else detail = t('budgetUsed', { pct: light.pct.toFixed(0) }) + ' ' + money.one(budget.currency, spent) + ' / ' + money.one(budget.currency, budget.amount)
  const title = t('session') + ' · ' + detail + '\n' + t('tokens') + ' ' + String(sessionTokens) + ' · ' + t('cost') + ' ' + sessionCosts + (fx ? '\n' + fx : '')

  // 单模型直接显示模型名与费用；多模型合并成「n 个模型」，点击展开逐个明细。
  const modelsLabel = rows.length === 0 ? null : rows.length === 1
    ? rows[0].model + ' ' + (formatCosts(rows[0].costs) || t('noCost'))
    : t('modelsCount', { n: rows.length })

  const view = {
    title,
    light,
    tokens: sessionTokens,
    costText: sessionCosts,
    overBudget: light.pct !== null && light.pct >= 100,
    modelsLabel,
    multiModel: rows.length > 1,
    peak: peakSchedules(snap, sid)[0] || null,
    historyCalls: historyAsk(snap) ? snap.history.scan.calls : null,
    unpricedText: unpriced > 0 ? t('unpricedNamed', { models: unpricedModels.join(', '), n: unpriced }) : null,
    unpricedHint: t('unpricedHint') + '\n' + unpricedModels.join('\n'),
  }

  const headCell = { fontSize: 11, color: TERTIARY, padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 400 }
  const bodyCell = { fontSize: 12, color: SECONDARY, padding: '5px 6px', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', verticalAlign: 'top' }
  const subLine = { fontSize: 10, color: TERTIARY, lineHeight: '14px' }

  const popover = open ? h('div', {
    role: 'dialog',
    ref: popoverRef,
    style: {
      position: 'absolute',
      bottom: '100%',
      right: 0,
      marginBottom: 8,
      zIndex: 40,
      transform: shift ? 'translateX(' + shift + 'px)' : undefined,
      // 贴右侧对齐并向左展开，宽度与高度受视口约束，超出时内部滚动。
      maxWidth: 'min(660px, calc(100vw - 40px))',
      maxHeight: 'min(420px, 60vh)',
      overflow: 'auto',
      padding: 10,
      borderRadius: 10,
      border: BORDER,
      background: PLATFORM,
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      color: PRIMARY,
      // The popover keeps the system look whatever style the strip uses.
      fontFamily: 'inherit',
    },
    onClick: (e) => e.stopPropagation(),
  },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12, padding: '0 6px 6px' } },
      h('strong', { style: { fontWeight: 600 } }, t('detailTitle')),
      h('span', { style: { color: TERTIARY } },
        formatTok(sessionTokens) + ' · ' + t('hitRate') + ' ' + formatHitRate(sessionInTok, sessionCacheRead) + ' · ' + sessionCosts)),
    canOpenSide() ? h('div', { style: { padding: '0 6px 6px' } },
      h('button', {
        type: 'button',
        onClick: () => { setOpen(false); openSideTab() },
        style: Object.assign({}, plainButton, { cursor: 'pointer', fontSize: 12, color: SECONDARY, textDecoration: 'underline', textUnderlineOffset: 2 }),
      }, t('sideOpen'))) : null,
    h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
      h('thead', null, h('tr', null,
        h('th', { style: Object.assign({}, headCell, { textAlign: 'left' }) }, t('model')),
        h('th', { style: headCell }, t('tokIn')),
        h('th', { style: headCell }, t('tokOut')),
        h('th', { style: headCell }, t('tokCacheRead')),
        h('th', { style: headCell }, t('tokCacheWrite')),
        h('th', { style: headCell }, t('hitRate')),
        h('th', { style: headCell }, t('cost')))),
      h('tbody', null, rows.map(({ model, counter, price, costs, inTok, outTok, cacheRead, cacheWrite }) => h('tr', { key: model },
        h('td', { style: { padding: '5px 6px', whiteSpace: 'nowrap', verticalAlign: 'top' } },
          h('div', { style: { fontSize: 12, color: PRIMARY } }, model),
          h('div', { style: subLine }, rateLine(price)),
          price && Array.isArray(price.tiers) ? price.tiers.map((tier) => h('div', { key: tier.above, style: subLine },
            '>' + formatK(tier.above) + ' ' + rateLine(Object.assign(tierRates(price, tier), { currency: '' })))) : null),
        h('td', { style: bodyCell }, formatTok(inTok)),
        h('td', { style: bodyCell }, formatTok(outTok)),
        h('td', { style: bodyCell }, cacheRead > 0 ? formatTok(cacheRead) : '—'),
        h('td', { style: bodyCell }, cacheWrite > 0 ? formatTok(cacheWrite) : '—'),
        h('td', { style: Object.assign({}, bodyCell, { color: hitRateColor(inTok, cacheRead) }) }, formatHitRate(inTok, cacheRead)),
        h('td', { style: Object.assign({}, bodyCell, { color: PRIMARY }) },
          h('div', null, formatCosts(costs) || t('noCost')),
          counter.tierCalls > 0 ? h('div', { style: Object.assign({}, subLine, { color: LIGHT.yellow }) }, t('tierCount', { n: counter.tierCalls })) : null,
          counter.peakCalls > 0 ? h('div', { style: Object.assign({}, subLine, { color: LIGHT.yellow }) }, t('peakCount', { n: counter.peakCalls })) : null))))),
    h('div', { style: { fontSize: 11, color: TERTIARY, padding: '6px 6px 0', lineHeight: '16px', maxWidth: 560, whiteSpace: 'normal' } },
      t('rateLegend') + (unpriced > 0 ? ' · ' + t('unpriced', { n: unpriced }) : '') + (fx ? ' · ' + fx : ''))) : null

  return h(DockStrip, {
    prefs,
    view,
    open,
    popover,
    onToggle: (e) => { e.stopPropagation(); setOpen((v) => !v) },
  })
}
