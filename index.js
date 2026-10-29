/**
 * dsh-cost-meter — Host half.
 *
 * 按会话、按模型统计 token 与费用。费用在每次调用开始时按**当时的单价**（含峰谷）
 * 算好并累加（写时锁定）：之后改价只影响新的调用，不回算历史账单。
 *
 * 峰谷：每个模型可单独设置峰时段的单价与时间窗口（UTC，最多两段，可限定工作日）。
 * 调用开始时落在峰时段内则整次调用按峰价计，峰价某项留空则沿用正常价。
 *
 * 上下文分档：每个模型可设多档「prompt 超过 N tokens」的单价，调用结束拿到 usage 后
 * 按本次上下文长度选档，整次请求按该档计价（规则见 pricing.js；峰价 > 分档价 > 基础价）。
 *
 * 预算：会话预算（货币 + 金额），由 client 半部据此显示红绿灯。
 *
 * 按天统计：每次调用同时累加到「本地日期 × 模型」的桶（daily.js，保留 90 天），
 * 供侧边栏统计页画图；显示偏好（prefs.js）也存在这里，所有窗口保持一致。
 *
 * 数据通道：llm/stream 瀑布流收集 usage；webServer 注册 /__cost-meter 路由
 * （GET 快照 / POST 操作）。持久化：$DSH_HOME/cost-meter.json（临时文件 + rename）。
 *
 * 口径假设：usage.inputTokens 为未命中缓存的输入 token，缓存命中与写入分别计价。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { isLoopbackRequest, parseJsonRequest } from './route-security.js'
import { PRESET_PRICES, presetFor } from './presets.js'
import { PRICE_FIELDS, mergeUsage, num, parsePeak, parseTiers, priceCall } from './pricing.js'
import { DAILY_KEEP_DAYS, dayKey, firstDay, hourOf, pruneDaily } from './daily.js'
import { DEFAULT_PREFS, sanitizePrefs } from './prefs.js'
import { LATENCY_BOUNDS_MS, addTiming, pushSlowest, sanitizeSlowest } from './timing.js'
import { appendCall, appendMessage, sanitizeCallLog } from './calllog.js'
import { createHistoryService, freshHistory, legacyFirstLiveAt, migrateSessions, sanitizeHistory } from './history.js'
import { createCatalogService } from './catalog.js'
import { createCatalogActions } from './catalog-apply.js'
import { createBalanceService } from './balance.js'
import { MEDIA_TEMPLATES, argsOf, compileRules, matchRule, modelOf, observeTool, quantityOf, sanitizeObserved, sanitizeRules } from './media.js'

export const name = 'dsh-cost-meter'
// webServer 由 web 组合提供；声明为硬依赖，路由随插件生命周期建立与清理。
export const inject = ['webServer']

const API = '/__cost-meter'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'cost-meter.json')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const CATALOG_FILE = join(DSH_HOME, 'cost-meter.catalog.json')
// Provider API keys live here and nowhere else (owner-only file, see balance.js).
const BALANCE_FILE = join(DSH_HOME, 'cost-meter.balance.json')
const PERSIST_DELAY_MS = 1500
const MAX_SESSIONS = 200
const STARTUP_SCAN_DELAY_MS = 4000
const CATALOG_FIRST_TICK_MS = 8000
const CATALOG_TICK_MS = 3_600_000
const BALANCE_FIRST_TICK_MS = 12_000
const BALANCE_TICK_MS = 600_000

function emptyState() {
  return { prices: {}, models: {}, sessions: {}, daily: {}, hourly: {}, slowest: [], callLog: {}, media: { rules: [], observed: {} }, budget: { currency: 'CNY', amount: 0 }, prefs: { ...DEFAULT_PREFS }, history: freshHistory() }
}

/**
 * Hourly buckets are keyed day -> hour -> model since 0.7.0 so the usage-time charts can follow the model filter.
 * The 0.6.x shape was day -> hour -> { calls, tokens }; those slots are kept under the model id "unknown".
 */
