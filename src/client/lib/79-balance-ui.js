// Account balances (balance.js): the settings section where accounts are added and asked, and the block on the right-sidebar
// page. The Host keeps the keys and does the asking; this side only sends what was typed and shows what comes back. A key
// typed here lives in component state until it is saved and is never read back: the Host answers `hasKey`, nothing more.
// Answers carry a stable `code`; the texts below are chosen by it.

const BALANCE_ERROR_KEYS = {
  network: 'balErrNetwork', timeout: 'balErrTimeout', unauthorized: 'balErrUnauthorized', 'too-large': 'balErrTooLarge', 'bad-format': 'balErrFormat',
  'no-value': 'balErrNoValue', busy: 'balErrBusy', changed: 'balErrChanged', 'no-key': 'balNoKey', 'bad-url': 'balErrBadUrl', 'bad-path': 'balErrBadPath',
  'bad-currency': 'balErrBadCurrency', 'bad-key': 'balErrBadKey', 'write-failed': 'balErrWrite',
}
const BALANCE_PART_KEYS = { granted: 'balGranted', toppedUp: 'balToppedUp', used: 'balUsed' }
const NO_BALANCE = { max: 0, providers: [], accounts: [] }

const balanceOf = (snap) => (snap && snap.balance) || NO_BALANCE

/** Amounts are shown in the currency the provider reports, never converted. */
const balanceMoney = (currency, amount) => (amount < 0 ? '-' : '') + formatMoney(currency, Math.abs(amount))

/** "¥110.00 (Granted ¥10.00 · Topped up ¥100.00)", one per currency the account holds. */
function balanceRowText(row) {
  const parts = row.parts.map((p) => t(BALANCE_PART_KEYS[p.kind]) + ' ' + balanceMoney(row.currency, p.amount))
  return balanceMoney(row.currency, row.total) + (parts.length > 0 ? ' (' + parts.join(' · ') + ')' : '')
}

/** Failure text of a Host answer or of an account's last error (`{ code, status }`; too-many also needs `max`). */
function balanceError(res, max) {
  if (res.code === 'http') return t('balErrHttp', { status: res.status })
  if (res.code === 'too-many') return t('balErrTooMany', { n: max })
  if (BALANCE_ERROR_KEYS[res.code]) return t(BALANCE_ERROR_KEYS[res.code])
  return t('balFailed', { error: res.error || res.code || 'unknown' })
}

/** One Host call; always resolves to an object with `ok`. */
const balanceCall = (body) => postAction(body)
  .then((res) => res || { ok: false, code: 'empty' })
  .catch((err) => ({ ok: false, code: 'network', error: (err && err.message) || String(err) }))

const providerName = (snap, account) => {
  if (account.provider === 'custom') return t('balCustom')
  const found = balanceOf(snap).providers.find((p) => p.id === account.provider)
  return found ? found.name : account.provider
}

/** The last answer of an account as lines of text: money per currency, a low-balance notice, when, or why it failed. */
function BalanceStatus(props) {
  const { account, max } = props
  const { result, error } = account
  const line = (text, color, key) => h('div', { key, style: { fontSize: 12, lineHeight: '18px', color } }, text)
  const lines = []
  if (result) {
    result.rows.forEach((row, i) => lines.push(h('div', { key: 'r' + i, style: { fontSize: 14, lineHeight: '22px', color: PRIMARY, fontVariantNumeric: 'tabular-nums' } }, balanceRowText(row))))
    if (result.available === false) lines.push(line(t('balLow'), LIGHT.red, 'low'))
    lines.push(line(t('balUpdated', { when: historyWhen(result.at) }), TERTIARY, 'at'))
  } else if (account.hasKey && !error) lines.push(line(t('balNever'), TERTIARY, 'never'))
  if (!account.hasKey) lines.push(line(t('balNoKey'), SECONDARY, 'nokey'))
  if (error) lines.push(line(balanceError(error, max), LIGHT.red, 'err'))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2 } }, lines)
}

/** Add an account (no `account`) or edit one: provider chips, name, key, and for a custom account where to look. */
function BalanceEditor(props) {
  const { snap, account, onDone } = props
  const info = balanceOf(snap)
  const [provider, setProvider] = React.useState(account ? account.provider : info.providers.length > 0 ? info.providers[0].id : 'custom')
  const [label, setLabel] = React.useState(account ? account.label : '')
  const [key, setKey] = React.useState('')
  const [clearKey, setClearKey] = React.useState(false)
  const [url, setUrl] = React.useState(account && account.url ? account.url : '')
  const [path, setPath] = React.useState(account && account.path ? account.path : '')
  const [currency, setCurrency] = React.useState(account && account.currency ? account.currency : 'USD')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const custom = provider === 'custom'
  const chosen = info.providers.find((p) => p.id === provider)

  const save = () => {
    setBusy(true)
    setError(null)
    const body = { action: 'balance-save', provider, label }
    if (account) body.id = account.id
    if (key !== '') body.key = key.trim()
    if (clearKey) body.clearKey = true
    if (custom) Object.assign(body, { url, path, currency })
    balanceCall(body).then((res) => {
      setBusy(false)
      if (!res.ok) { setError(balanceError(res, info.max)); return }
      setKey('')
      store.refresh().then(() => onDone(res.keyDropped ? t('balKeyDropped') : null))
    })
  }
  const providerChips = account ? null : chips(
    info.providers.map((p) => ({ key: p.id, label: p.name, on: provider === p.id })).concat({ key: 'custom', label: t('balCustom'), on: custom }),
    (id) => setProvider(id))
  const field = (name, text, value, onChange, attrs) => inputField(name, text, { value, onChange, attrs })

  return h('div', { style: { padding: '14px 0 18px', borderBottom: BORDER, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } },
    providerChips,
    h('div', { style: ui.grid },
      field('balLabel', t('balLabel'), label, setLabel, { maxLength: 40, placeholder: chosen ? chosen.name : '' }),
      field('balKey', t('balKey'), key, (v) => { setKey(v); setClearKey(false) }, {
        type: 'password', autoComplete: 'off', spellCheck: false, 'aria-label': t('balKey'),
        placeholder: account && account.hasKey && !clearKey ? t('balKeySaved') : t('balKeyPlaceholder'),
      })),
    custom ? h('div', { style: ui.grid },
      field('balUrl', t('balUrl'), url, setUrl, { placeholder: 'https://example.com/v1/balance', spellCheck: false }),
      field('balPath', t('balPath'), path, setPath, { placeholder: 'data.balance', spellCheck: false }),
      field('balCurrency', t('balCurrency'), currency, (v) => setCurrency(v.toUpperCase()), { maxLength: 3, placeholder: 'USD' })) : null,
    custom ? h('div', { style: ui.desc }, t('balCustomHint')) : null,
    chosen && chosen.keyKind === 'management' ? h('div', { style: ui.desc }, t('balKeyManagement')) : null,
    error ? small(LIGHT.red, error) : null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      btn(t('balSave'), save, 'primary', busy),
      btn(t('balCancel'), () => onDone(null), null, busy),
      account && account.hasKey && !clearKey ? btn(t('balKeyClear'), () => { setClearKey(true); setKey('') }, null, busy) : null))
}

