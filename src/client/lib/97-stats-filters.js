// Header tabs and the filter row of the statistics page.

/** Underlined top-level tabs; arrow keys move between them (roving tabindex). tabs = [{ value, label }]. */
function StatsTabs(props) {
  const { tabs, value, onChange } = props
  const refs = React.useRef({})
  const move = (e, index) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -index : e.key === 'End' ? tabs.length : 0
    if (!dir) return
    e.preventDefault()
    const next = tabs[Math.min(tabs.length - 1, Math.max(0, index + dir))]
    onChange(next.value)
    const el = refs.current[next.value]
    if (el) el.focus()
  }
  return h('div', {
    role: 'tablist', 'aria-label': t('statsTitle'),
    style: { display: 'flex', gap: 4, overflowX: 'auto', scrollbarWidth: 'none', boxShadow: 'inset 0 -0.5px 0 var(--dsw-alias-border-l2)' },
  }, tabs.map((tab, i) => {
    const on = tab.value === value
    return h('button', {
      key: tab.value, type: 'button', role: 'tab', id: 'dsh-cost-tab-' + tab.value, 'aria-selected': on, 'aria-controls': 'dsh-cost-panel',
      tabIndex: on ? 0 : -1, ref: (el) => { refs.current[tab.value] = el },
      onClick: () => onChange(tab.value), onKeyDown: (e) => move(e, i),
      style: Object.assign({}, plainButton, {
        padding: '10px 14px', fontSize: 14, whiteSpace: 'nowrap', cursor: 'pointer', color: on ? PRIMARY : TERTIARY, fontWeight: on ? 600 : 400,
        borderBottom: '2px solid ' + (on ? PRIMARY : 'transparent'),
      }),
    }, tab.label)
  }))
}

/**
 * Multi-select of models. `selected` is null (every model) or a Set of ids; the last remaining model cannot be unticked.
 * options = [{ id, color, calls }].
 */
function ModelFilter(props) {
  const { options, selected, onChange } = props
  const [open, setOpen] = React.useState(false)
  const wrap = React.useRef(null)
  React.useEffect(() => {
    if (!open) return undefined
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const isOn = (id) => selected === null || selected.has(id)
  const toggleOne = (id) => {
    const next = new Set(selected === null ? options.map((o) => o.id) : selected)
    if (next.has(id)) { if (next.size > 1) next.delete(id) } else next.add(id)
    onChange(next.size === options.length ? null : next)
  }
  const label = selected === null ? t('allModels') : selected.size === 1 ? Array.from(selected)[0] : t('modelsSelected', { n: selected.size })
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, fontSize: 13, color: PRIMARY, width: '100%', boxSizing: 'border-box' }

  return h('div', { ref: wrap, style: { position: 'relative', flex: '0 0 auto' } },
    h('button', {
      type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': t('filterModels'), onClick: () => setOpen(!open),
      style: {
        height: 34, maxWidth: 240, padding: '0 12px', borderRadius: 12, border: BORDER, background: selected === null ? PLATFORM : FILL,
        color: PRIMARY, fontFamily: 'inherit', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
      },
    },
    h('span', { style: { color: TERTIARY } }, t('filterModels')),
    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, label),
    h('span', { 'aria-hidden': true, style: { fontSize: 9, color: TERTIARY } }, open ? '▴' : '▾')),
    open ? h('div', {
      role: 'listbox', 'aria-multiselectable': true,
      style: {
        position: 'absolute', top: 40, left: 0, zIndex: 30, width: 'min(320px, 86vw)', maxHeight: 340, overflowY: 'auto', boxSizing: 'border-box',
        padding: 6, borderRadius: 14, border: BORDER, background: PLATFORM, boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      },
    },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '4px 10px 6px', fontSize: 12 } },
      h('button', { type: 'button', onClick: () => onChange(null), disabled: selected === null, style: Object.assign({}, plainButton, { color: selected === null ? TERTIARY : PRIMARY, cursor: selected === null ? 'default' : 'pointer' }) }, t('selectAll')),
      h('span', { style: { color: TERTIARY } }, t('modelsHint'))),
    options.map((o) => h('div', { key: o.id, style: { display: 'flex', alignItems: 'center' } },
      h('button', {
        type: 'button', role: 'option', 'aria-selected': isOn(o.id), onClick: () => toggleOne(o.id),
        style: Object.assign({}, plainButton, rowStyle, { flex: 1, minWidth: 0, cursor: 'pointer', background: 'transparent' }),
      },
      h('span', { 'aria-hidden': true, style: { width: 14, height: 14, borderRadius: 4, flex: '0 0 auto', boxSizing: 'border-box', border: isOn(o.id) ? 'none' : BORDER, background: isOn(o.id) ? PRIMARY : 'transparent', color: PLATFORM, fontSize: 10, lineHeight: '14px', textAlign: 'center' } }, isOn(o.id) ? '✓' : ''),
      h('span', { 'aria-hidden': true, style: { width: 8, height: 8, borderRadius: 2, background: o.color, flex: '0 0 auto' } }),
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: o.id }, o.id),
      h('span', { style: { fontSize: 12, color: TERTIARY, fontVariantNumeric: 'tabular-nums' } }, o.calls > 0 ? String(o.calls) : '—')),
      h('button', {
        type: 'button', onClick: () => { onChange(new Set([o.id])); setOpen(false) },
        style: Object.assign({}, plainButton, { fontSize: 12, color: TERTIARY, padding: '6px 8px', cursor: 'pointer', whiteSpace: 'nowrap' }),
      }, t('onlyThis'))))) : null)
}

/** Top-right of the page: when the data was last fetched, the auto-refresh switch and the manual refresh button. */
function StatsRefresh(props) {
  const { auto, onAuto, onRefresh, loading, updatedAt } = props
  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour12: false }) : null
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' } },
    time ? h('span', { style: { fontSize: 12, color: TERTIARY, fontVariantNumeric: 'tabular-nums' }, role: 'status' }, t('statsUpdated', { time })) : null,
    h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: SECONDARY, cursor: 'pointer' }, title: t('statsAutoHint') },
      h('span', null, t('statsAuto')),
      toggle(auto, onAuto, t('statsAuto'))),
    h('button', {
      type: 'button', onClick: onRefresh, disabled: loading, 'aria-label': t('statsRefresh'), title: t('statsRefresh'),
      style: {
        width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: BORDER,
        background: PLATFORM, color: PRIMARY, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1,
      },
    }, uiIcon('refresh', 15, loading)))
}
