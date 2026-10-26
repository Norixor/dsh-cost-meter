// Chart primitives for the statistics page (hand-drawn SVG / flex, no chart library).
// Marks follow the dataviz rules: thin marks, 2px surface gaps, hairline solid grid, legends for 2+ series,
// a hover/keyboard tooltip on every chart and a table twin in ChartCard.

// Categorical slots 1–7 and the sequential blue ramp, validated for the light and dark surfaces.
const VIZ = {
  light: {
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'],
    other: '#898781',
    ramp: ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab'],
  },
  dark: {
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
    other: '#898781',
    // On a dark surface "near zero" recedes into the surface, so the ramp runs dark → bright.
    ramp: ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef'],
  },
}
const GRID = 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)'
const AXIS = 'color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)'
const WASH = 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)'

const slotColor = (viz, slot) => (slot === null || slot === undefined ? viz.other : viz.series[slot % viz.series.length])

/** Is the app currently on a dark surface? Reads the resolved primary text colour of a hidden probe element. */
function readsDark(probe) {
  const color = window.getComputedStyle(probe).color || ''
  let rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color)
  let scale = 255
  if (!rgb) { rgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(color); scale = 1 }
  if (!rgb) return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  // Light text means a dark surface.
  return (0.299 * rgb[1] + 0.587 * rgb[2] + 0.114 * rgb[3]) / scale > 0.6
}

/** Returns [dark, probeRef]; render <span ref={probeRef} style={{display:'none', color: PRIMARY}}/> once on the page. */
function useDark() {
  const probe = React.useRef(null)
  const [dark, setDark] = React.useState(false)
  React.useLayoutEffect(() => {
    const update = () => { if (probe.current) setDark(readsDark(probe.current)) }
    update()
    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(update) : null
    if (observer) {
      observer.observe(document.documentElement, { attributes: true })
      observer.observe(document.body, { attributes: true })
    }
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
    if (media && media.addEventListener) media.addEventListener('change', update)
    return () => {
      if (observer) observer.disconnect()
      if (media && media.removeEventListener) media.removeEventListener('change', update)
    }
  }, [])
  return [dark, probe]
}

/** Measured width of the element the returned ref is attached to. */
function useWidth() {
  const ref = React.useRef(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const update = () => setWidth(Math.round(el.getBoundingClientRect().width))
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [width, ref]
}

/** Floating readout. Values lead (strong), names follow (secondary); series are keyed by a short line. */
function Tip(props) {
  const flip = props.x > props.width / 2
  return h('div', {
    role: 'status',
    style: {
      position: 'absolute', left: props.x, top: Math.max(0, props.y), zIndex: 5, pointerEvents: 'none',
      transform: flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
      minWidth: 150, maxWidth: 260, padding: '8px 10px', borderRadius: 10, border: BORDER, background: PLATFORM,
      boxShadow: '0 6px 20px rgba(0,0,0,.16)', fontSize: 12, color: PRIMARY,
    },
  },
    h('div', { style: { color: SECONDARY, marginBottom: 4 } }, props.title),
    props.rows.map((row, i) => h('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 8, lineHeight: '18px' } },
      row.color ? h('span', { style: { width: 10, height: 2, borderRadius: 1, background: row.color, flex: '0 0 auto' } }) : null,
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: SECONDARY } }, row.name),
      h('strong', { style: { fontWeight: 600, color: PRIMARY, fontVariantNumeric: 'tabular-nums' } }, row.value))))
}

function Legend(props) {
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', padding: '0 0 10px' } }, props.items.map((item) => h('span', {
    key: item.key,
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: SECONDARY, minWidth: 0 },
  },
    h('span', { style: { width: 10, height: 10, borderRadius: 2, background: item.color, flex: '0 0 auto' } }),
    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 } }, item.label))))
}

