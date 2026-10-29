// Four-row table of one model's usage: input / output / cache read / cache write, each with its token count, its price
// per million tokens and what it cost. Used by the right-sidebar model rows and the turn hover card; each column has
// its own switch.

const usageCell = { fontSize: 11, lineHeight: '16px', color: TERTIARY, fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' }

/** Cost text of item `i` out of itemCostsOf(): "≈ " marks an estimate, '' means nothing was spent on it. `convert` maps into the display currency. */
function itemCostText(itemCosts, i, convert) {
  if (!itemCosts) return ''
  const text = formatCosts(convert ? convert(itemCosts.items[i]) : itemCosts.items[i])
  return text ? (itemCosts.estimated ? '≈' : '') + text : ''
}

/**
 * `tokens` = { input, output, cacheRead, cacheWrite } (input = uncached input); `price` = the model's base price or null;
 * `itemCosts` = itemCostsOf() of the model or null. Renders nothing when every column is off. A column whose data is
 * missing (no price, no cost split) is dropped even when it is switched on.
 */
function UsageTable(props) {
  const { tokens, price, itemCosts, convert, showTokens, showRates, showCosts } = props
  const rates = showRates && price
  const costs = showCosts && itemCosts
  if (!showTokens && !rates && !costs) return null
  const rows = [
    ['usageInUncached', tokens.input, price && price.input],
    ['rOut', tokens.output, price && price.output],
    ['rCacheRead', tokens.cacheRead, price && price.cacheRead],
    ['rCacheWrite', tokens.cacheWrite, price && price.cacheWrite],
  ]
  const cols = 'minmax(0, 1fr)' + (showTokens ? ' auto' : '') + (rates ? ' auto' : '') + (costs ? ' auto' : '')
  const head = (text) => h('div', { style: Object.assign({}, usageCell, { fontSize: 10 }) }, text)
  const cell = (text, key, title) => h('div', { key, style: usageCell, title }, text)
  return h('div', { style: { display: 'grid', gridTemplateColumns: cols, columnGap: 8, rowGap: 1, alignItems: 'baseline' } },
    h('div', null),
    showTokens ? head(t('usageColTokens')) : null,
    rates ? head(t('usageColPrice', { cur: price.currency || '' })) : null,
    costs ? head(t('usageColCost')) : null,
    rows.map(([label, count, rate], i) => [
      h('div', { key: label, style: Object.assign({}, usageCell, { textAlign: 'left', whiteSpace: 'normal' }) }, t(label)),
      showTokens ? cell(count > 0 ? formatTok(count) : '—', label + 't') : null,
      rates ? cell(String(rate ?? 0), label + 'p') : null,
      costs ? cell(itemCostText(itemCosts, i, convert) || '—', label + 'c', itemCosts.estimated ? t('usageEstimated') : undefined) : null,
    ]))
}
