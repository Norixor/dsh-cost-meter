const blankTier = () => {
  const row = { above: '' }
  for (const field of PRICE_FIELDS) row[field] = ''
  return row
}

// Visual language follows the official settings page: flat rows split by hairlines,
// soft-fill inputs, bordered buttons and pill switches instead of boxed cards.
const FIELD_LABELS = { input: 'rIn', output: 'rOut', cacheRead: 'rCacheRead', cacheWrite: 'rCacheWrite' }
const ui = {
  row: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '18px 0', borderBottom: BORDER },
  text: { flex: '1 1 240px', minWidth: 0 },
  title: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 14, lineHeight: '22px', color: PRIMARY, wordBreak: 'break-all' },
  desc: { fontSize: 12, lineHeight: '18px', color: TERTIARY, marginTop: 2 },
  controls: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', flexWrap: 'wrap' },
  input: { width: '100%', minWidth: 0, height: 36, padding: '0 12px', border: 'none', borderRadius: 12, background: FILL, color: PRIMARY, fontFamily: 'inherit', fontSize: 14, boxSizing: 'border-box' },
  label: { fontSize: 12, color: TERTIARY, marginBottom: 4 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: 10, alignItems: 'end' },
  nested: { display: 'flex', flexDirection: 'column', gap: 12, marginLeft: 4, paddingLeft: 16, borderLeft: BORDER },
  badge: { fontSize: 11, lineHeight: '18px', padding: '0 8px', borderRadius: 999, background: FILL, color: SECONDARY, whiteSpace: 'nowrap' },
  section: { fontSize: 14, fontWeight: 600, color: PRIMARY, margin: '32px 0 0' },
}

const small = (color, text) => h('span', { style: { fontSize: 11, color } }, text)

/** Bordered button; `primary` is the filled call-to-action (used for pending changes). */
const btn = (label, onClick, kind, disabled) => h('button', {
  type: 'button',
  disabled,
  onClick,
  style: Object.assign({
    height: 36, padding: '0 16px', borderRadius: 12, border: BORDER, background: PLATFORM, color: PRIMARY,
    fontFamily: 'inherit', fontSize: 14, whiteSpace: 'nowrap', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  }, kind === 'primary' ? { background: PRIMARY, color: PLATFORM, borderColor: 'transparent' } : null),
}, label)

function toggle(checked, onChange, label) {
  const track = checked ? PRIMARY : 'color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent)'
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, onClick: () => onChange(!checked),
    style: { position: 'relative', width: 36, height: 20, padding: 0, border: 'none', borderRadius: 999, flex: '0 0 auto', cursor: 'pointer', background: track, transition: 'background .15s' },
  }, h('span', { style: { position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: PLATFORM, boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s' } }))
}

/** Segmented control: exactly one option selected. options = [{ value, label }]. */
function segmented(value, options, onChange, label, compact) {
  return h('div', {
    role: 'radiogroup',
    'aria-label': label,
    style: { display: 'inline-flex', gap: 2, padding: 2, borderRadius: compact ? 10 : 12, background: FILL, flex: '0 0 auto' },
  }, options.map((option) => {
    const on = option.value === value
    return h('button', {
      key: String(option.value),
      type: 'button',
      role: 'radio',
      'aria-checked': on,
      onClick: () => onChange(option.value),
      style: {
        height: compact ? 24 : 30, padding: compact ? '0 10px' : '0 14px', borderRadius: 10, border: on ? BORDER : '0.5px solid transparent',
        background: on ? PLATFORM : 'transparent', color: on ? PRIMARY : SECONDARY,
        fontFamily: 'inherit', fontSize: compact ? 12 : 13, whiteSpace: 'nowrap', cursor: 'pointer',
        boxShadow: on ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
      },
    }, option.label)
  }))
}

/** Independent on/off chips (a multi-select): options = [{ key, label, on }]. */
function chips(options, onToggle) {
  return h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, options.map((option) => h('button', {
    key: option.key,
    type: 'button',
    'aria-pressed': option.on,
    onClick: () => onToggle(option.key, !option.on),
    style: {
      height: 30, padding: '0 14px', borderRadius: 999, border: BORDER, fontFamily: 'inherit', fontSize: 13,
      cursor: 'pointer', whiteSpace: 'nowrap',
      background: option.on ? PRIMARY : PLATFORM, color: option.on ? PLATFORM : SECONDARY,
    },
  }, option.label)))
}

/** One settings row: title + description on the left, controls on the right. */
function settingRow(opts, title, desc, ...controls) {
  return h('div', { key: opts.key, style: Object.assign({}, ui.row, opts.plain ? { borderBottom: 'none', padding: '8px 0' } : null) },
    h('div', { style: ui.text }, h('div', { style: ui.title }, title), desc ? h('div', { style: ui.desc }, desc) : null),
    h('div', { style: ui.controls }, ...controls))
}

function inputField(key, label, props) {
  return h('div', { key, style: { minWidth: 0 } },
    h('div', { style: ui.label }, label),
    h('input', Object.assign({ style: ui.input, onChange: (e) => props.onChange(e.target.value) }, props.attrs, { value: props.value })))
}
const numField = (key, label, value, onChange, placeholder) => inputField(key, label, {
  value, onChange, attrs: { type: 'number', min: 0, step: 'any', placeholder },
})

/** Collapsed view: a small rate table — base row, one row per tier, one row for peak. */
function rateTable(price) {
  const cur = price.currency || 'USD'
  const cell = (key, value, dim) => h('div', {
    key,
    style: { textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: dim ? TERTIARY : PRIMARY },
  }, value > 0 ? formatRate(cur, value) : '—')
  const line = (key, label, values, overrides) => [
    h('div', { key: key + 'l', style: { fontSize: 11, color: TERTIARY, whiteSpace: 'nowrap' } }, label),
    PRICE_FIELDS.map((field) => cell(key + field, values[field], !overrides[field])),
  ]
  const all = {}
  for (const field of PRICE_FIELDS) all[field] = true
  const rows = [line('base', t('rateBase'), price, all)]
  for (const tier of Array.isArray(price.tiers) ? price.tiers : []) {
    const own = {}
    for (const field of PRICE_FIELDS) own[field] = tier[field] > 0
    rows.push(line('t' + tier.above, '>' + formatK(tier.above), tierRates(price, tier), own))
  }
  if (price.peak && price.peak.enabled) {
    const own = {}
    const merged = {}
    for (const field of PRICE_FIELDS) {
      own[field] = price.peak[field] > 0
      merged[field] = price.peak[field] > 0 ? price.peak[field] : (price[field] || 0)
    }
    rows.push(line('peak', t('ratePeak'), merged, own))
  }
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(40px, auto) repeat(4, minmax(0, 1fr))', gap: '4px 10px', alignItems: 'baseline' } },
    h('div', { key: 'corner' }),
    ['rIn', 'rOut', 'rCacheRead', 'rCacheWrite'].map((key) => h('div', { key, style: { textAlign: 'right', fontSize: 11, color: TERTIARY } }, t(key))),
    rows)
}
