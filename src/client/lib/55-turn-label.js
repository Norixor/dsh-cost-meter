// Presentation of one turn's cost under an assistant message: a chip in the action row (hover for details) and a
// summary line above it. The numbers come from summarizeCalls() (88-turn-cost.js); this file only formats and draws.
// The two slot adapters at the bottom resolve a message / turn to its calls and render nothing when anything is missing.

const hitOf = (s) => hitRateValue(s.input, s.cacheRead)

/** Short label for the chip: the cost, else "unpriced" when something finished without a price, else the tokens. */
function turnChipText(s) {
  const cost = formatCosts(s.costs)
  if (cost) return cost
  return s.unpriced > 0 ? t('msgNoCost') : formatTok(turnTokens(s))
}

/** One line of the numbers that matter for a turn: calls, tokens, model time, cost. */
function turnLineText(s) {
  const parts = [t('msgCalls', { n: s.calls }), formatTok(turnTokens(s))]
  if (s.wallMs > 0) parts.push(t('msgModelTime', { time: formatDuration(s.wallMs) }))
  const cost = formatCosts(s.costs)
  parts.push(cost || (s.unpriced > 0 ? t('msgNoCost') : null))
  if (s.failed > 0) parts.push(t('msgFailed', { n: s.failed }))
  return parts.filter(Boolean).join(' · ')
}

/**
 * Look of the chip and the summary line. "plain" (default) is text only like the rest of the action row;
 * "soft" and "outline" turn the chip into a capsule and the line into one block.
 */
function msgTheme(prefs) {
  const text = { color: TERTIARY, fontSize: 12, fontVariantNumeric: 'tabular-nums' }
  if (prefs.msgFont === 'mono') text.fontFamily = MONO_FONT
  let chip = { height: 24, padding: '0 6px', border: 'none', borderRadius: 8, background: 'transparent' }
  let line = { padding: 0 }
  if (prefs.msgStyle === 'soft') {
    chip = { height: 22, padding: '0 10px', border: 'none', borderRadius: 999, background: FILL }
    line = { padding: '3px 10px', borderRadius: 10, background: FILL }
  }
  if (prefs.msgStyle === 'outline') {
    chip = { height: 22, padding: '0 10px', border: '0.5px solid ' + HAIRLINE, borderRadius: 999, background: 'transparent' }
    line = { padding: '3px 10px', borderRadius: 10, border: '0.5px solid ' + HAIRLINE }
  }
  return { text, chip, line }
}

/** Hover card: per-model breakdown, token mix and the caveats of the attribution. */
function TurnDetail(props) {
  const { summary: s } = props
  const row = { display: 'flex', alignItems: 'baseline', gap: 12, justifyContent: 'space-between' }
  const dim = { color: TERTIARY }
  const hit = hitOf(s)
  return h('div', { role: 'tooltip', style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: '18px', color: SECONDARY } },
    h('div', { style: Object.assign({}, row, { color: PRIMARY }) }, h('span', null, t('msgTurn')), h('span', { style: dim }, t('msgCalls', { n: s.calls }))),
    s.models.map((m) => h('div', { key: m.model, style: row },
      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: m.model }, m.model),
      h('span', { style: { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } },
        (unitsText(m) ? unitsText(m) + ' · ' : '') + (formatCosts(m.costs) || '—') + ' · ' + t('tipCalls', { n: m.calls })))),
    h('div', { style: dim }, t('msgInOut', { i: formatTok(s.input + s.cacheRead + s.cacheWrite), o: formatTok(s.output) })
      + (hit !== null ? ' · ' + t('msgCacheHit', { pct: pctText(hit) }) : '')),
    s.wallMs > 0 ? h('div', { style: dim }, t('msgModelTime', { time: formatDuration(s.wallMs) })) : null,
    s.unpriced > 0 ? h('div', null, '! ' + t('msgUnpriced', { n: s.unpriced })) : null,
    s.failed > 0 ? h('div', null, '! ' + t('msgFailed', { n: s.failed })) : null,
    h('div', { style: Object.assign({}, dim, { fontSize: 11, marginTop: 2 }) }, t('msgNote')))
}

/** The chip in the message action row. Opens on hover or focus, closes on leave, blur or Esc. */
function TurnChip(props) {
  const { summary, prefs } = props
  const theme = msgTheme(prefs)
  const [open, setOpen] = React.useState(false)
  const [shift, setShift] = React.useState(0)
  const card = React.useRef(null)
  const close = () => setOpen(false)
  // Keep the card inside the viewport: it is anchored at the chip, which can sit anywhere along a narrow row.
  React.useLayoutEffect(() => {
    if (!open || !card.current) { setShift(0); return }
    const rect = card.current.getBoundingClientRect()
    const base = rect.left - shift
    const room = (document.documentElement.clientWidth || window.innerWidth) - 8
    setShift(rect.width >= room - 8 ? 8 - base : Math.min(0, room - rect.width - base))
  }, [open])
  return h('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' }, onMouseEnter: () => setOpen(true), onMouseLeave: close },
    h('button', {
      type: 'button',
      'aria-label': t('msgTurn') + ' ' + turnChipText(summary),
      'aria-expanded': open,
      onFocus: () => setOpen(true),
      onBlur: close,
      onKeyDown: (e) => { if (e.key === 'Escape') close() },
      style: Object.assign({ fontFamily: 'inherit', whiteSpace: 'nowrap', cursor: 'default' }, theme.text, theme.chip),
    }, turnChipText(summary)),
    open ? h('div', {
      ref: card,
      style: {
        position: 'absolute', left: shift, bottom: 'calc(100% + 4px)', zIndex: 30, width: 'max-content', maxWidth: 'min(320px, 80vw)',
        boxSizing: 'border-box', padding: '10px 12px', borderRadius: 12, border: BORDER, background: PLATFORM, boxShadow: '0 4px 16px rgba(0,0,0,.12)',
      },
    }, h(TurnDetail, { summary })) : null)
}

/** The summary line above the action row. */
function TurnLine(props) {
  const theme = msgTheme(props.prefs)
  return h('div', { style: { padding: '2px 0' }, title: t('msgNote') },
    h('span', { style: Object.assign({ display: 'inline-block', maxWidth: '100%', boxSizing: 'border-box', lineHeight: '18px' }, theme.text, theme.line) }, turnLineText(props.summary)))
}

const sessionKey = (value) => (value === undefined || value === null || value === '' ? null : String(value))

/** Slot `conversation.chat.assistant-actions`: the chip for the turn this assistant message belongs to. */
function CostChip(props) {
  const prefs = usePrefs()
  const log = useCalls(prefs.msgChip ? sessionKey(props.sessionId) : null)
  if (!prefs.msgChip) return null
  const turn = turnOfMessage(log.msgs, props.messageId)
  const calls = turn === null ? [] : callsOfTurn(log.calls, turn)
  return calls.length === 0 ? null : h(TurnChip, { summary: summarizeCalls(calls), prefs })
}

/** Slot `conversation.chat.turnTail`: one summary line for the turn (the prop is the turn number or a view object). */
function CostTurnLine(props) {
  const prefs = usePrefs()
  const log = useCalls(prefs.msgLine ? sessionKey(props.sessionId) : null)
  if (!prefs.msgLine) return null
  const turn = turnNumberOf(props.turn)
  const calls = turn === null ? [] : callsOfTurn(log.calls, turn)
  return calls.length === 0 ? null : h(TurnLine, { summary: summarizeCalls(calls), prefs })
}
