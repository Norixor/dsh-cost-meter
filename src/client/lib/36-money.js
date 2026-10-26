// The display currency every surface shares (dock strip, message labels, right-sidebar page, statistics page).
// Costs are stored per billing currency; this only decides how they are shown. The pref is still named `statsCurrency`
// because it began as the statistics page's switch.

/**
 * `convert(costs)` maps billed money into the chosen currency (amounts already in it are kept; currencies without a rate
 * stay as billed), `one(currency, amount)` prints a single amount that way and `note(costs)` is the footnote for the
 * currencies that were folded, or null when nothing was.
 */
function moneyView(prefs) {
  const mode = prefs.statsCurrency
  const rate = prefs.usdCny
  const converted = mode !== 'original'
  const convert = converted ? (costs) => convertCosts(costs, mode, rate) : (costs) => costs || {}
  return {
    mode,
    rate,
    converted,
    convert,
    folded: (costs) => (converted ? convertedFrom(costs, mode, rate) : []),
    one: (currency, amount) => {
      const shown = convert({ [currency]: amount })
      const cur = Object.keys(shown)[0]
      return formatMoney(cur, shown[cur])
    },
    note: (costs) => {
      const from = converted ? convertedFrom(costs, mode, rate) : []
      return from.length > 0 ? fxNoteText(from, rate) : null
    },
  }
}

/** "CNY / USD converted at 1 USD = 6.8 CNY". */
const fxNoteText = (from, rate) => t('fxNote', { from: from.join(' / '), rate: String(Number(rate.toFixed(4))) })
