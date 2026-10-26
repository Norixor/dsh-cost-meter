// "Latency" tab: where the waiting time goes — totals, distribution, trend, per-model split and the slowest calls.

function latencySentence(view) {
  const { lat } = view
  if (lat.calls === 0) return t('latEmpty')
  return t('conclLatency', {
    calls: lat.calls, avg: formatDuration(lat.avgMs), p50: formatDuration(lat.p50), p95: formatDuration(lat.p95),
    ttft: formatDuration(lat.ttftAvgMs), speed: lat.tokensPerSec === null ? '—' : t('tokPerSec', { n: Math.round(lat.tokensPerSec) }),
  })
}

/** Per-model latency table; the last column shows how the average call splits into waiting for the first token vs generating. */
function LatencyTable(props) {
  const { rows, colors } = props
  const cell = { padding: '8px 8px', fontSize: 12, whiteSpace: 'nowrap', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderBottom: BORDER, color: SECONDARY }
  const head = [t('model'), t('colCalls'), t('colAvg'), 'P50', 'P95', t('colTtft'), t('colSpeed'), t('colSplit')]
  return h('div', { style: { overflow: 'auto' } },
    h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
      h('thead', null, h('tr', null, head.map((text, i) => h('th', { key: i, style: Object.assign({}, cell, { color: TERTIARY, fontWeight: 400, textAlign: i === 0 || i === head.length - 1 ? 'left' : 'right' }) }, text)))),
      h('tbody', null, rows.map((r) => {
        const first = r.ttftShare === null ? 0 : r.ttftShare
        return h('tr', { key: r.model },
          h('td', { style: Object.assign({}, cell, { textAlign: 'left', color: PRIMARY, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }), title: r.model }, r.model),
          h('td', { style: cell }, String(r.calls)),
          h('td', { style: Object.assign({}, cell, { color: PRIMARY }) }, formatDuration(r.avgMs)),
          h('td', { style: cell }, formatDuration(r.p50)),
          h('td', { style: cell }, formatDuration(r.p95)),
          h('td', { style: cell }, formatDuration(r.ttftAvgMs)),
          h('td', { style: cell }, r.tokensPerSec === null ? '—' : t('tokPerSec', { n: Math.round(r.tokensPerSec) })),
          h('td', { style: Object.assign({}, cell, { textAlign: 'left', minWidth: 110 }) },
            r.ttftShare === null ? '—' : h(MixBar, { values: [first, 1 - first], colors, title: t('splitFirst') + ' ' + pctText(first) + ' · ' + t('splitGen') + ' ' + pctText(1 - first) })));
      }))))
}

function LatencyTab(props) {
  const { view } = props
  const { days, keys, viz, bounds, lat, latMerged, models, stats, insights } = view
  const [metric, setMetric] = React.useState('total')
  const splitColors = [slotColor(viz, 1), slotColor(viz, 0)]

  if (lat.calls === 0) {
    return h('div', { style: stackGap }, conclusion(latencySentence(view)), h('div', { style: Object.assign({}, ui.desc, { padding: '0 4px' }) }, t('latEmptyHint')))
  }

  const dist = histRows(metric === 'total' ? latMerged.durHist : latMerged.ttftHist, bounds)
  const distRows = dist.map((d) => ({ key: d.key, values: [d.count], total: d.count }))
  const distSeries = [{ key: 'calls', label: t('colCalls'), color: slotColor(viz, 0) }]
  const daily = latencyByDay(days, bounds)
  const dailyPoints = daily.map((d) => ({ key: d.key, values: [d.avgMs, d.ttftMs] }))
  const dailySeries = [
    { key: 'total', label: t('latTotal'), color: slotColor(viz, 0) },
    { key: 'first', label: t('latFirst'), color: slotColor(viz, 1) },
  ]
  const byModel = latencyByModel(days, bounds)
  const slow = slowestRows(stats.slowest, dayStartMs(keys[0]), models).slice(0, 10)
  const slowest = slow.length > 0 ? slow[0].durationMs : null
  const nameOf = (id) => (id ? '#' + (id.length > 8 ? id.slice(-6) : id) : '—')

  return h('div', { style: stackGap },
    conclusion(latencySentence(view)),
    h('div', { style: kpiGrid },
      kpiTile(t('kpiAvgTime'), formatDuration(lat.avgMs), t('kpiP50Sub', { p50: formatDuration(lat.p50) })),
      kpiTile(t('kpiP95'), formatDuration(lat.p95), slowest !== null ? t('kpiSlowestSub', { d: formatDuration(slowest) }) : null),
      kpiTile(t('kpiTtft'), formatDuration(lat.ttftAvgMs), lat.ttftP95 !== null ? t('kpiAvgTimeSub', { p95: formatDuration(lat.ttftP95) }) : null),
      kpiTile(t('kpiSpeed'), lat.tokensPerSec === null ? '—' : String(Math.round(lat.tokensPerSec)), t('kpiSpeedSub')),
      kpiTile(t('kpiWait'), formatDuration(lat.totalMs), t('kpiWaitSub', { n: lat.calls }))),

    h(Insights, { items: insights.filter((i) => i.group === 'latency') }),

    h('div', { style: grid2 },
      h(ChartCard, {
        title: t('latDist'), sub: t('latDistSub'),
        extra: segmented(metric, [{ value: 'total', label: t('latTotal') }, { value: 'first', label: t('latFirst') }], setMetric, t('latDist'), true),
        table: { head: [t('latBucket'), t('colCalls')], rows: dist.map((d) => [d.key, String(d.count)]) },
      }, h(StackedColumns, {
        rows: distRows, series: distSeries, label: t('latDist'), format: (v) => t('tipCalls', { n: v }), axisFormat: compactNumber,
        xLabel: (key) => key, labelFromStart: true, tipTitle: (row) => row.key,
      })),

      h(ChartCard, {
        title: t('latDaily'), sub: t('latDailySub'), legend: dailySeries,
        table: { head: [t('tableDate'), t('latTotal'), t('latFirst')], rows: daily.map((d) => [d.key, formatDuration(d.avgMs), formatDuration(d.ttftMs)]) },
      }, daily.some((d) => d.avgMs !== null) ? h(LineChart, {
        points: dailyPoints, series: dailySeries, label: t('latDaily'), format: formatDuration, axisFormat: formatDuration, xLabel: shortDay, tipTitle: (p) => p.key,
      }) : emptyNote())),

    h(ChartCard, {
      title: t('latModels'), sub: t('latModelsSub'),
      legend: [{ key: 'first', label: t('splitFirst'), color: splitColors[0] }, { key: 'gen', label: t('splitGen'), color: splitColors[1] }],
    }, h(LatencyTable, { rows: byModel, colors: splitColors })),

    h(ChartCard, { title: t('latSlow'), sub: t('latSlowSub') },
      slow.length === 0 ? emptyNote() : h(DataTable, {
        left: [1, 2, 6],
        head: [t('colTime'), t('model'), t('colSession'), t('colDuration'), t('colTtft'), t('colInOut'), t('colStatus')],
        rows: slow.map((e) => [
          formatStamp(e.at), e.model, nameOf(e.session), formatDuration(e.durationMs), formatDuration(e.ttftMs),
          compactNumber(e.input) + ' / ' + compactNumber(e.output), t(e.ok ? 'statusOk' : 'statusFailed'),
        ]),
      })))
}
