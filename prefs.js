/**
 * Display preferences kept by the Host so every browser window renders the same layout.
 *
 * The browser half only reads and renders them; this module is the single place that
 * decides which keys and values are legal. Unknown keys are dropped and illegal values
 * fall back to the current value, so a hand-edited state file can never break the UI.
 */
export const DOCK_STYLES = ['plain', 'soft', 'outline', 'bar']
export const DOCK_FONTS = ['system', 'mono']
export const DOCK_SIZES = ['sm', 'md', 'lg']
export const STATS_RANGES = [7, 30, 90]
export const MSG_STYLES = ['plain', 'soft', 'outline']
/** How money is shown everywhere (dock strip, message labels, sidebar pages): converted to one currency, or as billed. */
export const STATS_CURRENCIES = ['CNY', 'USD', 'original']
/** Exchange rate (CNY per 1 USD): rough default, editable; only used for display, never stored on calls. */
export const USD_CNY_DEFAULT = 6.8
const USD_CNY_RANGE = [0.01, 1000]

export const DEFAULT_PREFS = Object.freeze({
  // Show the entry in the left sidebar (the full statistics page).
  sidebar: true,
  // The strip under the composer and what it contains.
  dock: true,
  dockStyle: 'plain',
  dockFont: 'system',
  dockSize: 'md',
  dockTokens: true,
  dockLight: true,
  dockModels: true,
  // Peak / off-peak status (from the models' peak windows): in the strip and on the right-sidebar page.
  dockPeak: true,
  sidePeak: true,
  // Strip: icon + Peak / Off-peak by default; the countdown is opt-in. Right-sidebar page: state and hours; the rest (weekdays, ratio, models, billing rule) is opt-in.
  peakCountdown: false,
  sidePeakDetail: false,
  // Cache read / write token counts (right-sidebar model rows, turn hover card) and each model's price line (right-sidebar model rows).
  cacheTokens: true,
  sideRates: true,
  // Default time range of the statistics page, in days.
  statsRange: 30,
  // Statistics page refreshes itself while it is open; off = only the refresh button updates it.
  statsAuto: true,
  // Experimental: meter image / speech tool calls through user-defined rules (off until switched on).
  mediaMeter: false,
  // Cost label in the action row under each assistant message, and the summary line above it.
  msgChip: true,
  msgLine: true,
  msgStyle: 'plain',
  msgFont: 'system',
  // Display currency (named for the statistics page it began on): CNY / USD convert every cost with `usdCny`; 'original' shows costs as billed.
  statsCurrency: 'CNY',
  usdCny: USD_CNY_DEFAULT,
  // Opt-in daily refresh of the OpenRouter price catalog. With balanceAuto below, the only things that contact the network without a click.
  catalogAuto: false,
  // Account balances (balance.js): shown on the right-sidebar page when any account exists; the timer is opt-in and only asks providers you added.
  sideBalance: true,
  balanceAuto: false,
})

const ENUMS = {
  dockStyle: DOCK_STYLES,
  dockFont: DOCK_FONTS,
  dockSize: DOCK_SIZES,
  statsRange: STATS_RANGES,
  msgStyle: MSG_STYLES,
  msgFont: DOCK_FONTS,
  statsCurrency: STATS_CURRENCIES,
}

/** Merge `input` over `base`, keeping only known keys with legal values. */
export function sanitizePrefs(input, base = DEFAULT_PREFS) {
  const source = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of Object.keys(DEFAULT_PREFS)) {
    const value = source[key]
    const fallback = base[key] !== undefined ? base[key] : DEFAULT_PREFS[key]
    if (typeof DEFAULT_PREFS[key] === 'boolean') out[key] = typeof value === 'boolean' ? value : fallback
    else if (key === 'usdCny') out[key] = Number.isFinite(value) && value >= USD_CNY_RANGE[0] && value <= USD_CNY_RANGE[1] ? value : fallback
    else out[key] = ENUMS[key].includes(value) ? value : fallback
  }
  return out
}
