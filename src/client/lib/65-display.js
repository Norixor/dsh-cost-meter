// Sample numbers for the style previews: a healthy session with one model, priced in CNY and shown like the real strip
// (so it follows the display currency).
function previewView(prefs) {
  const cost = formatCosts(moneyView(prefs).convert({ CNY: 0.42 }))
  return {
    title: '',
    light: { color: LIGHT.green, pct: 32 },
    tokens: 48200,
    costText: cost,
    overBudget: false,
    modelsLabel: 'deepseek-chat ' + cost,
    multiModel: false,
    peak: PREVIEW_PEAK,
    unpricedText: null,
    unpricedHint: '',
  }
}

const STYLE_LABEL_KEYS = {
  plain: ['stylePlain', 'stylePlainDesc'],
  soft: ['styleSoft', 'styleSoftDesc'],
  outline: ['styleOutline', 'styleOutlineDesc'],
  bar: ['styleBar', 'styleBarDesc'],
}

/** One selectable card: a live preview of the strip in that style (using the current font, size and content). */
function stylePreviewCard(style, prefs, onPick) {
  const on = prefs.dockStyle === style
  const keys = STYLE_LABEL_KEYS[style]
  return h('button', {
    key: style,
    type: 'button',
    role: 'radio',
    'aria-checked': on,
    onClick: () => onPick(style),
    style: {
      display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 10, textAlign: 'left', padding: 14, minWidth: 0,
      borderRadius: 16, border: BORDER, background: 'transparent', color: PRIMARY, fontFamily: 'inherit', cursor: 'pointer',
      boxShadow: on ? 'inset 0 0 0 1.5px ' + PRIMARY : 'none',
    },
  },
    // The preview sits on the platform surface like the real composer area does.
    h('div', { style: { padding: '12px 10px', borderRadius: 12, background: PLATFORM, border: BORDER, overflow: 'hidden', pointerEvents: 'none' } },
      h(DockStrip, { prefs: Object.assign({}, prefs, { dockStyle: style }), view: previewView(prefs) })),
    h('div', null,
      h('div', { style: { fontSize: 14, lineHeight: '20px' } }, t(keys[0])),
      h('div', { style: ui.desc }, t(keys[1]))))
}

/** Settings → how the strip under the composer looks and what it shows. */
function DockSettings() {
  const prefs = usePrefs()
  const set = (change) => store.setPrefs(change)
  const dim = prefs.dock ? 1 : 0.45
  return h('div', null,
    settingRow({ key: 'dock' }, t('dockShow'), t('dockShowHint'), toggle(prefs.dock, (on) => set({ dock: on }), t('dockShow'))),
    h('div', { style: { opacity: dim, pointerEvents: prefs.dock ? 'auto' : 'none' } },
      h('div', { style: { padding: '18px 0', borderBottom: BORDER } },
        h('div', { style: ui.title }, t('dockStyle')),
        h('div', { style: ui.desc }, t('dockStyleHint')),
        h('div', { role: 'radiogroup', 'aria-label': t('dockStyle'), style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 14 } },
          DOCK_STYLES.map((style) => stylePreviewCard(style, prefs, (value) => set({ dockStyle: value }))))),
      settingRow({ key: 'font' }, t('dockFont'), null, segmented(prefs.dockFont, [
        { value: 'system', label: t('fontSystem') },
        { value: 'mono', label: t('fontMono') },
      ], (value) => set({ dockFont: value }), t('dockFont'))),
      settingRow({ key: 'size' }, t('dockSize'), null, segmented(prefs.dockSize, [
        { value: 'sm', label: t('sizeSm') },
        { value: 'md', label: t('sizeMd') },
        { value: 'lg', label: t('sizeLg') },
      ], (value) => set({ dockSize: value }), t('dockSize'))),
      settingRow({ key: 'content' }, t('dockContent'), t('dockContentHint'), chips([
        { key: 'dockTokens', label: t('contentTokens'), on: prefs.dockTokens },
        { key: 'dockLight', label: t('contentLight'), on: prefs.dockLight },
        { key: 'dockModels', label: t('contentModels'), on: prefs.dockModels },
      ], (key, on) => set({ [key]: on }))))
  )
}

/**
 * USD → CNY rate field. Edits stay local until the field loses focus or Enter is pressed; an invalid number
 * (empty, zero, negative) snaps back to the saved rate instead of being sent to the Host.
 */
function FxRateInput(props) {
  const { value, onCommit } = props
  const [text, setText] = React.useState(String(value))
  React.useEffect(() => { setText(String(value)) }, [value])
  const commit = () => {
    const n = Number(text)
    if (Number.isFinite(n) && n >= 0.01 && n <= 1000) onCommit(n)
    else setText(String(value))
  }
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: SECONDARY } },
    h('span', { style: { whiteSpace: 'nowrap' } }, '1 USD ='),
    h('input', {
      type: 'number', min: 0.01, step: 'any', value: text, 'aria-label': t('fxTitle'),
      onChange: (e) => setText(e.target.value), onBlur: commit,
      onKeyDown: (e) => { if (e.key === 'Enter') commit() },
      style: Object.assign({}, ui.input, { width: 96, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }),
    }),
    h('span', null, 'CNY'))
}

/** Settings → the token / price / cost columns of the per-model table in the right-sidebar page and the turn hover card. */
function DetailSettings() {
  const prefs = usePrefs()
  const set = (change) => store.setPrefs(change)
  return h('div', null,
    settingRow({ key: 'cacheTokens' }, t('cacheTokensShow'), t('cacheTokensShowHint'), toggle(prefs.cacheTokens, (on) => set({ cacheTokens: on }), t('cacheTokensShow'))),
    settingRow({ key: 'sideRates' }, t('sideRatesShow'), t('sideRatesShowHint'), toggle(prefs.sideRates, (on) => set({ sideRates: on }), t('sideRatesShow'))),
    settingRow({ key: 'itemCosts' }, t('itemCostsShow'), t('itemCostsShowHint'), toggle(prefs.itemCosts, (on) => set({ itemCosts: on }), t('itemCostsShow'))))
}