function migrateHourly(raw) {
  if (!raw || typeof raw !== 'object') return {}
  for (const day of Object.values(raw)) {
    if (!day || typeof day !== 'object') continue
    for (const [hour, slot] of Object.entries(day)) {
      if (slot && typeof slot.calls === 'number' && typeof slot.tokens === 'number') day[hour] = { unknown: slot }
    }
  }
  return raw
}

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
    const daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {}
    migrateSessions(sessions)
    return {
      prices: raw.prices && typeof raw.prices === 'object' ? raw.prices : {},
      models: raw.models && typeof raw.models === 'object' ? raw.models : {},
      sessions,
      // Older state files (before 0.6.0) have no per-day / per-hour buckets; they start empty.
      daily,
      hourly: migrateHourly(raw.hourly),
      slowest: sanitizeSlowest(raw.slowest),
      callLog: sanitizeCallLog(raw.callLog),
      media: {
        rules: sanitizeRules(raw.media && raw.media.rules),
        observed: sanitizeObserved(raw.media && raw.media.observed),
      },
      budget: raw.budget && typeof raw.budget === 'object' ? raw.budget : { currency: 'CNY', amount: 0 },
      prefs: sanitizePrefs(raw.prefs),
      history: sanitizeHistory(raw.history, legacyFirstLiveAt(sessions, daily)),
    }
  } catch {
    return emptyState()
  }
}

function newCounter() {
  return { calls: 0, failed: 0, unpriced: 0, peakCalls: 0, tierCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costs: {} }
}

function addCost(bucket, currency, amount) {
  bucket.costs[currency] = (bucket.costs[currency] || 0) + amount
}

/**
 * Per-currency [input, output, cache read, cache write] cost, accumulated next to `costs`. Counters booked before this
 * field existed have none, so the browser only trusts it when its sum matches `costs` (see 51-item-costs.js).
 */
function addParts(bucket, currency, parts) {
  const by = bucket.parts || (bucket.parts = {})
  const row = by[currency] || (by[currency] = [0, 0, 0, 0])
  for (let i = 0; i < 4; i += 1) row[i] += parts[i]
}

