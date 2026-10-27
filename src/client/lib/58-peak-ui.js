// Peak / off-peak status as the user sees it: a small item in the dock strip, a block on the right-sidebar page and the
// settings section that switches them. The numbers come from 84-peak.js; this file formats and draws, and owns the clock
// that keeps the countdown moving (only while one of these is on screen).

const PEAK_TICK_MS = 15000
const PEAK_MODELS_SHOWN = 4

// A DeepSeek-like schedule for the style previews in the settings page (the status itself follows the real clock).
const PREVIEW_PEAK = {
  key: 'preview',
  peak: { enabled: true, weekdaysOnly: true, windows: [{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }] },
  models: ['deepseek-flash'],
  multiplier: 2,
}

/** The current time, refreshed every `ms` while the caller is mounted. */
function useNow(ms) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Words, colour and icon for a state; the countdown rides along only when asked for and when the state ever flips. */
function peakLook(state, now, countdown) {
  const left = countdown && state.changeAt !== null
    ? ' · ' + t(state.peak ? 'peakLeftPeak' : 'peakLeftValley', { time: formatCountdown(state.changeAt - now) })
    : ''
  return {
    text: t(state.peak ? 'peakNowPeak' : 'peakNowValley') + left,
    color: state.peak ? LIGHT.yellow : LIGHT.green,
    icon: state.peak ? 'peak' : 'valley',
  }
}

/** Detail lines for a tooltip or the sidebar block: hours (local and UTC), weekdays, price ratio, models, billing rule. */
function peakDetailLines(schedule, now) {
  const offset = -new Date(now).getTimezoneOffset()
  const lines = [t('peakTipWindows', { local: windowsText(schedule.peak, offset), utc: windowsText(schedule.peak, 0) })]
  if (schedule.peak.weekdaysOnly !== false) lines.push(t('peakWeekdays') + ' (UTC)')
  if (schedule.multiplier !== null) lines.push(t('peakTipRate', { x: Number(schedule.multiplier.toFixed(2)) }))
  const extra = schedule.models.length - PEAK_MODELS_SHOWN
  lines.push(t('peakTipModels', { models: schedule.models.slice(0, PEAK_MODELS_SHOWN).join(', ') + (extra > 0 ? ' +' + extra : '') }))
  lines.push(t('peakTipNote'))
  return lines
}

/** The state icon in its colour. */
const peakIcon = (look, size) => h('span', { style: { color: look.color, display: 'inline-flex', flex: '0 0 auto' } }, uiIcon(look.icon, size))

/** Dock strip item: peak or off-peak right now, and (when switched on) how long until that flips. `item` is the strip's item style. */
function PeakBadge(props) {
  const { schedule, prefs, item } = props
  const now = useNow(PEAK_TICK_MS)
  const state = peakState(schedule.peak, now)
  const look = peakLook(state, now, prefs.peakCountdown)
  const title = [peakLook(state, now, true).text].concat(peakDetailLines(schedule, now)).join('\n')
  return h('span', { style: item, title }, peakIcon(look, 13), h('span', null, look.text))
}

/** Peak hours in local time on one line; the UTC hours the vendor publishes are in the tooltip. */
function peakHoursLine(schedule, now) {
  const offset = -new Date(now).getTimezoneOffset()
  return {
    text: t('peakWindowsShort', { local: windowsText(schedule.peak, offset) }),
    title: t('peakTipWindows', { local: windowsText(schedule.peak, offset), utc: windowsText(schedule.peak, 0) }),
  }
}

/**
 * One schedule as a block on the right-sidebar page and in the settings: the state in words (with the countdown when
 * `countdown`), then the peak hours; `detail` adds weekdays, price ratio, models and the billing rule.
 */
function PeakBlock(props) {
  const { schedule, countdown, detail } = props
  const now = useNow(PEAK_TICK_MS)
  const look = peakLook(peakState(schedule.peak, now), now, countdown)
  const note = { fontSize: 11, lineHeight: '16px', color: TERTIARY }
  const hours = peakHoursLine(schedule, now)
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, lineHeight: '20px', color: PRIMARY } }, peakIcon(look, 15), h('span', null, look.text)),
    detail
      ? peakDetailLines(schedule, now).map((line, i) => h('div', { key: i, style: note }, line))
      : h('div', { style: note, title: hours.title }, hours.text))
}

/** Settings → what to show and where; below it the status as it is right now. */
function PeakSettings(props) {
  const prefs = usePrefs()
  const set = (change) => store.setPrefs(change)
  const schedules = allPeakSchedules(props.snap)
  return h('div', null,
    settingRow({ key: 'peakDock' }, t('peakDockShow'), t('peakDockShowHint'), toggle(prefs.dockPeak, (on) => set({ dockPeak: on }), t('peakDockShow'))),
    // The strip's countdown only matters while the strip item is shown.
    h('div', { key: 'peakCountdownBox', style: { opacity: prefs.dockPeak ? 1 : 0.45, pointerEvents: prefs.dockPeak ? 'auto' : 'none' } },
      settingRow({ key: 'peakCountdown' }, t('peakCountdownShow'), t('peakCountdownShowHint'), toggle(prefs.peakCountdown, (on) => set({ peakCountdown: on }), t('peakCountdownShow')))),
    settingRow({ key: 'peakSide' }, t('peakSideShow'), t('peakSideShowHint'), toggle(prefs.sidePeak, (on) => set({ sidePeak: on }), t('peakSideShow'))),
    h('div', { key: 'peakDetailBox', style: { opacity: prefs.sidePeak ? 1 : 0.45, pointerEvents: prefs.sidePeak ? 'auto' : 'none' } },
      settingRow({ key: 'peakDetail' }, t('peakSideDetailShow'), t('peakSideDetailShowHint'), toggle(prefs.sidePeakDetail, (on) => set({ sidePeakDetail: on }), t('peakSideDetailShow')))),
    h('div', { style: { padding: '18px 0', borderBottom: BORDER, display: 'flex', flexDirection: 'column', gap: 12 } },
      h('div', { style: ui.title }, t('peakStatusTitle')),
      schedules.length === 0
        ? h('div', { style: ui.desc }, t('peakNone'))
        : schedules.map((schedule) => h(PeakBlock, { key: schedule.key, schedule, countdown: true, detail: true }))))
}
