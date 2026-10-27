/** Settings page: display styles, sidebar switch, budget, model prices and the experimental media metering. No statistics live here. */
function SettingsPage() {
  const state = useStore()
  const snap = state.snap
  const [budgetDraft, setBudgetDraft] = React.useState(null)

  function saveBudget() {
    const current = snap && snap.budget ? snap.budget : { currency: 'CNY', amount: 0 }
    const draft = budgetDraft || { currency: current.currency, amount: current.amount ? String(current.amount) : '' }
    postAction({ action: 'set-budget', currency: draft.currency, amount: Number(draft.amount) || 0 })
      .then(() => { setBudgetDraft(null); store.refresh() })
      .catch(() => {})
  }

  function resetTotals() {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('resetConfirm'))) return
    postAction({ action: 'reset-totals' }).then(() => store.refresh()).catch(() => {})
  }

  if (snap === null) {
    return h('div', { style: { padding: 16, color: state.error ? LIGHT.red : TERTIARY } },
      state.error ? t('loadFailed', { error: state.error }) : '…')
  }

  const budget = snap.budget || { currency: 'CNY', amount: 0 }
  const budgetView = budgetDraft || { currency: budget.currency, amount: budget.amount ? String(budget.amount) : '' }

  return h('div', { style: { padding: '8px 24px 40px', boxSizing: 'border-box', minWidth: 0 } },
    h('div', { style: { padding: '12px 0 0' } },
      h('div', { style: { fontSize: 18, fontWeight: 600, color: PRIMARY } }, t('title')),
      h('div', { style: Object.assign({}, ui.desc, { marginTop: 6 }) }, t('settingsIntro'))),

    h(HistoryPrompt, { snap, style: { marginTop: 16 } }),

    h('div', { style: ui.section }, t('sectionDock')),
    h(DockSettings),

    h('div', { style: ui.section }, t('sectionSidebar')),
    h(SidebarSettings),

    h('div', { style: ui.section }, t('sectionMessages')),
    h(MessageSettings),

    h('div', { style: ui.section }, t('sectionPeak')),
    h(PeakSettings, { snap }),

    h('div', { style: ui.section }, t('sectionCurrency')),
    h(CurrencySettings),

    h('div', { style: ui.section }, t('sectionSettings')),
    settingRow({ key: 'budget' }, t('budgetSection'), t('budgetHint'),
      h('input', {
        style: Object.assign({}, ui.input, { width: 72, textAlign: 'center' }),
        maxLength: 3, value: budgetView.currency, placeholder: 'CNY', 'aria-label': t('budgetCurrency'),
        onChange: (e) => setBudgetDraft(Object.assign({}, budgetView, { currency: e.target.value.toUpperCase() })),
      }),
      h('input', {
        style: Object.assign({}, ui.input, { width: 128 }),
        type: 'number', min: 0, step: 'any', value: budgetView.amount, placeholder: t('budgetAmount'), 'aria-label': t('budgetAmount'),
        onChange: (e) => setBudgetDraft(Object.assign({}, budgetView, { amount: e.target.value })),
      }),
      btn(t('budgetSave'), saveBudget, budgetDraft ? 'primary' : null)),

    h('div', { style: ui.section }, t('sectionCatalog')),
    h(CatalogSettings, { snap }),

    h('div', { style: ui.section }, t('sectionPrices')),
    h('div', { style: Object.assign({}, ui.desc, { marginTop: 6 }) }, t('priceNote')),
    h(PriceList, { snap }),

    h('div', { style: Object.assign({}, ui.section, { display: 'flex', alignItems: 'center', gap: 8 }) }, t('sectionMedia'), h('span', { style: ui.badge }, t('mediaExperimental'))),
    h(MediaSettings),

    h('div', { style: ui.section }, t('sectionHistory')),
    h(HistorySettings, { snap }),

    h('div', { style: ui.section }, t('sectionData')),
    settingRow({ key: 'reset' }, t('reset'), t('resetHint'), btn(t('reset'), resetTotals)))
}
