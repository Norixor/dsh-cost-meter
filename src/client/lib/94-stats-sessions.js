// "Sessions" tab: which conversations are busiest and how their tokens split. Sessions are lifetime totals active in the range.

function SessionsTab(props) {
  const { view } = props
  const { sessions, keys, stats, cur, viz, models } = view
  const [sort, setSort] = React.useState('recent')
  const [query, setQuery] = React.useState('')
  const kinds = tokenKinds()
  const colors = kinds.map((k) => slotColor(viz, k.slot))
  const fromMs = dayStartMs(keys[0])
  const toMs = dayStartMs(shiftDay(stats.today, 1)) - 1
  const all = sessionRows(sessions, fromMs, toMs, cur, sort, models, query)
  const rows = all.slice(0, 10)
  const sorts = [
    { value: 'recent', label: t('sortRecent') },
    { value: 'cost', label: t('sortCost') },
    { value: 'calls', label: t('sortCalls') },
    { value: 'tokens', label: t('sortTokens') },
    { value: 'duration', label: t('sortDuration') },
  ]
  const nameOf = (row) => '#' + row.label
  const top = all.length > 0 ? all[0] : null

  const list = rows.length === 0 ? h('div', { style: { padding: '20px 0', textAlign: 'center', fontSize: 13, color: TERTIARY } }, t('sessionsEmpty'))
    : h('div', null, rows.map((row) => {
      const mixTotal = row.mix.reduce((a, b) => a + b, 0)
      const mixTitle = kinds.map((k, i) => k.label + ' ' + pctText(mixTotal > 0 ? row.mix[i] / mixTotal : null)).join(' · ')
      return h('div', { key: row.id, style: { padding: '12px 0', borderBottom: BORDER } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, color: PRIMARY, fontVariantNumeric: 'tabular-nums' }, title: row.id }, nameOf(row)),
          h('span', { style: { fontSize: 12, color: TERTIARY, flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            (row.main || '—') + (row.modelCount > 1 ? ' +' + (row.modelCount - 1) : '')),
          h('span', { style: { fontSize: 13, color: PRIMARY, fontVariantNumeric: 'tabular-nums' } }, formatCosts(row.costs) || '—')),
        h('div', { style: { fontSize: 12, color: TERTIARY, margin: '2px 0 8px' } },
          [t('colLast') + ' ' + formatStamp(row.updatedAt), t('tipCalls', { n: row.calls }), formatTok(row.tokens)]
            .concat(row.spanMs > 0 ? [t('sessionSpan', { d: formatDuration(row.spanMs) })] : [])
            .concat(row.firstAt ? [t('sessionSince', { at: formatStamp(row.firstAt) })] : []).join(' · ')),
        h(MixBar, { values: row.mix, colors, title: mixTitle }))
    }))

  const search = h('input', {
    type: 'search', value: query, placeholder: t('sessionsSearch'), 'aria-label': t('sessionsSearch'),
    onChange: (e) => setQuery(e.target.value),
    style: Object.assign({}, ui.input, { width: 180, height: 28, fontSize: 12, borderRadius: 10 }),
  })

  return h('div', { style: stackGap },
    conclusion(top ? t('conclSessions', { n: all.length, scope: scopeText(view), id: nameOf(top), main: top.main || '—' }) : t('conclEmpty')),
    h(ChartCard, {
      title: t('sessionsTitle'), sub: t('sessionsSub'), legend: kinds.map((k, i) => ({ key: k.key, label: k.label, color: colors[i] })),
      extra: h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, search, segmented(sort, sorts, setSort, t('sessionsTitle'), true)),
      table: { head: [t('colSession'), t('colLast'), t('colCalls'), t('colTokens'), t('rIn'), t('rOut'), t('rCacheRead'), t('rCacheWrite'), t('colCost')],
        rows: all.map((r) => [nameOf(r) + ' ' + (r.main || ''), formatStamp(r.updatedAt), String(r.calls), compactNumber(r.tokens)]
          .concat(r.mix.map(compactNumber), [formatCosts(r.costs) || '—'])) },
    }, list, h('div', { style: { fontSize: 11, color: TERTIARY, paddingTop: 10 } }, t('sessionsNote'))))
}
