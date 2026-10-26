const React = require('react')
const h = React.createElement
const API = '/__cost-meter'
const NS = 'dsh-cost-meter'
const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']
const POLL_MS = 3000
// Keep in sync with MAX_TIERS in pricing.js.
const TIER_MAX = 4
const LIGHT = { green: '#1a7f37', yellow: '#bf8700', red: '#cf222e', grey: '#8c959f' }
const TERTIARY = 'var(--dsw-alias-label-tertiary)'
const SECONDARY = 'var(--dsw-alias-label-secondary)'
const PRIMARY = 'var(--dsw-alias-label-primary)'
const BORDER = '0.5px solid var(--dsw-alias-border-l2)'
const FILL = 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)'
const PLATFORM = 'var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-base))'

const interpolate = (value, params) => String(value).replace(/\{(\w+)\}/g, (_, key) => (params && params[key] !== undefined ? params[key] : '{' + key + '}'))

// Translator. English until apply() swaps in the locale service's bound translator.
let t = (key, params) => interpolate(EN[key] || key, params)

const getSnapshot = () => fetch(API, { cache: 'no-store' }).then((res) => res.json())
const postAction = (body) => fetch(API, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((res) => res.json())

/**
 * One shared snapshot for the dock, the settings page, the statistics page and the sidebar
 * controller. A single timer polls while anything is subscribed.
 */
const store = (() => {
  const subs = new Set()
  const state = { snap: null, error: null }
  let timer = null
  // In-flight preference writes: polling pauses meanwhile so an older snapshot cannot undo them.
  let writes = 0
  const emit = () => subs.forEach((fn) => fn())

  function refresh() {
    if (writes > 0) return Promise.resolve()
    return getSnapshot().then((data) => {
      if (writes > 0) return
      if (data && data.ok) { state.snap = data; state.error = null } else state.error = (data && data.error) || 'unknown'
      emit()
    }).catch((err) => { state.error = (err && err.message) || String(err); emit() })
  }

  function subscribe(fn) {
    subs.add(fn)
    if (!timer) { refresh(); timer = setInterval(refresh, POLL_MS) }
    return () => {
      subs.delete(fn)
      if (subs.size === 0 && timer) { clearInterval(timer); timer = null }
    }
  }

  /** Apply preference changes locally at once, then confirm with the Host (which validates them). */
  function setPrefs(change) {
    if (state.snap) {
      state.snap = Object.assign({}, state.snap, { prefs: Object.assign({}, state.snap.prefs, change) })
      emit()
    }
    writes += 1
    return postAction({ action: 'set-prefs', prefs: change }).then((res) => {
      if (res && res.ok && state.snap) { state.snap = Object.assign({}, state.snap, { prefs: res.prefs }); emit() }
    }).catch(() => {}).then(() => { writes -= 1 })
  }

  return { state, refresh, subscribe, setPrefs, notify: emit }
})()

/** Re-renders the caller whenever the shared snapshot changes; returns { snap, error }. */
function useStore() {
  const [, bump] = React.useState(0)
  React.useEffect(() => store.subscribe(() => bump((n) => n + 1)), [])
  return store.state
}

/**
 * Recent calls and the messageId -> turn map of one session (calllog.js on the Host), for the labels in the chat.
 * Refetched whenever the Host's call counter in the polled snapshot moves; one request per session at a time.
 */
const NO_CALLS = { calls: [], msgs: {} }
const callCache = {}
function loadCalls(sessionId, seq) {
  const entry = callCache[sessionId] || (callCache[sessionId] = { seq: null, calls: [], msgs: {}, busy: false })
  if (entry.busy || entry.seq === seq) return
  entry.busy = true
  postAction({ action: 'calls', sessionId }).then((res) => {
    if (res && res.ok && Array.isArray(res.calls)) { entry.calls = res.calls; entry.msgs = res.msgs && typeof res.msgs === 'object' ? res.msgs : {}; entry.seq = seq }
  }).catch(() => {}).then(() => { entry.busy = false; store.notify() })
}
function useCalls(sessionId) {
  const state = useStore()
  const seq = state.snap ? state.snap.callSeq : undefined
  React.useEffect(() => { if (sessionId && seq !== undefined) loadCalls(sessionId, seq) }, [sessionId, seq])
  return (sessionId && callCache[sessionId]) || NO_CALLS
}

/** Display preferences with defaults filled in (the Host sends the validated set). */
function usePrefs() {
  const state = useStore()
  return Object.assign({}, DEFAULT_PREFS, state.snap && state.snap.prefs)
}
