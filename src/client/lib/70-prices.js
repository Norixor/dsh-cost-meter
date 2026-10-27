/** The model price editor: one row per model, collapsed to a rate table, expandable into an editor. */
function PriceList(props) {
  const snap = props.snap
  const refresh = store.refresh
  const [drafts, setDrafts] = React.useState({})
  const [expanded, setExpanded] = React.useState({})
  const [newModel, setNewModel] = React.useState('')
  const [filter, setFilter] = React.useState('')
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  // The long tail of models that were never used stays folded until asked for.
  const [othersOpen, setOthersOpen] = React.useState(false)

  const savedPriceOf = (model) => (snap && snap.prices && snap.prices[model]) || (snap && snap.presets && snap.presets[model]) || null

  // 草稿基线：已保存的价格（自定义优先，否则预置），含峰谷与分档。
  function baseDraft(model) {
    const saved = savedPriceOf(model) || {}
    const peak = saved.peak || {}
    const windows = Array.isArray(peak.windows) ? peak.windows : []
    const tiers = Array.isArray(saved.tiers) ? saved.tiers : []
    const draft = {
      currency: saved.currency || 'USD',
      peakEnabled: peak.enabled === true,
      peakWeekdays: peak.weekdaysOnly !== false,
      w1s: windows[0] ? windows[0].start : '01:00',
      w1e: windows[0] ? windows[0].end : '04:00',
      w2s: windows[1] ? windows[1].start : '',
      w2e: windows[1] ? windows[1].end : '',
      tiersEnabled: tiers.length > 0,
      // Tier thresholds are edited in K tokens; blank prices mean "same as base".
      tiers: tiers.map((tier) => {
        const row = { above: String(tier.above / 1000) }
        for (const field of PRICE_FIELDS) row[field] = tier[field] > 0 ? String(tier[field]) : ''
        return row
      }),
    }
    for (const field of PRICE_FIELDS) {
      draft[field] = saved[field] !== undefined ? String(saved[field]) : ''
      draft['peak_' + field] = peak[field] !== undefined ? String(peak[field]) : ''
    }
    return draft
  }

  const draftOf = (model) => drafts[model] || baseDraft(model)
  const isDirty = (model) => Boolean(drafts[model]) && JSON.stringify(drafts[model]) !== JSON.stringify(baseDraft(model))

  function updateDraft(model, change) {
    setDrafts((prev) => Object.assign({}, prev, { [model]: change(prev[model] || baseDraft(model)) }))
  }
  const patchDraft = (model, field, value) => updateDraft(model, (d) => Object.assign({}, d, { [field]: value }))
  const patchTier = (model, index, field, value) => updateDraft(model, (d) => Object.assign({}, d, {
    tiers: d.tiers.map((row, i) => (i === index ? Object.assign({}, row, { [field]: value }) : row)),
  }))
  const addTier = (model) => updateDraft(model, (d) => (d.tiers.length >= TIER_MAX ? d
    : Object.assign({}, d, { tiersEnabled: true, tiers: d.tiers.concat(blankTier()) })))
  const removeTier = (model, index) => updateDraft(model, (d) => {
    const tiers = d.tiers.filter((_, i) => i !== index)
    return Object.assign({}, d, { tiers, tiersEnabled: tiers.length > 0 })
  })
  const toggleTiers = (model, on) => updateDraft(model, (d) => Object.assign({}, d, {
    tiersEnabled: on,
    tiers: on && d.tiers.length === 0 ? [blankTier()] : d.tiers,
  }))

  function clearDraft(model) {
    setDrafts((prev) => { const next = Object.assign({}, prev); delete next[model]; return next })
  }

  const toggleOpen = (model) => setExpanded((prev) => Object.assign({}, prev, { [model]: !prev[model] }))

  function flash(model, text) {
    setNotice({ model, text })
    setTimeout(() => setNotice((current) => (current && current.model === model ? null : current)), 3500)
  }

  function save(model) {
    const draft = draftOf(model)
    setBusy(model)
    setError(null)
    const body = { action: 'set-price', model, currency: draft.currency }
    for (const field of PRICE_FIELDS) body[field] = Number(draft[field]) || 0
    const windows = [
      { start: draft.w1s, end: draft.w1e },
      { start: draft.w2s, end: draft.w2e },
    ].filter((w) => w.start && w.end)
    body.peak = { enabled: draft.peakEnabled, weekdaysOnly: draft.peakWeekdays, windows }
    for (const field of PRICE_FIELDS) body.peak[field] = Number(draft['peak_' + field]) || 0
    body.tiers = draft.tiersEnabled ? draft.tiers.map((row) => {
      const tier = { above: Math.round((Number(row.above) || 0) * 1000) }
      for (const field of PRICE_FIELDS) tier[field] = Number(row[field]) || 0
      return tier
    }) : []
    postAction(body).then((res) => {
      setBusy(null)
      if (!res || !res.ok) { setError((res && res.error) || 'save failed'); return }
      clearDraft(model)
      setExpanded((prev) => Object.assign({}, prev, { [model]: false }))
      flash(model, t('saved') + (res.backfilled > 0 ? ' · ' + t('backfilled', { n: res.backfilled }) : ''))
      refresh()
    }).catch((err) => { setBusy(null); setError((err && err.message) || String(err)) })
  }

  // A price taken from the catalog (hint or picker): drop the editor state and show what was backfilled.
  function catalogApplied(model, res) {
    clearDraft(model)
    setExpanded((prev) => Object.assign({}, prev, { [model]: false }))
    flash(model, t('saved') + (res.backfilled > 0 ? ' · ' + t('backfilled', { n: res.backfilled }) : ''))
    refresh()
  }

  function removePrice(model) {
    setBusy(model)
    postAction({ action: 'remove-price', model }).then(() => {
      setBusy(null)
      clearDraft(model)
      refresh()
    }).catch((err) => { setBusy(null); setError((err && err.message) || String(err)) })
  }

  function addModel() {
    const model = newModel.trim()
    if (!model) return
    setNewModel('')
    setDrafts((prev) => Object.assign({}, prev, { [model]: draftOf(model) }))
    setExpanded((prev) => Object.assign({}, prev, { [model]: true }))
  }

  const models = snap ? snap.models || {} : {}
  const prices = snap ? snap.prices || {} : {}
  const catalog = catalogOf(snap)
  const presets = snap ? snap.presets || {} : {}
  const needle = filter.trim().toLowerCase()
  const allNames = Array.from(new Set([...Object.keys(presets), ...Object.keys(models), ...Object.keys(prices), ...Object.keys(drafts)]))
    .filter((m) => !needle || m.toLowerCase().includes(needle))

  // 用过的模型优先：按调用次数降序，其余按名字排序。
  const callsOf = (m) => (models[m] && models[m].calls) || 0
  const usedNames = allNames.filter((m) => callsOf(m) > 0).sort((a, b) => callsOf(b) - callsOf(a) || a.localeCompare(b))
  const restNames = allNames.filter((m) => callsOf(m) === 0).sort((a, b) => a.localeCompare(b))

  const labelOf = (field) => t(FIELD_LABELS[field.replace(/^peak_/, '')])

  const renderTierEditor = (model, draft) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 8 } },
    draft.tiers.map((row, index) => h('div', { key: 'tier' + index, style: ui.nested },
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' } },
        h('div', { style: { width: 170 } }, numField('above', t('tierAbove'), row.above, (v) => patchTier(model, index, 'above', v), '100')),
        h('span', { style: { flex: 1 } }),
        btn(t('tierRemove'), () => removeTier(model, index))),
      h('div', { style: ui.grid },
        PRICE_FIELDS.map((field) => numField(field, labelOf(field), row[field], (v) => patchTier(model, index, field, v), draft[field] || '0'))))),
    draft.tiers.length < TIER_MAX ? h('div', { key: 'tier-add', style: { paddingLeft: 20 } }, btn('+ ' + t('tierAdd'), () => addTier(model))) : null)

  const renderEditor = (model, draft, dirty, custom, preset) => h('div', { style: { display: 'flex', flexDirection: 'column', paddingTop: 14 } },
    catalog.count > 0 ? h(CatalogPicker, { model, replacing: custom && !catalogSourceOf(prices[model]), onApplied: (res) => catalogApplied(model, res) }) : null,
    h('div', { style: Object.assign({}, ui.label, { paddingTop: 14 }) }, t('priceHeading')),
    h('div', { style: ui.grid },
      inputField('currency', t('currency'), { value: draft.currency, onChange: (v) => patchDraft(model, 'currency', v.toUpperCase()), attrs: { maxLength: 3 } }),
      PRICE_FIELDS.map((field) => numField(field, labelOf(field), draft[field], (v) => patchDraft(model, field, v)))),

    h('div', { style: { height: 14 } }),
    settingRow({ key: 'tier' }, t('tierEnable'), t('tierHint'), toggle(draft.tiersEnabled, (on) => toggleTiers(model, on), t('tierEnable'))),
    draft.tiersEnabled ? renderTierEditor(model, draft) : null,

    settingRow({ key: 'peak' }, t('peakEnable'), t('peakHint'), toggle(draft.peakEnabled, (on) => patchDraft(model, 'peakEnabled', on), t('peakEnable'))),
    draft.peakEnabled ? h('div', { style: Object.assign({}, ui.nested, { paddingBottom: 8 }) },
      h('div', null,
        h('div', { style: ui.label }, t('peakPrice')),
        h('div', { style: ui.grid },
          PRICE_FIELDS.map((field) => numField('peak_' + field, labelOf(field), draft['peak_' + field], (v) => patchDraft(model, 'peak_' + field, v), draft[field] || '0')))),
      h('div', null,
        h('div', { style: ui.label }, t('peakWindows')),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          ['w1s', 'w1e', 'w2s', 'w2e'].map((key, i) => h('input', {
            key,
            style: Object.assign({}, ui.input, { width: 88, textAlign: 'center' }),
            placeholder: ['01:00', '04:00', '06:00', '10:00'][i],
            value: draft[key],
            'aria-label': t('peakWindows'),
            onChange: (e) => patchDraft(model, key, e.target.value),
          })))),
      settingRow({ key: 'weekdays', plain: true }, t('peakWeekdays'), null, toggle(draft.peakWeekdays, (on) => patchDraft(model, 'peakWeekdays', on), t('peakWeekdays')))) : null,

    h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 14 } },
      custom ? btn(preset ? t('restore') : t('remove'), () => removePrice(model), null, busy === model) : null,
      dirty ? btn(t('discard'), () => clearDraft(model)) : null,
      btn(busy === model ? t('saving') : t('save'), () => save(model), dirty ? 'primary' : null, busy === model)))

  const renderModel = (model) => {
    const counter = models[model] || { calls: 0, unpriced: 0 }
    const draft = draftOf(model)
    const dirty = isDirty(model)
    const isOpen = expanded[model] === true || dirty
    const price = savedPriceOf(model)
    const custom = prices[model] !== undefined
    const preset = presets[model] !== undefined
    const tierCount = price && Array.isArray(price.tiers) ? price.tiers.length : 0
    const note = notice && notice.model === model ? notice.text : null

    return h('div', { key: model, style: { padding: '18px 0', borderBottom: BORDER } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' } },
        h('div', { style: ui.text },
          h('div', { style: ui.title },
            model,
            h('span', { style: ui.badge }, custom ? (catalogSourceOf(price) ? t('sourceCatalog') : t('sourceCustom')) : preset ? t('sourcePreset') : t('sourceNone')),
            price && price.peak && price.peak.enabled ? h('span', { style: ui.badge }, t('peakTag')) : null,
            tierCount > 0 ? h('span', { style: ui.badge }, t('tierTag', { n: tierCount })) : null,
            dirty ? small(LIGHT.yellow, t('dirty')) : note ? small(LIGHT.green, note) : null),
          // Settings carry no usage statistics (those live on the sidebar page); only the
          // actionable warning stays: calls that ran while this model had no price.
          counter.unpriced > 0 ? h('div', { style: ui.desc }, small(LIGHT.red, t('unpriced', { n: counter.unpriced }))) : null),
        h('div', { style: ui.controls }, btn(isOpen ? t('collapse') : t('edit'), () => toggleOpen(model), null, dirty))),
      isOpen ? renderEditor(model, draft, dirty, custom, preset)
        : price ? h('div', { style: { maxWidth: 560, marginTop: 12 } }, rateTable(price))
          : h('div', null,
            h('div', { style: Object.assign({}, ui.desc, { marginTop: 8 }) }, t('notConfigured')),
            h(CatalogHint, { model, match: catalog.matches[model], onApplied: (res) => catalogApplied(model, res) })))
  }

  // Folded groups open by themselves while searching or when one of their models has an unsaved draft (e.g. just added).
  const renderGroup = (title, names, folded) => {
    if (names.length === 0) return null
    const forced = needle !== '' || names.some((m) => drafts[m])
    const open = !folded || othersOpen || forced
    const label = title + '（' + names.length + '）'
    return h('div', { key: title },
      folded ? h('button', {
        type: 'button',
        'aria-expanded': open,
        disabled: forced,
        onClick: () => setOthersOpen(!othersOpen),
        style: Object.assign({}, plainButton, { display: 'flex', alignItems: 'center', gap: 6, padding: '16px 0 0', fontSize: 12, color: TERTIARY, cursor: forced ? 'default' : 'pointer' }),
      }, h('span', { style: { fontSize: 9 } }, open ? '▾' : '▸'), label)
        : h('div', { style: Object.assign({}, ui.desc, { padding: '16px 0 0' }) }, label),
      open ? names.map(renderModel) : null)
  }

  return h('div', null,
    error ? h('div', { style: { color: LIGHT.red, fontSize: 12, paddingTop: 12 } }, error) : null,
    // 筛选与新增模型
    h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '14px 0 2px' } },
      h('input', { style: Object.assign({}, ui.input, { maxWidth: 260 }), value: filter, placeholder: t('filterPlaceholder'), 'aria-label': t('filterPlaceholder'), onChange: (e) => setFilter(e.target.value) }),
      h('input', {
        style: Object.assign({}, ui.input, { maxWidth: 300 }), value: newModel, placeholder: t('addPlaceholder'), 'aria-label': t('addPlaceholder'),
        onChange: (e) => setNewModel(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') addModel() },
      }),
      btn(t('add'), addModel)),
    renderGroup(t('sectionUsed'), usedNames),
    renderGroup(t('sectionOthers'), restNames, true))
}