/** Square-bottomed column with a 4px rounded data end. */
function roundedTop(x, y, w, hgt, r) {
  const rr = Math.max(0, Math.min(r, hgt, w / 2))
  return 'M' + x + ',' + (y + hgt) + 'V' + (y + rr) + 'Q' + x + ',' + y + ' ' + (x + rr) + ',' + y
    + 'H' + (x + w - rr) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + rr) + 'V' + (y + hgt) + 'Z'
}

const CHART_MARGIN = { l: 44, r: 8, t: 10, b: 26 }

/** Shared pointer / keyboard handling: hover = { i, x, y } snapped to the nearest slot. */
function useSlotHover(count, plotLeft, slot) {
  const [hover, setHover] = React.useState(null)
  const at = (i, y) => ({ i, x: plotLeft + (i + 0.5) * slot, y })
  const handlers = {
    tabIndex: 0,
    onPointerMove: (e) => {
      if (count === 0 || slot <= 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      const i = Math.min(count - 1, Math.max(0, Math.floor((e.clientX - rect.left - plotLeft) / slot)))
      setHover(at(i, e.clientY - rect.top - 8))
    },
    onPointerLeave: () => setHover(null),
    onFocus: () => setHover((cur) => cur || at(count - 1, CHART_MARGIN.t + 8)),
    onBlur: () => setHover(null),
    onKeyDown: (e) => {
      if (count === 0) return
      if (e.key === 'Escape') { setHover(null); return }
      const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (!dir) return
      e.preventDefault()
      setHover((cur) => at(Math.min(count - 1, Math.max(0, (cur ? cur.i : count) + dir)), cur ? cur.y : CHART_MARGIN.t + 8))
    },
  }
  return [hover, handlers]
}

/**
 * Stacked (or single-series) columns. rows = [{ key, values, total }], series = [{ key, label, color }].
 * Columns are capped at 24px with a 2px surface gap between stacked segments.
 */
function StackedColumns(props) {
  const { rows, series, height = 220, format, axisFormat, xLabel, tipTitle } = props
  const [width, ref] = useWidth()
  const M = CHART_MARGIN
  const plotW = Math.max(0, width - M.l - M.r)
  const plotH = height - M.t - M.b
  const n = rows.length
  const slot = n > 0 ? plotW / n : 0
  const barW = Math.min(24, Math.max(1.5, slot - 2))
  const { max, ticks } = niceTicks(Math.max(0, ...rows.map((r) => r.total)))
  const step = labelEvery(n, plotW)
  const yOf = (v) => M.t + plotH - (v / max) * plotH
  const [hover, handlers] = useSlotHover(n, M.l, slot)

  const columns = rows.map((row, i) => {
    const x = M.l + i * slot + (slot - barW) / 2
    const last = row.values.reduce((acc, v, s) => (v > 0 ? s : acc), -1)
    let cum = 0
    let below = false
    const marks = []
    row.values.forEach((v, s) => {
      if (!(v > 0)) return
      const top = yOf(cum + v)
      const full = (v / max) * plotH
      const drawn = below ? full - 2 : full
      cum += v
      below = true
      if (drawn < 0.5) return
      const fill = series[s].color
      if (s === last) marks.push(h('path', { key: s, d: roundedTop(x, top, barW, drawn, 4), fill }))
      else marks.push(h('rect', { key: s, x, y: top, width: barW, height: drawn, fill }))
    })
    return h('g', { key: row.key }, marks)
  })

  const tipRows = (row) => {
    const parts = series.map((s, idx) => ({ color: s.color, name: s.label, value: row.values[idx] }))
      .filter((p) => p.value > 0).reverse()
      .map((p) => ({ color: p.color, name: p.name, value: format(p.value) }))
    if (parts.length === 0) return [{ name: t('noData'), value: '' }]
    if (series.length > 1) parts.push({ name: t('tableTotal'), value: format(row.total) })
    return parts
  }

  return h('div', Object.assign({ ref, role: 'img', 'aria-label': props.label, style: { position: 'relative', width: '100%', height, outline: 'none' } }, handlers),
    width > 0 ? h('svg', { width, height, style: { display: 'block' }, 'aria-hidden': true },
      ticks.map((tick) => h('g', { key: tick },
        h('line', { x1: M.l, x2: width - M.r, y1: yOf(tick), y2: yOf(tick), stroke: tick === 0 ? AXIS : GRID, strokeWidth: 1 }),
        h('text', { x: M.l - 6, y: yOf(tick) + 4, textAnchor: 'end', style: { fontSize: 11, fill: TERTIARY } }, axisFormat(tick)))),
      hover ? h('rect', { x: M.l + hover.i * slot, y: M.t, width: slot, height: plotH, fill: WASH }) : null,
      columns,
      rows.map((row, i) => ((props.labelFromStart ? i % step === 0 : (n - 1 - i) % step === 0)
        ? h('text', { key: row.key, x: M.l + (i + 0.5) * slot, y: height - 8, textAnchor: 'middle', style: { fontSize: 11, fill: TERTIARY } }, xLabel(row.key))
        : null))) : null,
    hover && rows[hover.i] ? h(Tip, { x: hover.x, y: hover.y, width, title: tipTitle(rows[hover.i]), rows: tipRows(rows[hover.i]) }) : null)
}

/** One line on a fixed 0–100% axis; gaps (null) break the line. points = [{ key, value }]. */
function RateLine(props) {
  const { points, height = 200, color, name, tipTitle, xLabel } = props
  const [width, ref] = useWidth()
  const M = CHART_MARGIN
  const plotW = Math.max(0, width - M.l - M.r)
  const plotH = height - M.t - M.b
  const n = points.length
  const slot = n > 0 ? plotW / n : 0
  const step = labelEvery(n, plotW)
  const xOf = (i) => M.l + (i + 0.5) * slot
  const yOf = (v) => M.t + plotH - v * plotH
  const [hover, handlers] = useSlotHover(n, M.l, slot)

  // Contiguous runs of non-null points: each becomes a line plus a 10% area wash.
  const runs = []
  points.forEach((p, i) => {
    if (p.value === null) { runs.push(null); return }
    if (runs.length === 0 || runs[runs.length - 1] === null) runs.push([])
    runs[runs.length - 1].push(i)
  })
  const lastIndex = points.reduce((acc, p, i) => (p.value === null ? acc : i), -1)
  const pct = (v) => (v * 100).toFixed(v >= 0.995 ? 0 : 1) + '%'

  return h('div', Object.assign({ ref, role: 'img', 'aria-label': props.label, style: { position: 'relative', width: '100%', height, outline: 'none' } }, handlers),
    width > 0 ? h('svg', { width, height, style: { display: 'block' }, 'aria-hidden': true },
      [0, 0.25, 0.5, 0.75, 1].map((tick) => h('g', { key: tick },
        h('line', { x1: M.l, x2: width - M.r, y1: yOf(tick), y2: yOf(tick), stroke: tick === 0 ? AXIS : GRID, strokeWidth: 1 }),
        h('text', { x: M.l - 6, y: yOf(tick) + 4, textAnchor: 'end', style: { fontSize: 11, fill: TERTIARY } }, Math.round(tick * 100) + '%'))),
      runs.filter(Boolean).map((run, k) => {
        const line = run.map((i, j) => (j === 0 ? 'M' : 'L') + xOf(i) + ',' + yOf(points[i].value)).join('')
        const area = line + 'L' + xOf(run[run.length - 1]) + ',' + yOf(0) + 'L' + xOf(run[0]) + ',' + yOf(0) + 'Z'
        // A run of one point has no line to draw: show it as a dot.
        if (run.length === 1) return h('circle', { key: k, cx: xOf(run[0]), cy: yOf(points[run[0]].value), r: 3, fill: color })
        return h('g', { key: k },
          h('path', { d: area, fill: color, opacity: 0.1 }),
          h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      }),
      hover ? h('line', { x1: xOf(hover.i), x2: xOf(hover.i), y1: M.t, y2: M.t + plotH, stroke: AXIS, strokeWidth: 1 }) : null,
      lastIndex >= 0 ? h('circle', { cx: xOf(lastIndex), cy: yOf(points[lastIndex].value), r: 4, fill: color, stroke: PLATFORM, strokeWidth: 2 }) : null,
      hover && points[hover.i] && points[hover.i].value !== null
        ? h('circle', { cx: xOf(hover.i), cy: yOf(points[hover.i].value), r: 4, fill: color, stroke: PLATFORM, strokeWidth: 2 }) : null,
      points.map((p, i) => ((n - 1 - i) % step === 0
        ? h('text', { key: p.key, x: xOf(i), y: height - 8, textAnchor: 'middle', style: { fontSize: 11, fill: TERTIARY } }, xLabel(p.key))
        : null))) : null,
    hover && points[hover.i] ? h(Tip, {
      x: hover.x, y: hover.y, width, title: tipTitle(points[hover.i]),
      rows: [{ color, name, value: points[hover.i].value === null ? '—' : pct(points[hover.i].value) }],
    }) : null)
}

/**
 * Lines that share one value axis (all series use the same unit). series = [{ key, label, color }],
 * points = [{ key, values: [number | null, …] }] parallel to series; null breaks a line.
 */
function LineChart(props) {
  const { points, series, height = 200, format, axisFormat, tipTitle, xLabel } = props
  const [width, ref] = useWidth()
  const M = CHART_MARGIN
  const plotW = Math.max(0, width - M.l - M.r)
  const plotH = height - M.t - M.b
  const n = points.length
  const slot = n > 0 ? plotW / n : 0
  const step = labelEvery(n, plotW)
  const { max, ticks } = niceTicks(Math.max(0, ...points.map((p) => Math.max(0, ...p.values.map((v) => v || 0)))))
  const xOf = (i) => M.l + (i + 0.5) * slot
  const yOf = (v) => M.t + plotH - (v / max) * plotH
  const [hover, handlers] = useSlotHover(n, M.l, slot)

  const drawSeries = (s, si) => {
    const runs = []
    points.forEach((p, i) => {
      if (p.values[si] === null || p.values[si] === undefined) { runs.push(null); return }
      if (runs.length === 0 || runs[runs.length - 1] === null) runs.push([])
      runs[runs.length - 1].push(i)
    })
    const lastIndex = points.reduce((acc, p, i) => (p.values[si] === null || p.values[si] === undefined ? acc : i), -1)
    return h('g', { key: s.key },
      runs.filter(Boolean).map((run, k) => {
        if (run.length === 1) return h('circle', { key: k, cx: xOf(run[0]), cy: yOf(points[run[0]].values[si]), r: 3, fill: s.color })
        const d = run.map((i, j) => (j === 0 ? 'M' : 'L') + xOf(i) + ',' + yOf(points[i].values[si])).join('')
        return h('path', { key: k, d, fill: 'none', stroke: s.color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' })
      }),
      lastIndex >= 0 ? h('circle', { cx: xOf(lastIndex), cy: yOf(points[lastIndex].values[si]), r: 4, fill: s.color, stroke: PLATFORM, strokeWidth: 2 }) : null,
      hover && points[hover.i] && points[hover.i].values[si] !== null && points[hover.i].values[si] !== undefined
        ? h('circle', { cx: xOf(hover.i), cy: yOf(points[hover.i].values[si]), r: 4, fill: s.color, stroke: PLATFORM, strokeWidth: 2 }) : null)
  }

  return h('div', Object.assign({ ref, role: 'img', 'aria-label': props.label, style: { position: 'relative', width: '100%', height, outline: 'none' } }, handlers),
    width > 0 ? h('svg', { width, height, style: { display: 'block' }, 'aria-hidden': true },
      ticks.map((tick) => h('g', { key: tick },
        h('line', { x1: M.l, x2: width - M.r, y1: yOf(tick), y2: yOf(tick), stroke: tick === 0 ? AXIS : GRID, strokeWidth: 1 }),
        h('text', { x: M.l - 6, y: yOf(tick) + 4, textAnchor: 'end', style: { fontSize: 11, fill: TERTIARY } }, axisFormat(tick)))),
      hover ? h('line', { x1: xOf(hover.i), x2: xOf(hover.i), y1: M.t, y2: M.t + plotH, stroke: AXIS, strokeWidth: 1 }) : null,
      series.map(drawSeries),
      points.map((p, i) => ((n - 1 - i) % step === 0
        ? h('text', { key: p.key, x: xOf(i), y: height - 8, textAnchor: 'middle', style: { fontSize: 11, fill: TERTIARY } }, xLabel(p.key))
        : null))) : null,
    hover && points[hover.i] ? h(Tip, {
      x: hover.x, y: hover.y, width, title: tipTitle(points[hover.i]),
      rows: series.map((s, si) => ({ color: s.color, name: s.label, value: points[hover.i].values[si] === null || points[hover.i].values[si] === undefined ? '—' : format(points[hover.i].values[si]) })),
    }) : null)
}

/** Horizontal bars for one measure; bars are ≤ 24px thick, the value sits at the bar tip. A row may carry its own colour. */
function HBars(props) {
  const [hot, setHot] = React.useState(null)
  const max = Math.max(0, ...props.rows.map((r) => r.value))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, props.rows.map((row) => h('div', {
    key: row.key,
    title: row.title,
    onPointerEnter: () => setHot(row.key),
    onPointerLeave: () => setHot(null),
    style: { display: 'grid', gridTemplateColumns: 'minmax(90px, 200px) minmax(0, 1fr)', gap: 12, alignItems: 'center', opacity: hot === null || hot === row.key ? 1 : 0.55 },
  },
    h('div', { style: { minWidth: 0 } },
      h('div', { style: { fontSize: 13, color: PRIMARY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.name),
      row.sub ? h('div', { style: { fontSize: 11, color: TERTIARY, lineHeight: '15px' } }, row.sub) : null),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
      h('div', { style: { width: 'calc((100% - 84px) * ' + (max > 0 ? row.value / max : 0) + ')', minWidth: row.value > 0 ? 2 : 0, height: 14, borderRadius: '0 4px 4px 0', background: row.color || props.color, flex: '0 0 auto' } }),
      h('span', { style: { fontSize: 12, color: PRIMARY, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, row.valueText)))))
}

/** Proportional stacked bar (flex) used for per-session token mix. values/colors are parallel arrays. */
function MixBar(props) {
  const total = props.values.reduce((a, b) => a + b, 0)
  return h('div', { title: props.title, style: { display: 'flex', gap: 2, height: 8, width: '100%', minWidth: 60 } },
    total > 0 ? props.values.map((v, i) => (v > 0 ? h('div', { key: i, style: { flex: v + ' 1 0', minWidth: 2, background: props.colors[i], borderRadius: 2 } }) : null))
      : h('div', { style: { flex: 1, background: FILL, borderRadius: 2 } }))
}

/** Weekday × hour heat map: 7 rows of 24 cells on the sequential ramp, with hover readout and scale legend. */
function Heatmap(props) {
  const { grid, metric, ramp, format, weekdayLabel } = props
  const [width, ref] = useWidth()
  const [hot, setHot] = React.useState(null)
  const max = Math.max(0, ...grid.map((row) => Math.max(...row.map((cell) => cell[metric]))))
  const colorOf = (value) => {
    if (!(value > 0) || max <= 0) return FILL
    return ramp[Math.min(ramp.length - 1, Math.floor((value / max) * ramp.length - 1e-9))]
  }
  const move = (e, wd, hr) => {
    const box = ref.current.getBoundingClientRect()
    setHot({ wd, hr, x: e.clientX - box.left, y: e.clientY - box.top - 8 })
  }
  const LABEL_W = 34
  return h('div', { ref, style: { position: 'relative', width: '100%' } },
    h('div', { style: { display: 'grid', gridTemplateColumns: LABEL_W + 'px repeat(24, minmax(0, 1fr))', gap: 2, alignItems: 'center' } },
      h('span', null),
      Array.from({ length: 24 }, (_, hr) => h('span', { key: 'h' + hr, style: { fontSize: 10, color: TERTIARY, textAlign: 'center', visibility: hr % 3 === 0 ? 'visible' : 'hidden' } }, hr)),
      grid.map((row, wd) => [
        h('span', { key: 'l' + wd, style: { fontSize: 11, color: TERTIARY } }, weekdayLabel(wd)),
        row.map((cell, hr) => h('div', {
          key: wd + '-' + hr,
          onPointerMove: (e) => move(e, wd, hr),
          onPointerLeave: () => setHot(null),
          style: { height: 22, borderRadius: 3, background: colorOf(cell[metric]), outline: hot && hot.wd === wd && hot.hr === hr ? '1.5px solid ' + PRIMARY : 'none', outlineOffset: -1 },
        })),
      ])),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', paddingTop: 10, fontSize: 11, color: TERTIARY } },
      h('span', null, t('heatLess')),
      h('div', { style: { display: 'flex', gap: 2 } }, ramp.map((color, i) => h('span', { key: i, style: { width: 14, height: 8, borderRadius: 2, background: color } }))),
      h('span', null, t('heatMore'))),
    hot && width > 0 ? h(Tip, {
      x: hot.x, y: hot.y, width,
      title: weekdayLabel(hot.wd) + ' ' + String(hot.hr).padStart(2, '0') + ':00',
      rows: [{ name: t(metric === 'calls' ? 'metricCalls' : 'metricTokens'), value: format(grid[hot.wd][hot.hr][metric]) }],
    }) : null)
}

/** Table twin of a chart: head = [strings], rows = [[cells]]; the first column is left-aligned text unless `left` lists other text columns. */
function DataTable(props) {
  const alignOf = (i) => (i === 0 || (props.left && props.left.indexOf(i) >= 0) ? 'left' : 'right')
  const cell = { padding: '6px 8px', fontSize: 12, whiteSpace: 'nowrap', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderBottom: BORDER }
  return h('div', { style: { overflow: 'auto', maxHeight: 340 } },
    h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
      h('thead', null, h('tr', null, props.head.map((text, i) => h('th', {
        key: i,
        style: Object.assign({}, cell, { color: TERTIARY, fontWeight: 400, textAlign: alignOf(i), position: 'sticky', top: 0, background: PLATFORM }),
      }, text)))),
      h('tbody', null, props.rows.map((row, r) => h('tr', { key: r }, row.map((text, i) => h('td', {
        key: i,
        style: Object.assign({}, cell, { color: i === 0 ? PRIMARY : SECONDARY, textAlign: alignOf(i) }),
      }, text)))))))
}

/** A titled card with an optional legend and a chart ⇄ table switch. `table` = { head, rows }. */
function ChartCard(props) {
  const [view, setView] = React.useState('chart')
  return h('section', { style: { border: BORDER, borderRadius: 16, padding: '16px 18px 14px', minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 } },
      h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
        h('div', { style: { fontSize: 14, fontWeight: 600, color: PRIMARY } }, props.title),
        props.sub ? h('div', { style: { fontSize: 12, color: TERTIARY, marginTop: 2 } }, props.sub) : null),
      props.extra || null,
      props.table ? segmented(view, [{ value: 'chart', label: t('viewChart') }, { value: 'table', label: t('viewTable') }], setView, props.title, true) : null),
    view === 'table' && props.table ? h(DataTable, props.table) : [props.legend ? h(Legend, { key: 'legend', items: props.legend }) : null, h(React.Fragment, { key: 'body' }, ...React.Children.toArray(props.children))])
}
