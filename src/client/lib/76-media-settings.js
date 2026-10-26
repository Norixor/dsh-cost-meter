// Settings → experimental image / speech metering: the switch, the rules and the tools seen so far.

const MEDIA_KIND_KEYS = { image: 'mediaKindImage', speech: 'mediaKindSpeech', transcribe: 'mediaKindStt' }
const MEDIA_UNIT_KEYS = { image: 'unitPerImage', speech: 'unitPerKChars', transcribe: 'unitPerMinute' }
const MEDIA_KINDS_LIST = ['image', 'speech', 'transcribe']

function MediaRuleRow(props) {
  const { rule, shadowed, onChange, onRemove } = props
  const set = (field) => (value) => onChange(Object.assign({}, rule, { [field]: value }))
  return h('div', { style: { padding: '16px 0', borderBottom: BORDER, display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
      segmented(rule.kind, MEDIA_KINDS_LIST.map((kind) => ({ value: kind, label: t(MEDIA_KIND_KEYS[kind]) })), (kind) => onChange(Object.assign({}, rule, { kind })), t('mediaKind'), true),
      btn(t('mediaRemove'), onRemove)),
    h('div', { style: Object.assign({}, ui.grid, { gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }) },
      inputField('tool', t('mediaTool'), { value: rule.tool, onChange: set('tool'), attrs: { placeholder: t('mediaToolHint') } }),
      inputField('whenArg', t('mediaWhenArg'), { value: rule.whenArg, onChange: set('whenArg'), attrs: { placeholder: 'model' } }),
      inputField('whenValue', t('mediaWhenValue'), { value: rule.whenValue, onChange: set('whenValue'), attrs: { placeholder: 'wan2.6-t2i' } }),
      inputField('model', t('mediaModel'), { value: rule.model, onChange: set('model'), attrs: { placeholder: 'gpt-image-1' } }),
      inputField('modelArg', t('mediaModelArg'), { value: rule.modelArg, onChange: set('modelArg'), attrs: { placeholder: 'model' } }),
      inputField('qtyArg', t('mediaQtyArg'), { value: rule.qtyArg, onChange: set('qtyArg'), attrs: { placeholder: { image: 'n', speech: 'text', transcribe: 'duration' }[rule.kind] } }),
      inputField('currency', t('currency'), { value: rule.currency, onChange: (v) => onChange(Object.assign({}, rule, { currency: v.toUpperCase().slice(0, 3) })), attrs: { maxLength: 3, placeholder: 'CNY' } }),
      numField('price', t('mediaPrice') + ' · ' + t(MEDIA_UNIT_KEYS[rule.kind]), rule.price, set('price'), '0')),
    shadowed ? h('div', { style: { fontSize: 12, color: SECONDARY } }, '! ' + t('mediaShadowed')) : null)
}

function MediaSettings() {
  const prefs = usePrefs()
  const state = useStore()
  const media = (state.snap && state.snap.media) || { rules: [], templates: [], observed: [] }
  const [draft, setDraft] = React.useState(null)
  const [showAll, setShowAll] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const rules = draft || media.rules.map(ruleToDraft)
  const edit = (next) => setDraft(next)
  const shadowed = shadowedRules(rules)
  const incomplete = rules.some((r) => draftIssue(r) !== null)
  const observed = showAll ? media.observed : media.observed.filter((o) => MEDIA_HINT.test(o.name))

  const save = () => {
    setSaving(true)
    postAction({ action: 'set-media-rules', rules: rules.map((r) => Object.assign({}, r, { price: Number(r.price) || 0 })) })
      .then(() => { setDraft(null); store.refresh() }).catch(() => {}).then(() => setSaving(false))
  }
  const addTemplate = (index) => {
    const tpl = media.templates[index]
    if (!tpl) return
    edit(rules.concat([Object.assign(blankDraft(tpl.kind), { model: tpl.model, currency: tpl.currency, price: String(tpl.price) })]))
  }
  const templateOptions = media.templates.map((tpl, i) => ({
    value: i, group: t(MEDIA_KIND_KEYS[tpl.kind]),
    label: tpl.model + (tpl.note ? ' (' + tpl.note + ')' : '') + ' · ' + tpl.currency + ' ' + tpl.price,
  }))

  const head = settingRow({ key: 'media' }, t('mediaShow'), t('mediaShowHint'), toggle(prefs.mediaMeter, (on) => store.setPrefs({ mediaMeter: on }), t('mediaShow')))
  if (!prefs.mediaMeter) return h('div', null, head)

  return h('div', null, head,
    h('div', { style: { padding: '18px 0 0' } },
      h('div', { style: ui.title }, t('mediaRulesTitle')),
      h('div', { style: ui.desc }, t('mediaRulesHint')),
      rules.length === 0 ? h('div', { style: Object.assign({}, ui.desc, { padding: '14px 0' }) }, t('mediaNoRules')) : null,
      rules.map((rule, i) => h(MediaRuleRow, {
        key: i, rule, shadowed: shadowed.includes(i),
        onChange: (next) => edit(rules.map((r, j) => (j === i ? next : r))),
        onRemove: () => edit(rules.filter((_, j) => j !== i)),
      })),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '14px 0' } },
        btn(t('mediaAddRule'), () => edit(rules.concat([blankDraft('image')]))),
        h(Dropdown, { options: templateOptions, label: t('mediaTemplate'), placeholder: t('mediaTemplate'), onPick: addTemplate, searchable: true, searchPlaceholder: t('mediaTemplateSearch'), emptyText: t('mediaTemplateEmpty') }),
        draft ? btn(t('mediaSave'), save, 'primary', saving || incomplete) : null,
        draft ? btn(t('mediaDiscard'), () => setDraft(null)) : null),
      draft && incomplete ? h('div', { style: Object.assign({}, ui.desc, { marginBottom: 6 }) }, t('mediaIncomplete')) : null,
      h('div', { style: ui.desc }, t('mediaTemplateNote'))),

    h('div', { style: { padding: '22px 0 0' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' } },
        h('div', null, h('div', { style: ui.title }, t('mediaObserved')), h('div', { style: ui.desc }, t('mediaObservedHint'))),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          segmented(showAll ? 'all' : 'likely', [{ value: 'likely', label: t('mediaObservedFiltered') }, { value: 'all', label: t('mediaObservedAll') }], (v) => setShowAll(v === 'all'), t('mediaObserved'), true),
          btn(t('mediaClearObserved'), () => postAction({ action: 'clear-observed' }).then(() => store.refresh()).catch(() => {}), null, media.observed.length === 0))),
      observed.length === 0 ? h('div', { style: Object.assign({}, ui.desc, { padding: '14px 0' }) }, t('mediaObservedEmpty'))
        : observed.slice(0, 30).map((o) => h('div', { key: o.name, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: BORDER, flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
            h('div', { style: { fontSize: 13, color: PRIMARY, wordBreak: 'break-all' } }, o.name),
            h('div', { style: ui.desc }, t('mediaCalls', { n: o.calls }) + (o.argKeys.length > 0 ? ' · ' + o.argKeys.join(', ') : '')),
            o.models.length > 0 ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
              h('span', { style: { fontSize: 11, color: TERTIARY } }, t('mediaModelValues', { arg: o.modelArg })),
              o.models.map((value) => h('span', { key: value, style: ui.badge }, value))) : null),
          btn(o.models.length > 0 ? t('mediaUseModels', { n: o.models.length }) : t('mediaUseTool'),
            () => edit(mergeDrafts(rules, draftsForObserved(o, media.templates))))))))
}