/** Settings → accounts (add, edit, ask, delete), the timer and the right-sidebar switch. */
function BalanceSettings(props) {
  const { snap } = props
  const info = balanceOf(snap)
  const prefs = usePrefs()
  // null = closed, 'new' = adding, an id = editing that account.
  const [editing, setEditing] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [notice, setNotice] = React.useState(null)

  const run = (body, id) => {
    setBusy(id)
    setNotice(null)
    balanceCall(body).then((res) => {
      if (!res.ok && body.action === 'balance-remove') setNotice(balanceError(res, info.max))
      return store.refresh()
    }).then(() => setBusy(null))
  }
  const remove = (account) => {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('balDeleteConfirm', { label: account.label }))) return
    run({ action: 'balance-remove', id: account.id }, account.id)
  }
  const asking = (account) => busy === account.id || busy === 'all' || account.busy
  const withKey = info.accounts.filter((a) => a.hasKey).length

  return h('div', null,
    h('div', { style: Object.assign({}, ui.desc, { marginTop: 6 }) }, t('balIntro')),
    info.accounts.length === 0 && editing === null ? h('div', { style: Object.assign({}, ui.desc, { padding: '14px 0', borderBottom: BORDER }) }, t('balEmpty')) : null,
    info.accounts.map((account) => (editing === account.id
      ? h(BalanceEditor, { key: account.id, snap, account, onDone: (message) => { setEditing(null); setNotice(message) } })
      : settingRow({ key: account.id }, h('span', null, account.label, account.label === providerName(snap, account) ? null : ' ', account.label === providerName(snap, account) ? null : h('span', { style: ui.badge }, providerName(snap, account))),
        h(BalanceStatus, { account, max: info.max }),
        btn(asking(account) ? t('balRefreshing') : t('balRefresh'), () => run({ action: 'balance-refresh', id: account.id }, account.id), null, !account.hasKey || asking(account)),
        btn(t('balEdit'), () => { setNotice(null); setEditing(account.id) }),
        btn(t('balDelete'), () => remove(account), null, asking(account))))),
    editing === 'new' ? h(BalanceEditor, { key: 'new', snap, account: null, onDone: (message) => { setEditing(null); setNotice(message) } }) : null,
    notice ? h('div', { style: { padding: '10px 0 0', fontSize: 12, lineHeight: '18px', color: SECONDARY } }, notice) : null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '14px 0 0' } },
      editing === null && info.accounts.length < info.max ? btn(t('balAdd'), () => { setNotice(null); setEditing('new') }) : null,
      withKey > 1 ? btn(busy === 'all' ? t('balRefreshing') : t('balRefreshAll'), () => run({ action: 'balance-refresh' }, 'all'), null, busy !== null) : null),
    settingRow({ key: 'balAuto' }, t('balAuto'), t('balAutoHint'), toggle(prefs.balanceAuto, (on) => store.setPrefs({ balanceAuto: on }), t('balAuto'))),
    settingRow({ key: 'balSide' }, t('balSide'), t('balSideHint'), toggle(prefs.sideBalance, (on) => store.setPrefs({ sideBalance: on }), t('balSide'))))
}

/** Right-sidebar page: the accounts that have a key or an answer, with a refresh link. Nothing is drawn without accounts. */
function BalanceBlock(props) {
  const { snap } = props
  const info = balanceOf(snap)
  const [busy, setBusy] = React.useState(false)
  const shown = info.accounts.filter((a) => a.hasKey || a.result)
  if (shown.length === 0) return null
  const refreshAll = () => {
    setBusy(true)
    balanceCall({ action: 'balance-refresh' }).then(() => store.refresh()).then(() => setBusy(false))
  }
  return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('span', { style: sideLabel }, t('sideBalance')),
      h('button', {
        type: 'button', disabled: busy || shown.every((a) => !a.hasKey), onClick: refreshAll,
        style: { border: 'none', background: 'transparent', padding: 0, fontFamily: 'inherit', fontSize: 11, color: SECONDARY, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 },
      }, busy ? t('balRefreshing') : t('balRefresh'))),
    shown.map((account) => h('div', { key: account.id, style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
      h('div', { title: account.label, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: SECONDARY } }, account.label),
      h(BalanceStatus, { account, max: info.max }))))
}
