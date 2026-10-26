const slots = ctx.get('slots')
if (slots === undefined) return
const locale = ctx.get('locale')
if (locale !== undefined) {
  ctx.effect(() => {
    const offs = [locale.register(NS, 'zh', ZH), locale.register(NS, 'en', EN)]
    for (const id of Object.keys(EXTRA_LOCALES)) {
      // Optional languages must never stop the plugin from loading, whatever the host does with an unknown id.
      try { offs.push(locale.register(NS, id, EXTRA_LOCALES[id])) } catch { /* this host cannot take the language */ }
    }
    return () => { offs.forEach((off) => off()) }
  })
  t = locale.bind(NS)
}

// ---------- 输入框下方统计条 ----------

slots.inject('conversation.composer.dock', () => slots.register({
  name: 'conversation.composer.dock',
  id: 'cost-meter',
  order: 2,
  locale: NS,
  inject: (sessionId) => ({ sessionId: String(sessionId) }),
}, CostPills))

// ---------- 消息下方：操作栏费用标签 + 轮次摘要行 ----------
// The host passes `messageId` to assistant-actions and the turn to turnTail; the standard slot props carry `sessionId`.
// Both adapters render nothing when the session, message or turn cannot be matched to logged calls.

slots.inject('conversation.chat.assistant-actions', () => slots.register(
  { name: 'conversation.chat.assistant-actions', id: 'cost-meter', order: 20, label: () => t('msgChipShow'), locale: NS },
  CostChip,
))
slots.inject('conversation.chat.turnTail', () => slots.register(
  { name: 'conversation.chat.turnTail', id: 'cost-meter', order: 20, label: () => t('msgLineShow'), locale: NS },
  CostTurnLine,
))

// ---------- 右侧栏页签：当前会话各模型的实时费用 ----------
// The host's right sidebar takes page types from plugins: a static type declaration, plus a body registered under
// `sidebar.right.pane.tab` with the type's id as key. Both services are optional (`ctx.inject` keeps this part
// inactive on hosts without them), and any failure here leaves the dock, the message labels and the pages untouched.
// The page is opened from the guide card of the "+" control, or from the link in the dock's model popover.

const CostPanelIcon = (props) => uiIcon('panel', props && props.size ? props.size : 20)

if (typeof ctx.inject === 'function') {
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    try {
      const host = scope.slots || slots
      const effect = typeof scope.effect === 'function' ? scope.effect.bind(scope) : ctx.effect
      effect(() => scope.sidebarRightTabs.register({
        id: SIDE_ID,
        kind: SIDE_KIND,
        title: () => t('sideTitle'),
        guide: [{ id: 'open', order: 40, title: () => t('sideTitle'), description: () => t('sideGuide'), icon: CostPanelIcon }],
      }), 'dsh-cost-meter: side tab type')
      effect(() => host.inject('sidebar.right.pane.tab', () => host.register(
        { name: 'sidebar.right.pane.tab', key: SIDE_ID, locale: NS, inject: () => ({}) },
        SideCostTab,
      )), 'dsh-cost-meter: side tab body')
      effect(() => {
        setSideRight(scope.sidebarRight)
        return () => setSideRight(null)
      }, 'dsh-cost-meter: side tab opener')
    } catch { /* this host cannot dock a page */ }
  })
}

// ---------- 设置页 ----------

slots.inject('settings.section', () => slots.register(
  { name: 'settings.section', id: 'cost-meter', order: 31, label: () => t('title'), locale: NS },
  SettingsPage,
))

// ---------- 左侧栏入口（可在设置里关闭） ----------
// `sidebar.panellist` 登记图标（宿主只传 { size }，图标自己画），同一个 id 作 key 在 `main` 槽登记整页。
// inject() 返回幂等的撤销函数，所以入口可以随偏好开关动态出现 / 消失。
const PANEL_ID = 'cost-meter'
const SIDEBAR_CACHE = NS + ':sidebar'
function registerSidebar() {
  const offIcon = slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('statsTitle'), locale: NS },
    CostPanelIcon,
  ))
  const offMain = slots.inject('main', () => slots.register(
    { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    StatsMainPage,
  ))
  return () => { offIcon(); offMain() }
}

// The last known switch is cached so a hidden entry does not flash back in before the first snapshot arrives.
function readCachedSidebar() {
  try { return window.localStorage.getItem(SIDEBAR_CACHE) !== '0' } catch { return true }
}
function writeCachedSidebar(on) {
  try { window.localStorage.setItem(SIDEBAR_CACHE, on ? '1' : '0') } catch { /* storage may be blocked */ }
}

let disposeSidebar = null
function syncSidebar(show) {
  if (show && !disposeSidebar) disposeSidebar = registerSidebar()
  else if (!show && disposeSidebar) { disposeSidebar(); disposeSidebar = null }
}

syncSidebar(readCachedSidebar())
ctx.effect(() => {
  const off = store.subscribe(() => {
    const prefs = store.state.snap && store.state.snap.prefs
    if (!prefs) return
    writeCachedSidebar(prefs.sidebar !== false)
    syncSidebar(prefs.sidebar !== false)
  })
  return () => {
    off()
    if (disposeSidebar) { disposeSidebar(); disposeSidebar = null }
  }
})
