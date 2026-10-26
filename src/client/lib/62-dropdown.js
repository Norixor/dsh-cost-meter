/**
 * Dropdown (button + listbox) in place of a native <select>: the browser's own popup ignores the host theme tokens and
 * showed white text on a white list under the dark theme. Used as an action menu: picking calls onPick(value) and the
 * button keeps showing the placeholder. options = [{ value, label, group? }]; consecutive equal groups share a heading.
 * With `searchable` the list opens with a search box: plain words (all must appear) or /regex/, over group + label.
 */
function Dropdown(props) {
  const { options, label, placeholder, onPick, searchable, searchPlaceholder, emptyText } = props
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const [query, setQuery] = React.useState('')
  const root = React.useRef(null)
  const shown = searchable ? options.filter((option) => queryMatcher(query)([option.group, option.label].join(' '))) : options

  React.useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (option) => { setOpen(false); setQuery(''); onPick(option.value) }
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); return }
    if (shown.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); setActive(0); return }
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      pick(shown[active >= 0 && active < shown.length ? active : 0])
    }
  }

  const items = []
  shown.forEach((option, i) => {
    if (option.group && (i === 0 || shown[i - 1].group !== option.group)) {
      items.push(h('div', { key: 'g' + i, role: 'presentation', style: { padding: '8px 10px 4px', fontSize: 11, color: TERTIARY } }, option.group))
    }
    items.push(h('div', {
      key: 'o' + i,
      role: 'option',
      'aria-selected': i === active,
      onMouseEnter: () => setActive(i),
      onMouseDown: (e) => e.preventDefault(),
      onClick: () => pick(option),
      style: {
        padding: '7px 10px', borderRadius: 8, fontSize: 13, color: PRIMARY, whiteSpace: 'nowrap', cursor: 'pointer',
        fontVariantNumeric: 'tabular-nums', background: i === active ? FILL : 'transparent',
      },
    }, option.label))
  })

  return h('div', { ref: root, style: { position: 'relative', display: 'inline-block' } },
    h('button', {
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      'aria-label': label,
      onClick: () => { setOpen(!open); setActive(-1); setQuery('') },
      onKeyDown,
      style: Object.assign({}, ui.input, { display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: 'auto', minWidth: 200, cursor: 'pointer', textAlign: 'left' }),
    }, h('span', null, placeholder), h('span', { style: { color: SECONDARY, display: 'inline-flex' } }, uiIcon('chevron', 12))),
    open ? h('div', {
      role: 'listbox',
      'aria-label': label,
      style: {
        position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, minWidth: '100%', width: 'max-content', maxWidth: 'min(360px, 90vw)',
        boxSizing: 'border-box', padding: 4, borderRadius: 12, border: BORDER, background: PLATFORM, boxShadow: '0 4px 16px rgba(0,0,0,.12)',
      },
    },
    searchable ? h('input', {
      type: 'text', value: query, autoFocus: true, placeholder: searchPlaceholder, 'aria-label': searchPlaceholder,
      onChange: (e) => { setQuery(e.target.value); setActive(0) }, onKeyDown,
      style: Object.assign({}, ui.input, { height: 32, marginBottom: 4, fontSize: 13 }),
    }) : null,
    h('div', { style: { maxHeight: 248, overflowY: 'auto' } },
      items,
      shown.length === 0 ? h('div', { style: { padding: '10px', fontSize: 12, color: TERTIARY } }, emptyText) : null)) : null)
}
