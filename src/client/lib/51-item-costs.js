// Cost of one model's input / output / cache read / cache write. Inlined into client.js and imported by tests.
//
// The Host books the exact split (pricing.js `parts`) next to each counter's `costs` and on every logged call. Anything
// booked before that existed has no split, or only a partial one, so an exact split is trusted only when it adds up to the
// recorded cost; otherwise the split is estimated from the tokens at the model's base price and flagged as an estimate
// (peak / tier rates and prices changed since then are not known).

const ITEM_COUNT = 4

/** True when `parts` ({ CUR: [in, out, cacheRead, cacheWrite] }) accounts for every currency of `costs` ({ CUR: amount }). */
export function partsComplete(parts, costs) {
  const currencies = Object.keys(costs || {}).filter((cur) => Number(costs[cur]) > 0)
  if (!parts || typeof parts !== 'object' || currencies.length === 0) return false
  return currencies.every((cur) => {
    const row = parts[cur]
    if (!Array.isArray(row) || row.length !== ITEM_COUNT) return false
    const sum = row.reduce((a, b) => a + (Number(b) || 0), 0)
    return Math.abs(sum - costs[cur]) <= 1e-9 + 1e-6 * Math.abs(costs[cur])
  })
}

/**
 * Four cost objects ({ CUR: amount }, input / output / cache read / cache write) plus whether they are an estimate,
 * or null when nothing can be said (no exact split and no price). `tokens` = { input, output, cacheRead, cacheWrite }.
 */
export function itemCostsOf(parts, costs, tokens, price) {
  if (partsComplete(parts, costs)) {
    const items = [0, 1, 2, 3].map((i) => {
      const one = {}
      for (const cur of Object.keys(parts)) if (parts[cur][i] > 0) one[cur] = parts[cur][i]
      return one
    })
    return { items, estimated: false }
  }
  if (!price) return null
  const cur = price.currency || 'USD'
  const rates = [price.input, price.output, price.cacheRead, price.cacheWrite]
  const counts = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite]
  const items = counts.map((n, i) => {
    const amount = (Number(n) || 0) * (Number(rates[i]) || 0) / 1_000_000
    return amount > 0 ? { [cur]: amount } : {}
  })
  return { items, estimated: true }
}
