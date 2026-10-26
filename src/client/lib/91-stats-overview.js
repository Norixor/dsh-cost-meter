// "Overview" tab: takeaway sentence, headline numbers, observations and the cost / token trends.

/** What the range and model filter currently cover, for the takeaway sentences. */
const scopeText = (view) => t('rangeDays', { n: view.range }) + (view.models ? t('scopeModels', { n: view.models.size, total: view.order.length }) : '')

function overviewSentence(view) {
  const { total, cur, spent, rank, hit, lat, tokens } = view
  if (total.calls === 0) return t('conclEmpty')
  const speed = lat.avgMs !== null ? t('conclAvgTime', { avg: formatDuration(lat.avgMs) }) : ''
  const top = rank.find((r) => r.cost > 0)
  if (spent > 0 && top) {
    return t('conclCost', {
      scope: scopeText(view), cost: formatCosts(total.costs), top: top.model, cur, pct: pctText(top.cost / spent), calls: total.calls, hit: pctText(hit),
    }) + speed
  }
  return t('conclNoCost', { scope: scopeText(view), calls: total.calls, tokens: formatTok(tokens) }) + speed
}

function OverviewTab(props) {
  const { view } = props
  const { days, total, cur, order, viz, spent, spanDays, tokens, hit, rank, lat, insights } = view
  const kinds = tokenKinds()
  const stack = stackByModel(days, cur, order)
  const costSeries = stack.series.map((s) => ({ key: s.key, label: s.key === '__other' ? t('other') : s.key, color: slotColor(viz, s.slot) }))
  const mix = tokenMix(days)
  const tokenSeries = kinds.map((k) => ({ key: k.key, label: k.label, color: slotColor(viz, k.slot) }))
  const mixTotals = [total.inputTokens, total.outputTokens, total.cacheReadTokens, total.cacheWriteTokens]
  const mixSum = mixTotals.reduce((a, b) => a + b, 0)
  const priced = rank.filter((r) => r.cost > 0).slice(0, 8)
  const hasCost = stack.rows.some((r) => r.total > 0)
  const hasTokens = mix.some((r) => r.total > 0)
  // Cost per day in every currency: the headline never drops a currency, only the money charts follow the toggle.
  const perDay = {}
  for (const code of Object.keys(total.costs)) perDay[code] = total.costs[code] / spanDays

  return h('div', { style: stackGap },
    total.calls > 0 ? conclusion(overviewSentence(view)) : null,
    h('div', { style: kpiGrid },
      kpiTile(t('kpiCost'), formatCosts(total.costs) || t('noCost'), formatCosts(total.costs) ? t('kpiCostSub', { avg: formatCosts(perDay) }) : null),
      kpiTile(t('kpiTokens'), compactNumber(tokens), t('kpiTokensSub', { i: compactNumber(total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens), o: compactNumber(total.outputTokens) })),
      kpiTile(t('kpiCalls'), String(total.calls), total.failed > 0 ? t('kpiCallsFailed', { n: total.failed }) : t('kpiCallsSub', { n: compactNumber(total.calls / spanDays) })),
      kpiTile(t('kpiHit'), pctText(hit), t('kpiHitSub', { n: compactNumber(total.cacheReadTokens) })),
      kpiTile(t('kpiAvgTime'), formatDuration(lat.avgMs), lat.p95 !== null ? t('kpiAvgTimeSub', { p95: formatDuration(lat.p95) }) : t('kpiNoTiming'))),

    total.calls === 0 ? h('div', { style: { padding: '14px 18px', borderRadius: 16, background: FILL } },
      h('div', { style: { fontSize: 14, color: PRIMARY } }, t('statsEmpty')),
      h('div', { style: Object.assign({}, ui.desc, { marginTop: 4 }) }, t('statsEmptyHint'))) : null,

    total.calls > 0 ? h(Insights, { items: insights.filter((i) => i.group === 'cost') }) : null,

    h('div', { style: grid2 },
      h(ChartCard, {
        title: t('chartDailyCost'), sub: t('chartDailyCostSub', { cur }),
        legend: costSeries.length > 1 ? costSeries : null,
        table: { head: [t('tableDate')].concat(costSeries.map((s) => s.label), costSeries.length > 1 ? [t('tableTotal')] : []),
          rows: stack.rows.map((r) => [r.key].concat(r.values.map(plainMoney), costSeries.length > 1 ? [plainMoney(r.total)] : [])) },
      }, hasCost ? h(StackedColumns, {
        rows: stack.rows, series: costSeries, label: t('chartDailyCost'),
        format: (v) => formatMoney(cur, v), axisFormat: compactNumber, xLabel: shortDay, tipTitle: (row) => row.key,
      }) : emptyNote()),

      h(ChartCard, {
        title: t('ovCostShare'), sub: t('ovCostShareSub', { cur }),
        table: { head: [t('model'), t('cost'), t('ovShare')], rows: priced.map((r) => [r.model, plainMoney(r.cost), pctText(spent > 0 ? r.cost / spent : null)]) },
      }, priced.length > 0 ? h(HBars, {
        color: slotColor(viz, 0),
        rows: priced.map((r) => ({
          key: r.model, name: r.model, color: modelColor(viz, order, r.model), value: r.cost,
          valueText: formatMoney(cur, r.cost) + ' · ' + pctText(spent > 0 ? r.cost / spent : null),
          sub: volumeText(r, formatTok) + ' · ' + t('tipCalls', { n: r.calls }), title: r.model,
        })),
      }) : emptyNote()),

      h(ChartCard, {
        title: t('chartTokens'), sub: t('chartTokensSub'), legend: tokenSeries,
        table: { head: [t('tableDate')].concat(tokenSeries.map((s) => s.label), [t('tableTotal')]),
          rows: mix.map((r) => [r.key].concat(r.values.map(compactNumber), [compactNumber(r.total)])) },
      }, hasTokens ? h(StackedColumns, {
        rows: mix, series: tokenSeries, label: t('chartTokens'),
        format: formatTok, axisFormat: compactNumber, xLabel: shortDay, tipTitle: (row) => row.key,
      }) : emptyNote()),

      h(ChartCard, {
        title: t('ovTokenUse'), sub: t('ovTokenUseSub'),
        table: { head: [t('tokenKind'), t('tokens'), t('ovShare')], rows: kinds.map((k, i) => [k.label, compactNumber(mixTotals[i]), pctText(mixSum > 0 ? mixTotals[i] / mixSum : null)]) },
      }, mixSum > 0 ? h(HBars, {
        color: slotColor(viz, 0),
        rows: kinds.map((k, i) => ({
          key: k.key, name: k.label, color: slotColor(viz, k.slot), value: mixTotals[i],
          valueText: compactNumber(mixTotals[i]) + ' · ' + pctText(mixTotals[i] / mixSum),
        })),
      }) : emptyNote())))
}