export function apply(ctx) {
  const state = loadState()
  const { prices, models, sessions, daily, hourly } = state
  let persistTimer = null
  let scanTimer = null
  let catalogTimers = []
  let balanceTimers = []
  // Bumped on every logged call so the browser half knows when to refetch a session's call log.
  // Seeded from the clock so a restarted Host never repeats a value the browser has already cached.
  let callSeq = Date.now()
  let disposed = false

  // ---------- 持久化 ----------

  function persistNow() {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true })
      const tmp = STATE_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(state))
      renameSync(tmp, STATE_FILE)
    } catch {
      // 写盘失败不影响统计；下次变更会重试。
    }
  }

  function schedulePersist() {
    if (disposed || persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, PERSIST_DELAY_MS)
    persistTimer.unref?.()
  }

  // ---------- 计费 ----------

  /** 生效单价：用户自定义（prices）优先，否则用内置预置；都没有返回 undefined。 */
  function effectivePrice(model) {
    return prices[model] || presetFor(model)
  }

  /** 按调用开始时刻与本次上下文长度算费用（峰价 > 分档价 > 基础价）；没有生效单价返回 null。 */
  function priceUsage(model, usage, atMs) {
    const price = effectivePrice(model)
    return price ? priceCall(price, usage, atMs) : null
  }

  function trimSessions() {
    const keys = Object.keys(sessions)
    if (keys.length <= MAX_SESSIONS) return
    keys
      .sort((a, b) => (sessions[a].updatedAt || 0) - (sessions[b].updatedAt || 0))
      .slice(0, keys.length - MAX_SESSIONS)
      .forEach((key) => { delete sessions[key] })
  }

  /** Counter of one model on the local calendar day the call started. */
  function dailyBucket(model, atMs) {
    const key = dayKey(atMs)
    const day = daily[key] || (daily[key] = {})
    return day[model] || (day[model] = newCounter())
  }

  /** Calls and tokens per local hour of day and model, for the usage-time charts (no cost: it could not be backfilled). */
  function recordHour(atMs, model, usage) {
    const key = dayKey(atMs)
    const day = hourly[key] || (hourly[key] = {})
    const hour = day[hourOf(atMs)] || (day[hourOf(atMs)] = {})
    const slot = hour[model] || (hour[model] = { calls: 0, tokens: 0 })
    slot.calls += 1
    if (usage) {
      slot.tokens += (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
    }
    pruneDaily(hourly, atMs)
  }

  /** The plugin has now metered something live for this session (and overall): history imports must stop short of it. */
  function markLive(sessionEntry, atMs) {
    if (sessionEntry && !Number.isFinite(sessionEntry.liveAt)) sessionEntry.liveAt = atMs
    if (state.history.firstLiveAt === null) state.history.firstLiveAt = atMs
  }

  /**
   * `timing` = { durationMs, ttftMs } measured by the llm/stream wrapper. Only calls that ended with a usage chunk
   * feed the latency statistics (aborted or failed streams would skew averages); every call can enter the slowest list.
   * `past` = { end, messageId } books a call read from a session log by the history import: it has no timing, its
   * session keeps the plugin's own first-record time (`liveAt`) untouched, and days outside the retention window get no bucket.
   * Returns the price that was applied (or null).
   */
  function recordCall(model, sessionId, usage, startedAt, timing, turn, past) {
    const now = Date.now()
    const dated = !past || startedAt >= now - (DAILY_KEEP_DAYS - 1) * 86_400_000
    if (dated) recordHour(startedAt, model, usage)
    const modelEntry = models[model] || (models[model] = newCounter())
    const sessionEntry = sessionId
      ? (sessions[sessionId] || (sessions[sessionId] = { firstAt: past ? startedAt : now, liveAt: null, updatedAt: 0, models: {}, costs: {} }))
      : null
    if (past) { if (sessionEntry) sessionEntry.firstAt = Math.min(Number.isFinite(sessionEntry.firstAt) ? sessionEntry.firstAt : startedAt, startedAt) } else markLive(sessionEntry, startedAt)
    const sessionModel = sessionEntry
      ? (sessionEntry.models[model] || (sessionEntry.models[model] = newCounter()))
      : null
    const buckets = sessionModel ? [modelEntry, sessionModel] : [modelEntry]
    if (dated) {
      buckets.push(dailyBucket(model, startedAt))
      pruneDaily(daily, startedAt)
    }

    for (const bucket of buckets) bucket.calls += 1
    if (sessionEntry) sessionEntry.updatedAt = past ? Math.max(sessionEntry.updatedAt || 0, past.end) : now

    if (timing) {
      state.slowest = pushSlowest(state.slowest, {
        at: startedAt,
        model,
        session: sessionId,
        durationMs: Math.round(timing.durationMs),
        ttftMs: timing.ttftMs === null ? null : Math.round(timing.ttftMs),
        input: usage ? (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) : 0,
        output: usage ? usage.outputTokens || 0 : 0,
        ok: Boolean(usage),
      }, startedAt - DAILY_KEEP_DAYS * 86_400_000)
    }

    if (!usage) {
      // 结束但没有 usage：error / aborted 的调用计为失败，保证每次调用都被记录。
      for (const bucket of buckets) bucket.failed += 1
      logCall(sessionId, turn, startedAt, model, null, null, timing)
      schedulePersist()
      return null
    }
    if (timing) {
      const sample = { ...timing, outputTokens: usage.outputTokens || 0 }
      addTiming(modelEntry, sample)
      addTiming(buckets[buckets.length - 1], sample)
    }

    const priced = priceUsage(model, usage, startedAt)
    for (const bucket of buckets) {
      bucket.inputTokens += usage.inputTokens || 0
      bucket.outputTokens += usage.outputTokens || 0
      bucket.cacheReadTokens += usage.cacheReadTokens || 0
      bucket.cacheWriteTokens += usage.cacheWriteTokens || 0
      if (priced) {
        addCost(bucket, priced.currency, priced.amount)
        addParts(bucket, priced.currency, priced.parts)
        if (priced.peak) bucket.peakCalls += 1
        // 旧状态文件里的桶没有 tierCalls 字段，不能直接 += 1。
        if (priced.tier) bucket.tierCalls = (bucket.tierCalls || 0) + 1
      } else {
        bucket.unpriced += 1
      }
    }
    if (priced && sessionEntry) addCost(sessionEntry, priced.currency, priced.amount)
    logCall(sessionId, turn, startedAt, model, usage, priced, timing, past ? { end: past.end } : undefined)
    if (past && sessionId && past.messageId) appendMessage(state.callLog, sessionId, past.messageId, turn, past.end)
    trimSessions()
    schedulePersist()
    return priced
  }

  /** Remember the finished call for per-message labels (see calllog.js). Calls without a session cannot be attributed. */
  function logCall(sessionId, turn, startedAt, model, usage, priced, timing, extra) {
    callSeq += 1
    if (!sessionId) return
    const end = timing && Number.isFinite(timing.durationMs) ? startedAt + Math.round(timing.durationMs) : Date.now()
    appendCall(state.callLog, sessionId, Object.assign({
      at: startedAt, end, turn: turn === undefined ? null : turn, model, ok: Boolean(usage),
      cost: priced ? priced.amount : null, currency: priced ? priced.currency : '', parts: priced ? priced.parts : null,
      input: usage ? usage.inputTokens || 0 : 0, output: usage ? usage.outputTokens || 0 : 0,
      cacheRead: usage ? usage.cacheReadTokens || 0 : 0, cacheWrite: usage ? usage.cacheWriteTokens || 0 : 0,
      ttftMs: timing && timing.ttftMs !== null && timing.ttftMs !== undefined ? Math.round(timing.ttftMs) : null,
    }, extra))
  }

  // ---------- Turn attribution (host session/event stream) ----------

  // The turn in progress per session. A model call is stamped with the turn open when it starts: the stream may end
  // after the turn/end event, and the host's llm/stream options carry no turn id.
  const openTurns = new Map()

  function onSessionEvent(session, event) {
    if (!session || !event || typeof event.type !== 'string') return
    const id = String(session.id)
    const data = event.data || {}
    if (event.type === 'turn/start') {
      if (Number.isInteger(data.turn)) openTurns.set(id, data.turn)
    } else if (event.type === 'turn/end') {
      if (openTurns.get(id) === data.turn) openTurns.delete(id)
    } else if (event.type === 'assistant/message') {
      // The id of the message the chat shows (its action row receives it) maps to the turn whose calls are summed.
      if (data.message && typeof data.message.id === 'string') {
        appendMessage(state.callLog, id, data.message.id, data.turn, Date.now())
        callSeq += 1
        schedulePersist()
      }
    }
  }

  // ---------- Experimental media metering (tool calls: images, speech) ----------

  let mediaRules = compileRules(state.media.rules)

  /**
   * Book one finished media tool call under `model`. Counters reuse the token buckets (calls / failed / costs), plus
   * `units` (images, 1K characters or minutes) and `media` (the kind, so the client can label the units).
   */
  function recordMedia(rule, model, sessionId, call) {
    const atMs = Date.now()
    recordHour(atMs, model, null)
    const modelEntry = models[model] || (models[model] = newCounter())
    const sessionEntry = sessionId
      ? (sessions[sessionId] || (sessions[sessionId] = { firstAt: atMs, liveAt: null, updatedAt: 0, models: {}, costs: {} }))
      : null
    markLive(sessionEntry, atMs)
    const sessionModel = sessionEntry ? (sessionEntry.models[model] || (sessionEntry.models[model] = newCounter())) : null
    const buckets = sessionModel ? [modelEntry, sessionModel] : [modelEntry]
    buckets.push(dailyBucket(model, atMs))
    pruneDaily(daily, atMs)
    for (const bucket of buckets) {
      bucket.media = rule.kind
      bucket.calls += 1
      if (call.failed) { bucket.failed += 1; continue }
      bucket.units = (bucket.units || 0) + call.qty
      if (call.priced) addCost(bucket, rule.currency, call.cost)
      else bucket.unpriced += 1
    }
    if (sessionEntry) {
      sessionEntry.updatedAt = atMs
      if (!call.failed && call.priced) addCost(sessionEntry, rule.currency, call.cost)
    }
    // A media tool call inside a turn adds to that turn's cost; its duration is not measured (start = end).
    logCall(sessionId, sessionId ? openTurns.get(sessionId) : null, atMs, model, null, call.priced && !call.failed ? { amount: call.cost, currency: rule.currency } : null, null,
      { ok: !call.failed, media: rule.kind, units: call.failed ? 0 : call.qty })
    trimSessions()
    schedulePersist()
  }

  /** `tools/result` listener. It must never throw into the host's tool pipeline. */
  function onToolResult(exec, result) {
    if (!state.prefs.mediaMeter || !exec || typeof exec.name !== 'string') return
    try {
      const args = argsOf(exec.arguments)
      observeTool(state.media.observed, exec.name, args, Date.now())
      schedulePersist()
      const rule = matchRule(mediaRules, exec.name, args)
      if (!rule) return
      const failed = Boolean(result && result.isError)
      const { qty, known } = quantityOf(rule, args)
      const priced = known && rule.price > 0
      const sessionId = exec.agent && exec.agent.session && exec.agent.session.id ? String(exec.agent.session.id) : null
      recordMedia(rule, modelOf(rule, args), sessionId, { failed, qty, priced, cost: priced ? qty * rule.price : 0 })
    } catch {
      // Metering is best effort: a malformed tool event must not affect the tool call itself.
    }
  }

  /** Observed tools for the settings page, newest first. */
  function observedList() {
    const observed = state.media.observed
    return Object.keys(observed).sort((a, b) => observed[b].last - observed[a].last)
      .map((name) => ({ name, calls: observed[name].calls, last: observed[name].last, argKeys: observed[name].argKeys, modelArg: observed[name].modelArg || '', models: observed[name].models || [] }))
  }

  // ---------- 历史导入（读 DSH 自己的会话日志，见 history.js） ----------

  const history = createHistoryService({
    root: SESSIONS_ROOT,
    state,
    sessions,
    price: (model, usage, atMs) => priceUsage(model, usage, atMs),
    book: (sessionId, call) => recordCall(call.model, sessionId, call.usage, call.at, null, call.turn, { end: call.end, messageId: call.messageId }),
    persistNow,
    stateFile: STATE_FILE,
  })

  // ---------- OpenRouter 价格目录（见 catalog.js / catalog-apply.js） ----------

  const catalogActions = createCatalogActions({
    catalog: createCatalogService({ file: CATALOG_FILE }),
    prices,
    models,
    effectivePrice,
    backfill: backfillUnpriced,
    persist: schedulePersist,
  })

  /** The opt-in routine: only runs while the preference is on; failures are visible in the snapshot's catalog.error. */
  const catalogTick = () => {
    if (disposed || !state.prefs.catalogAuto) return
    catalogActions.auto().catch(() => {})
  }

  // ---------- 账户余额（见 balance.js；密钥只在 balance 服务内部） ----------

  const balance = createBalanceService({ file: BALANCE_FILE })

  /** The opt-in timer: only runs while the preference is on, and skips accounts asked a few minutes ago. */
  const balanceTick = () => {
    if (disposed || !state.prefs.balanceAuto) return
    balance.refreshAll(true).catch(() => {})
  }

  // ---------- 快照与操作 ----------

  function snapshot() {
    return {
      ok: true, prices, presets: PRESET_PRICES, models, sessions, budget: state.budget, prefs: state.prefs,
      media: { rules: state.media.rules, templates: MEDIA_TEMPLATES, observed: observedList() },
      history: history.snapshot(),
      catalog: catalogActions.snapshot(),
      balance: balance.snapshot(),
      callSeq, serverTime: Date.now(),
    }
  }

  /** Per-day buckets for the statistics page; kept out of the polled snapshot because of their size. */
  function statsView() {
    const now = Date.now()
    return {
      ok: true, daily, hourly, slowest: state.slowest, latencyBounds: LATENCY_BOUNDS_MS,
      today: dayKey(now), since: firstDay(daily), keepDays: DAILY_KEEP_DAYS, serverTime: now,
    }
  }

  /**
   * 为某模型此前的「未计价」调用补算费用。
   *
   * 调用发生时还没配价，费用被记成 0；配置价格后按基础价（不含峰价与上下文分档价）
   * 从已累计的 token 数补算，并把 unpriced 清零，避免重复补算。峰时段与长上下文的
   * 调用无法事后区分，因此补算金额是偏低估计。返回补算的调用次数。
   */
  function backfillUnpriced(model, price) {
    const currency = String(price.currency || 'USD')
    const amountOf = (bucket) => (
      bucket.inputTokens * num(price.input)
      + bucket.outputTokens * num(price.output)
      + bucket.cacheReadTokens * num(price.cacheRead)
      + bucket.cacheWriteTokens * num(price.cacheWrite)
    ) / 1_000_000
    // 只补算此前被记为未计价的那部分调用：整桶 token 里也含已计价的调用，
    // 因此按「未计价次数 / 带 usage 的调用次数」折算，避免把已计价的部分重复计费。
    // 失败调用没有 usage、也不产生 token，不能算进分母，否则会把补算金额稀释。
    const shareOf = (bucket) => {
      const withUsage = bucket.calls - (bucket.failed || 0)
      return withUsage > 0 ? Math.min(1, bucket.unpriced / withUsage) : 0
    }

    let calls = 0
    const patch = (bucket) => {
      if (!bucket || !bucket.unpriced || bucket.unpriced <= 0) return 0
      const amount = amountOf(bucket) * shareOf(bucket)
      if (amount > 0) addCost(bucket, currency, amount)
      calls += bucket.unpriced
      bucket.unpriced = 0
      return amount
    }

    patch(models[model])
    // 模型维度的次数就是真实补算次数；会话维度只补费用，不再重复计数。
    const backfilled = calls
    calls = 0
    for (const session of Object.values(sessions)) {
      const bucket = session.models && session.models[model]
      if (!bucket) continue
      const amount = patch(bucket)
      if (amount > 0) addCost(session, currency, amount)
      session.updatedAt = Date.now()
    }
    // Per-day buckets hold their own unpriced counts, so the statistics page agrees with the totals.
    for (const day of Object.values(daily)) patch(day[model])
    return backfilled
  }

  function handleAction(body) {
    const action = body && body.action
    switch (action) {
      case 'set-price': {
        const model = String((body && body.model) || '').trim()
        if (!model) return { ok: false, error: 'missing model' }
        const currency = String(body.currency || 'USD').trim().toUpperCase().slice(0, 3) || 'USD'
        const next = { currency }
        for (const field of PRICE_FIELDS) next[field] = num(body[field])
        const peak = parsePeak(body.peak)
        if (peak) next.peak = peak
        const tiers = parseTiers(body.tiers)
        if (tiers.length > 0) next.tiers = tiers
        prices[model] = next
        const backfilled = backfillUnpriced(model, next)
        schedulePersist()
        return { ok: true, backfilled }
      }
      case 'remove-price': {
        delete prices[String((body && body.model) || '')]
        schedulePersist()
        return { ok: true }
      }
      case 'set-budget': {
        const currency = String(body.currency || 'CNY').trim().toUpperCase().slice(0, 3) || 'CNY'
        state.budget = { currency, amount: num(body.amount) }
        schedulePersist()
        return { ok: true }
      }
      case 'reset-totals': {
        for (const key of Object.keys(models)) delete models[key]
        for (const key of Object.keys(sessions)) delete sessions[key]
        for (const key of Object.keys(daily)) delete daily[key]
        for (const key of Object.keys(hourly)) delete hourly[key]
        state.slowest = []
        state.callLog = {}
        history.reset()
        schedulePersist()
        return { ok: true }
      }
      case 'history-scan':
        return history.scan().then(() => ({ ok: true, code: 'ok', history: history.snapshot() }))
      case 'history-import':
        return history.importAll().then((result) => Object.assign({}, result, { history: history.snapshot() }))
      case 'history-dismiss':
        history.dismiss()
        schedulePersist()
        return { ok: true, code: 'ok', history: history.snapshot() }
      case 'stats':
        return statsView()
      case 'calls': {
        // Recent calls of one session, for the per-message cost labels in the chat.
        const id = String((body && body.sessionId) || '')
        const log = state.callLog[id]
        return { ok: true, calls: log ? log.calls : [], msgs: log ? log.msgs : {}, callSeq, serverTime: Date.now() }
      }
      case 'set-media-rules': {
        state.media.rules = sanitizeRules(body.rules)
        mediaRules = compileRules(state.media.rules)
        schedulePersist()
        return { ok: true, rules: state.media.rules }
      }
      case 'clear-observed': {
        state.media.observed = {}
        schedulePersist()
        return { ok: true }
      }
      case 'set-prefs': {
        // Partial update: only the keys present in body.prefs change.
        const before = state.prefs
        state.prefs = sanitizePrefs(body.prefs, state.prefs)
        schedulePersist()
        // Switching an opt-in routine on starts it right away instead of waiting for the next check.
        if (!before.catalogAuto && state.prefs.catalogAuto) setTimeout(catalogTick, 0).unref?.()
        if (!before.balanceAuto && state.prefs.balanceAuto) setTimeout(balanceTick, 0).unref?.()
        return { ok: true, prefs: state.prefs }
      }
      default: {
        const out = catalogActions.handle(body) || balance.handle(body)
        return out !== null ? out : { ok: false, error: 'unknown action: ' + String(action) }
      }
    }
  }

  // ---------- 启动补算：有单价却仍标着「未计价」的历史调用 ----------
  //
  // 典型情况：某模型的调用先发生（当时既无自定义价也无预置价），之后插件版本
  // 更新带来了该模型的预置价——这些历史调用不会自动变成已计价，界面上会一直
  // 挂着「未配价」。这里在加载状态后按当前生效单价补算一次，补完 unpriced 清零，
  // 因此是幂等的，不会重复计费。
  (function backfillPricedOnLoad() {
    let changed = false
    for (const model of Object.keys(models)) {
      const bucket = models[model]
      // Media buckets have no token counts to price; their unpriced calls stay as recorded.
      if (!bucket || bucket.media || !bucket.unpriced || bucket.unpriced <= 0) continue
      const price = effectivePrice(model)
      if (!price) continue
      backfillUnpriced(model, price)
      changed = true
    }
    if (changed) schedulePersist()
  })()

  // While the "import history?" question is open, look for importable calls a moment after start so the prompt can appear.
  if (state.history.prompt === 'pending') {
    scanTimer = setTimeout(() => { history.scan().catch(() => {}) }, STARTUP_SCAN_DELAY_MS)
    scanTimer.unref?.()
  }

  catalogTimers = [setTimeout(catalogTick, CATALOG_FIRST_TICK_MS), setInterval(catalogTick, CATALOG_TICK_MS)]
  for (const timer of catalogTimers) timer.unref?.()
  balanceTimers = [setTimeout(balanceTick, BALANCE_FIRST_TICK_MS), setInterval(balanceTick, BALANCE_TICK_MS)]
  for (const timer of balanceTimers) timer.unref?.()

  // ---------- 钩子与路由 ----------

  ctx.on('llm/stream', (options, next) => {
    const model = String(options.model || 'unknown')
    const sessionId = options.sessionId !== undefined && options.sessionId !== null ? String(options.sessionId) : null
    const startedAt = Date.now()
    const turn = sessionId !== null && openTurns.has(sessionId) ? openTurns.get(sessionId) : null
    const upstream = next()
    return (async function* wrapped() {
      let usage = null
      let firstContentAt = null
      const t0 = performance.now()
      try {
        for await (const chunk of upstream) {
          if (chunk.type === 'usage') usage = mergeUsage(usage, chunk.usage)
          // Time-to-first-token is the first streamed content delta (text, reasoning or tool-call arguments).
          else if (firstContentAt === null && (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta')) firstContentAt = performance.now()
          yield chunk
        }
      } finally {
        const end = performance.now()
        recordCall(model, sessionId, usage, startedAt, {
          durationMs: end - t0,
          ttftMs: firstContentAt === null ? null : firstContentAt - t0,
        }, turn)
      }
    })()
  })

  ctx.on('tools/result', onToolResult)
  ctx.on('session/event', (session, event) => {
    // Observation only: it must never throw into the host's event pipeline.
    try { onSessionEvent(session, event) } catch { /* best effort */ }
  })

  function sendJson(res, data, status) {
    const text = JSON.stringify(data)
    res.statusCode = status || 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', Buffer.byteLength(text))
    res.end(text)
  }

  const webServer = ctx.webServer
  const disposers = []
  if (webServer !== undefined) {
    disposers.push(webServer.register({
      kind: 'exact',
      path: API,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) {
          sendJson(res, { ok: false, error: 'loopback access required' }, 403)
          return
        }
        if (req.method === 'GET') {
          sendJson(res, snapshot())
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        return parseJsonRequest(req).then((body) => Promise.resolve(handleAction(body))).then((out) => {
          sendJson(res, out)
        }).catch(() => {
          sendJson(res, { ok: false, error: 'bad request' }, 400)
        })
      },
    }))
  }

  ctx.on('dispose', () => {
    disposed = true
    if (scanTimer) clearTimeout(scanTimer)
    for (const timer of catalogTimers) { clearTimeout(timer); clearInterval(timer) }
    for (const timer of balanceTimers) { clearTimeout(timer); clearInterval(timer) }
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    persistNow()
    for (const dispose of disposers) dispose()
  })
}
