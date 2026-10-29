// Four-row table of one model's usage: input / output / cache read / cache write, each with its token count and its
// price per million tokens. Used by the right-sidebar model rows and the turn hover card; each column has its own switch.

const usageCell = { fontSize: 11, lineHeight: '16px', color: TERTIARY, fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' }

/**
 * `tokens` = { input, output, cacheRead, cacheWrite } (input = uncached input); `price` = the model's base price or null.
 * Renders nothing when both columns are off. With no price the price column is dropped even when it is switched on.
 */
function UsageTable(props) {
  const { tokens, price, showTokens, showRates } = props
  const rates = showRates && price
  if (!showTokens && !rates) return null
  const rows = [
    ['usageInUncached', tokens.input, price && price.input],
    ['rOut', tokens.output, price && price.output],
    ['rCacheRead', tokens.cacheRead, price && price.cacheRead],
    ['rCacheWrite', tokens.cacheWrite, price && price.cacheWrite],
  ]
  const cols = '1fr' + (showTokens ? ' auto' : '') + (rates ? ' auto' : '')
  const head = (text) => h('div', { style: Object.assign({}, usageCell, { fontSize: 10 }) }, text)
  const cell = (text, key) => h('div', { key, style: usageCell }, text)
  return h('div', { style: { display: 'grid', gridTemplateColumns: cols, columnGap: 14, rowGap: 1, alignItems: 'baseline' } },
    h('div', null),
    showTokens ? head(t('usageColTokens')) : null,
    rates ? head(t('usageColPrice', { cur: price.currency || '' })) : null,
    rows.map(([label, count, rate]) => [
      h('div', { key: label, style: Object.assign({}, usageCell, { textAlign: 'left' }) }, t(label)),
      showTokens ? cell(count > 0 ? formatTok(count) : '—', label + 't') : null,
      rates ? cell(String(rate ?? 0), label + 'p') : null,
    ]))
}
