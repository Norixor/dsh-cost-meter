// Mirrors DEFAULT_PREFS / the enums in prefs.js; the Host validates, this only supplies defaults and renders.
const DEFAULT_PREFS = {
  sidebar: true,
  dock: true,
  dockStyle: 'plain',
  dockFont: 'system',
  dockSize: 'md',
  dockTokens: true,
  dockLight: true,
  dockModels: true,
  dockPeak: true,
  sidePeak: true,
  peakCountdown: false,
  sidePeakDetail: false,
  statsRange: 30,
  statsAuto: true,
  mediaMeter: false,
  msgChip: true,
  msgLine: true,
  msgStyle: 'plain',
  msgFont: 'system',
  statsCurrency: 'CNY',
  usdCny: 6.8,
  catalogAuto: false,
  sideBalance: true,
  balanceAuto: false,
}
const DOCK_STYLES = ['plain', 'soft', 'outline', 'bar']
const DOCK_FONTS = ['system', 'mono']
const DOCK_SIZES = ['sm', 'md', 'lg']
const STATS_RANGES = [7, 30, 90]
const MSG_STYLES = ['plain', 'soft', 'outline']
const STATS_CURRENCIES = ['CNY', 'USD', 'original']

const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
// Font size relative to the app's secondary text size; "md" is the long-standing default.
const DOCK_SIZE_OFFSET = { sm: -2, md: -1, lg: 0 }
const HAIRLINE = 'color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)'

/**
 * Style objects for the strip under the composer.
 * "plain" is the default: text only, no background or border, like the neighbouring system UI.
 * The other presets are opt-in from the settings page.
 */
function dockTheme(prefs) {
  const offset = DOCK_SIZE_OFFSET[prefs.dockSize] !== undefined ? DOCK_SIZE_OFFSET[prefs.dockSize] : -1
  const item = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    boxSizing: 'border-box',
    minHeight: 22,
    fontSize: offset === 0 ? 'var(--dsh-content-font-size-secondary, 13px)'
      : 'calc(var(--dsh-content-font-size-secondary, 13px) - ' + (-offset) + 'px)',
    lineHeight: '20px',
    whiteSpace: 'nowrap',
    color: TERTIARY,
    fontVariantNumeric: 'tabular-nums',
  }
  if (prefs.dockFont === 'mono') item.fontFamily = MONO_FONT
  // Wraps instead of clipping when the composer is narrow.
  const wrap = { display: 'inline-flex', flexWrap: 'wrap', gap: '2px 10px', justifyContent: 'flex-start', alignItems: 'center', padding: 0 }
  if (prefs.dockStyle === 'soft') Object.assign(item, { padding: '0 10px', borderRadius: 999, background: FILL })
  if (prefs.dockStyle === 'outline') Object.assign(item, { padding: '0 10px', borderRadius: 999, border: '0.5px solid ' + HAIRLINE })
  if (prefs.dockStyle === 'bar') Object.assign(wrap, { padding: '1px 12px', borderRadius: 10, background: FILL, gap: '2px 14px' })
  return { wrap, item }
}
