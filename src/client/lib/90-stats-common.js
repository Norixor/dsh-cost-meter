// Shared building blocks of the statistics tabs (91–96), built on the aggregations in 85–87.

const plainMoney = (v) => (Number(v) || 0).toFixed(v > 0 && v < 0.01 ? 4 : 2)
const pctText = (v) => (v === null || v === undefined ? '—' : (v * 100).toFixed(v >= 0.995 ? 0 : 1) + '%')
/** Quantity of a metered image / speech model ("12 images", "3.4K chars"); null for ordinary token-billed models. */
const unitsText = (row) => {
  if (!row.media || !(row.units > 0)) return null
  const n = row.units >= 100 ? String(Math.round(row.units)) : String(Number(row.units.toFixed(row.units >= 10 ? 1 : 2)))
  return t({ image: 'unitImage', speech: 'unitSpeech', transcribe: 'unitMinute' }[row.media], { n })
}
/** Token count, or the metered quantity for models billed per image / character / minute. */
const volumeText = (row, tokenFormat) => unitsText(row) || tokenFormat(row.tokens)
const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))', gap: 16 }
const kpiGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 12 }
const stackGap = { display: 'flex', flexDirection: 'column', gap: 16 }

/** Token kinds in the order used by every token chart; colour slots 0–3 stay fixed per kind. */
const tokenKinds = () => [
  { key: 'in', label: t('rIn'), slot: 0 },
  { key: 'out', label: t('rOut'), slot: 1 },
  { key: 'cacheRead', label: t('rCacheRead'), slot: 2 },
  { key: 'cacheWrite', label: t('rCacheWrite'), slot: 3 },
]

/** A model keeps the colour slot of its all-time cost rank; models beyond the palette share the "other" grey. */
const modelColor = (viz, order, model) => {
  const at = order.indexOf(model)
  return slotColor(viz, at >= 0 && at < viz.series.length ? at : null)
}

const emptyNote = () => h('div', { style: { padding: '28px 0', textAlign: 'center', fontSize: 13, color: TERTIARY } }, t('noData'))

/** A small labelled fact (value + caption), used for the usage-time insights. */
const fact = (label, value) => h('div', { key: label, style: { padding: '10px 14px', borderRadius: 12, background: FILL, minWidth: 0 } },
  h('div', { style: { fontSize: 12, color: TERTIARY } }, label),
  h('div', { style: { fontSize: 15, color: PRIMARY, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, value))

/** Headline number with a caption; the value uses proportional figures (no tabular-nums at this size). */
const kpiTile = (label, value, sub) => h('div', { key: label, style: { padding: '14px 18px', borderRadius: 16, border: BORDER, minWidth: 0 } },
  h('div', { style: { fontSize: 12, color: TERTIARY } }, label),
  h('div', { style: { fontSize: 24, fontWeight: 600, color: PRIMARY, marginTop: 4, lineHeight: '30px', wordBreak: 'break-word' } }, value),
  sub ? h('div', { style: { fontSize: 12, color: TERTIARY, marginTop: 2 } }, sub) : null)

/** The one-sentence takeaway that opens every tab. */
const conclusion = (text) => h('div', { style: { padding: '14px 18px', borderRadius: 16, background: FILL, fontSize: 14, lineHeight: '22px', color: PRIMARY } }, text)

/** Placeholders of an insight sentence, formatted for display (ratios → %, milliseconds → durations). */
const insightText = (item) => {
  const params = Object.assign({}, item.params)
  if (params.pct !== undefined) params.pct = pctText(params.pct)
  if (params.ms !== undefined) params.ms = formatDuration(params.ms)
  return t('ins_' + item.id, params)
}

/** Rule-based observations. Warnings carry "!" and notes "i" so the level never relies on colour alone. */
function Insights(props) {
  const items = props.items
  return h('section', { style: { border: BORDER, borderRadius: 16, padding: '16px 18px 8px' } },
    h('div', { style: { fontSize: 14, fontWeight: 600, color: PRIMARY, marginBottom: 6 } }, t('insightsTitle')),
    items.length === 0 ? h('div', { style: { fontSize: 13, color: TERTIARY, padding: '6px 0 10px' } }, t('insightsNone'))
      : items.map((item) => h('div', { key: item.id, style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 0', borderTop: BORDER } },
        h('span', {
          role: 'img', 'aria-label': t(item.level === 'warn' ? 'insWarn' : 'insNote'),
          style: { flex: '0 0 auto', width: 18, height: 18, borderRadius: '50%', marginTop: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: PLATFORM, background: item.level === 'warn' ? LIGHT.yellow : LIGHT.grey },
        }, item.level === 'warn' ? '!' : 'i'),
        h('span', { style: { fontSize: 13, lineHeight: '20px', color: PRIMARY, minWidth: 0 } }, insightText(item)))))
}