/** Settings → the sidebar entry and the statistics page. */
function SidebarSettings() {
  const prefs = usePrefs()
  const set = (change) => store.setPrefs(change)
  return h('div', null,
    settingRow({ key: 'sidebar' }, t('sidebarShow'), t('sidebarShowHint'), toggle(prefs.sidebar, (on) => set({ sidebar: on }), t('sidebarShow'))),
    settingRow({ key: 'range' }, t('statsRange'), t('statsRangeHint'), segmented(prefs.statsRange,
      STATS_RANGES.map((n) => ({ value: n, label: t('rangeDays', { n }) })),
      (value) => set({ statsRange: value }), t('statsRange'))))
}

/** Settings → the currency every surface shows money in, and the USD → CNY rate used to get there. */
function CurrencySettings() {
  const prefs = usePrefs()
  const set = (change) => store.setPrefs(change)
  return h('div', null,
    settingRow({ key: 'currency' }, t('currencyView'), t('currencyViewHint'), segmented(prefs.statsCurrency, [
      { value: 'CNY', label: t('curCny') },
      { value: 'USD', label: t('curUsd') },
      { value: 'original', label: t('curOriginal') },
    ], (value) => set({ statsCurrency: value }), t('currencyView'))),
    settingRow({ key: 'fx' }, t('fxTitle'), t('fxHint', { rate: DEFAULT_PREFS.usdCny }),
      h(FxRateInput, { value: prefs.usdCny, onCommit: (n) => set({ usdCny: n }) }),
      prefs.usdCny !== DEFAULT_PREFS.usdCny ? btn(t('fxReset'), () => set({ usdCny: DEFAULT_PREFS.usdCny })) : null))
}

// Sample turn for the message style previews.
const PREVIEW_TURN = {
  calls: 3, failed: 0, unpriced: 0, costs: { CNY: 0.0421 }, input: 4200, output: 900, cacheRead: 21000, cacheWrite: 0, wallMs: 9000,
  models: [{ model: 'deepseek-chat', calls: 3, costs: { CNY: 0.0421 }, units: 0, media: null }],
}
const MSG_STYLE_KEYS = {
  plain: ['stylePlain', 'msgStylePlainDesc'],
  soft: ['styleSoft', 'msgStyleSoftDesc'],
  outline: ['styleOutline', 'msgStyleOutlineDesc'],
}

/** One selectable card: the summary line above a mock action row with the chip, in that style. */
function msgStyleCard(style, prefs, onPick) {
  const on = prefs.msgStyle === style
  const keys = MSG_STYLE_KEYS[style]
  const shown = Object.assign({}, prefs, { msgStyle: style })
  const summary = convertSummary(PREVIEW_TURN, moneyView(prefs).convert)
  return h('button', {
    key: style,
    type: 'button',
    role: 'radio',
    'aria-checked': on,
    onClick: () => onPick(style),
    style: {
      display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 10, textAlign: 'left', padding: 14, minWidth: 0,
      borderRadius: 16, border: BORDER, background: 'transparent', color: PRIMARY, fontFamily: 'inherit', cursor: 'pointer',
      boxShadow: on ? 'inset 0 0 0 1.5px ' + PRIMARY : 'none',
    },
  },
    h('div', { style: { padding: '12px 10px', borderRadius: 12, background: PLATFORM, border: BORDER, overflow: 'hidden', pointerEvents: 'none' } },
      h(TurnLine, { summary, prefs: shown }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, height: 28, color: TERTIARY, fontSize: 12 } },
        h('span', { style: { padding: '0 6px' } }, t('msgPreviewCopy')),
        h(TurnChip, { summary, prefs: shown }),
        h('span', { style: { padding: '0 6px' } }, t('msgPreviewBranch')))),
    h('div', null,
      h('div', { style: { fontSize: 14, lineHeight: '20px' } }, t(keys[0])),
      h('div', { style: ui.desc }, t(keys[1]))))
}

/** Settings → the cost label and summary line under assistant messages. */
function MessageSettings() {
  const prefs = usePrefs()
  const set = (change) => store.setPrefs(change)
  const dim = prefs.msgChip || prefs.msgLine ? 1 : 0.45
  return h('div', null,
    settingRow({ key: 'msgChip' }, t('msgChipShow'), t('msgChipShowHint'), toggle(prefs.msgChip, (on) => set({ msgChip: on }), t('msgChipShow'))),
    settingRow({ key: 'msgLine' }, t('msgLineShow'), t('msgLineShowHint'), toggle(prefs.msgLine, (on) => set({ msgLine: on }), t('msgLineShow'))),
    h('div', { style: { opacity: dim } },
      h('div', { style: { padding: '18px 0', borderBottom: BORDER } },
        h('div', { style: ui.title }, t('msgStyle')),
        h('div', { style: ui.desc }, t('msgStyleHint')),
        h('div', { role: 'radiogroup', 'aria-label': t('msgStyle'), style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 14 } },
          MSG_STYLES.map((style) => msgStyleCard(style, prefs, (value) => set({ msgStyle: value }))))),
      settingRow({ key: 'msgFont' }, t('dockFont'), null, segmented(prefs.msgFont, [
        { value: 'system', label: t('fontSystem') },
        { value: 'mono', label: t('fontMono') },
      ], (value) => set({ msgFont: value }), t('dockFont')))))
}
