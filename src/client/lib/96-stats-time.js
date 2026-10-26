// "Time of use" tab: 24-hour distribution and weekday × hour heat map, plus a few headline facts.

function TimeTab(props) {
  const { view } = props
  const { stats, keys, viz, models } = view
  const [metric, setMetric] = React.useState('calls')
  const hours = hourStats(stats.hourly || {}, keys, models)
  const fmt = metric === 'calls' ? (v) => t('tipCalls', { n: v }) : formatTok
  const peak = peakHour(hours.hours, metric)
  const work = hourShare(hours.hours, metric, 9, 18)
  const night = hourShare(hours.hours, metric, 0, 6)
  const hourRows = hours.hours.map((slot, hr) => ({ key: String(hr).padStart(2, '0'), values: [slot[metric]], total: slot[metric] }))
  const series = [{ key: metric, label: t(metric === 'calls' ? 'metricCalls' : 'metricTokens'), color: slotColor(viz, 0) }]
  const hasData = hours.calls > 0

  return h('div', { style: stackGap },
    conclusion(hasData && peak !== null
      ? t('conclTime', { scope: scopeText(view), h: peak, h2: (peak + 1) % 24, work: pctText(work), night: pctText(night) })
      : t('conclEmpty')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' } },
      h('div', { style: ui.desc }, t('timeSub')),
      segmented(metric, [{ value: 'calls', label: t('metricCalls') }, { value: 'tokens', label: t('metricTokens') }], setMetric, t('timeTitle'), true)),
    hasData ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 } },
      fact(t('insPeak'), peak === null ? '—' : t('insPeakValue', { h: peak, h2: (peak + 1) % 24 })),
      fact(t('insBusyDay'), hours.busiest ? shortDay(hours.busiest.key) + ' · ' + t('tipCalls', { n: hours.busiest.calls }) : '—'),
      fact(t('insWork'), pctText(work)),
      fact(t('insNight'), pctText(night))) : null,
    h('div', { style: grid2 },
      h(ChartCard, {
        title: t('hourlyTitle'), sub: series[0].label,
        table: { head: [t('hourlyTitle'), series[0].label], rows: hourRows.map((r) => [r.key + ':00', String(r.total)]) },
      }, hasData ? h(StackedColumns, {
        rows: hourRows, series, height: 200, label: t('hourlyTitle'), format: fmt, axisFormat: compactNumber,
        xLabel: (key) => key, labelFromStart: true, tipTitle: (row) => row.key + ':00–' + String((Number(row.key) + 1) % 24).padStart(2, '0') + ':00',
      }) : emptyNote()),
      h(ChartCard, {
        title: t('heatTitle'), sub: t('heatSub'),
        table: { head: [t('heatTitle')].concat(Array.from({ length: 24 }, (_, hr) => String(hr))),
          rows: hours.grid.map((row, wd) => [t('wd' + wd)].concat(row.map((cell) => String(cell[metric])))) },
      }, hasData ? h(Heatmap, { grid: hours.grid, metric, ramp: viz.ramp, format: fmt, weekdayLabel: (wd) => t('wd' + wd) }) : emptyNote())))
}
