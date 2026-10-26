// "Models" tab: side-by-side comparison of the models in view, cache hit trend and each model's token mix.

function ModelsTab(props) {
  const { view } = props
  const { days, total, cur, order, viz, spent, rank, bounds } = view
  const kinds = tokenKinds()
  const colors = kinds.map((k) => slotColor(viz, k.slot))
  const by = modelTotals(days)
  const lat = {}
  for (const row of latencyByModel(days, bounds)) lat[row.model] = row
  const shown = rank
  // A model's share is taken inside its own (largest) currency: amounts in different currencies are never added up.
  const shareOf = (r) => {
    const own = Object.keys(r.costs).filter((code) => r.costs[code] > 0).sort((a, b) => r.costs[b] - r.costs[a])[0]
    return own && total.costs[own] > 0 ? r.costs[own] / total.costs[own] : null
  }
  const hitPoints = days.map((d) => ({ key: d.key, value: hitRateOf(d.total) }))
  const mixOf = (model) => [by[model].inputTokens, by[model].outputTokens, by[model].cacheReadTokens, by[model].cacheWriteTokens]

  const table = {
    head: [t('model'), t('cost'), t('ovShare'), t('tokens'), t('colCalls'), t('colFailed'), t('kpiHit'), t('colAvg'), 'P95', t('colSpeed')],
    rows: shown.map((r) => {
      const l = lat[r.model]
      return [
        r.model, formatCosts(r.costs) || t('noCost'), pctText(shareOf(r)),
        volumeText(r, compactNumber), String(r.calls), String(r.failed), pctText(r.hit),
        l ? formatDuration(l.avgMs) : '—', l ? formatDuration(l.p95) : '—', l && l.tokensPerSec !== null ? t('tokPerSec', { n: Math.round(l.tokensPerSec) }) : '—',
      ]
    }),
  }

  return h('div', { style: stackGap },
    conclusion(shown.length === 0 ? t('conclEmpty') : t('conclModels', { n: shown.length, scope: scopeText(view), top: shown[0].model })),
    h(ChartCard, { title: t('modelsCompare'), sub: t('modelsCompareSub', { cur }) },
      shown.length > 0 ? h(DataTable, table) : emptyNote()),
    h('div', { style: grid2 },
      h(ChartCard, {
        title: t('chartHit'), sub: t('chartHitSub'),
        table: { head: [t('tableDate'), t('kpiHit'), t('rIn'), t('rCacheRead')],
          rows: days.map((d) => [d.key, pctText(hitRateOf(d.total)), compactNumber(d.total.inputTokens), compactNumber(d.total.cacheReadTokens)]) },
      }, hitPoints.some((p) => p.value !== null) ? h(RateLine, {
        points: hitPoints, color: slotColor(viz, 2), name: t('kpiHit'), label: t('chartHit'), xLabel: shortDay, tipTitle: (p) => p.key,
      }) : emptyNote()),
      h(ChartCard, {
        title: t('modelsMix'), sub: t('modelsMixSub'), legend: kinds.map((k, i) => ({ key: k.key, label: k.label, color: colors[i] })),
        table: { head: [t('model')].concat(kinds.map((k) => k.label)), rows: shown.map((r) => [r.model].concat(mixOf(r.model).map(compactNumber))) },
      }, shown.length > 0 ? h('div', null, shown.slice(0, 10).map((r) => {
        const mix = mixOf(r.model)
        const sum = mix.reduce((a, b) => a + b, 0)
        const title = kinds.map((k, i) => k.label + ' ' + pctText(sum > 0 ? mix[i] / sum : null)).join(' · ')
        return h('div', { key: r.model, style: { padding: '8px 0', borderBottom: BORDER } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 2, background: modelColor(viz, order, r.model), flex: '0 0 auto', alignSelf: 'center' } }),
            h('span', { style: { fontSize: 13, color: PRIMARY, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.model }, r.model),
            h('span', { style: { fontSize: 12, color: TERTIARY, fontVariantNumeric: 'tabular-nums' } }, volumeText(r, formatTok))),
          h(MixBar, { values: mix, colors, title }))
      })) : emptyNote())))
}
