const SYMBOLS = { CNY: '¥', JPY: '¥', USD: '$', HKD: 'HK$', EUR: '€', GBP: '£' }

function formatMoney(currency, amount) {
  const value = amount > 0 && amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)
  const symbol = SYMBOLS[currency]
  return symbol ? symbol + value : value + ' ' + currency
}

/** costs: { CNY: 1.2, USD: 0.5 } → "¥1.20 · $0.50"；没有正数费用返回 null。 */
function formatCosts(costs) {
  const parts = Object.keys(costs || {})
    .filter((cur) => costs[cur] > 0)
    .map((cur) => formatMoney(cur, costs[cur]))
  return parts.length > 0 ? parts.join(' · ') : null
}

/** A per-million rate without rounding noise: 0.075 stays 0.075, 4 stays 4. */
function formatRate(currency, value) {
  const symbol = SYMBOLS[currency] || ''
  return symbol + String(Number((Number(value) || 0).toFixed(4)))
}

/** Tier threshold in tokens → "100K" / "1M". */
function formatK(tokens) {
  const n = Number(tokens) || 0
  if (n >= 1e6 && n % 1e6 === 0) return (n / 1e6) + 'M'
  return String(Number((n / 1e3).toFixed(1))) + 'K'
}

/** token 数的紧凑写法，带 tok 单位：如 `850tok`、`12.3K tok`、`485K tok`、`1.05M tok`。 */
function formatTok(total) {
  const n = Number(total) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M tok'
  if (n >= 1e5) return (n / 1e3).toFixed(0) + 'K tok'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K tok'
  return String(n) + 'tok'
}

/** Effective tier rates: a blank (0) field in the tier falls back to the base price, as the Host bills it. */
function tierRates(price, tier) {
  const rates = { currency: price.currency }
  for (const field of PRICE_FIELDS) rates[field] = tier[field] > 0 ? tier[field] : (price[field] || 0)
  return rates
}

/** 红绿灯颜色：费用占预算比例 <70% 绿，70–100% 黄，≥100% 红；无预算为灰。 */
function lightFor(spent, budget) {
  if (!budget || !(budget.amount > 0)) return { color: LIGHT.grey, pct: null }
  const pct = (spent / budget.amount) * 100
  const color = pct >= 100 ? LIGHT.red : pct >= 70 ? LIGHT.yellow : LIGHT.green
  return { color, pct }
}

/**
 * Cache hit rate = cache read ÷ whole prompt (uncached input + cache read + cache write). Providers that bill cache
 * writes separately (Anthropic) report the written part outside the uncached input, so leaving it out of the
 * denominator would show ~100% for a conversation that mostly writes new cache.
 */
function hitRateValue(inputTokens, cacheReadTokens, cacheWriteTokens) {
  const denom = (Number(inputTokens) || 0) + (Number(cacheReadTokens) || 0) + (Number(cacheWriteTokens) || 0)
  if (denom <= 0) return null
  return (Number(cacheReadTokens) || 0) / denom
}

function formatHitRate(inputTokens, cacheReadTokens, cacheWriteTokens) {
  const rate = hitRateValue(inputTokens, cacheReadTokens, cacheWriteTokens)
  if (rate === null) return '—'
  return (rate * 100).toFixed(rate >= 0.995 ? 0 : 1) + '%'
}

/** 命中率高是好事：≥80% 绿、≥50% 常规、更低调灰。 */
function hitRateColor(inputTokens, cacheReadTokens, cacheWriteTokens) {
  const rate = hitRateValue(inputTokens, cacheReadTokens, cacheWriteTokens)
  if (rate === null) return TERTIARY
  if (rate >= 0.8) return LIGHT.green
  if (rate >= 0.5) return SECONDARY
  return TERTIARY
}

/** 一个 costs 对象里所有货币金额的粗略合计，仅用于排序。 */
function costValue(costs) {
  let sum = 0
  for (const cur of Object.keys(costs || {})) sum += Number(costs[cur]) || 0
  return sum
}

/** "USD 0.1/0.5 R0.01 W0.125"; an empty currency is skipped (used for tier lines). */
function rateLine(price) {
  if (!price) return t('sourceNone')
  return [price.currency || '', (price.input ?? 0) + '/' + (price.output ?? 0),
    'R' + (price.cacheRead ?? 0), 'W' + (price.cacheWrite ?? 0)].filter(Boolean).join(' ')
}
