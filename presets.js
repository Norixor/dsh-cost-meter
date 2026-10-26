/**
 * 内置模型预置价（元 / 美元 每百万 tokens）。
 *
 * 数据来源（2026-10-23 核对）：
 *  - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *  - OpenAI:    https://developers.openai.com/api/docs/pricing
 *  - 国产权重（DeepSeek/通义/Kimi/智谱）沿用 model-usage-plugin 0.17.0 的预设值
 *    （MIT 许可），未在本插件内独立核实。
 *
 * 基础价取「标准价 / 短上下文档」。按上下文长度分档的模型在 `tiers` 里给出长上下文档：
 * prompt（未命中缓存的输入 + 缓存读 + 缓存写）严格超过 `above` tokens 时，整次请求按该档计价，
 * 档内某项为 0 则沿用基础价。目前只预置了有官方依据的档位（Claude Haiku 5.5、
 * gpt-6.1-terra、glm-5.1）；其他 OpenAI 模型的 >272K 档尚未逐个核实，需要时在设置页手动加档。
 *
 * 峰谷：DeepSeek 模型预置了官方口径的峰谷价——高峰价为空闲价的 2 倍，
 * 两个高峰窗口为 UTC 工作日 01:00–04:00 与 06:00–10:00。
 *
 * 用户在设置页手动修改的单价会覆盖这里的预置值，「恢复预置」即删除覆盖。
 */

/** DeepSeek 官方峰谷口径：高峰价 = 空闲价 × 2，窗口 UTC 工作日 01:00–04:00 与 06:00–10:00。 */
function dsPeak(offPeak) {
  return {
    peak: {
      enabled: true,
      weekdaysOnly: true,
      windows: [
        { start: '01:00', end: '04:00' },
        { start: '06:00', end: '10:00' },
      ],
      input: offPeak.input * 2,
      output: offPeak.output * 2,
      cacheRead: offPeak.cacheRead * 2,
      cacheWrite: 0,
    },
  }
}

export const PRESET_PRICES = {
  // DeepSeek（国产，CNY 元 / 百万 tokens）
  // `deepseek-flash` 即 DeepSeek-V4.1-Flash（2026-09-10 发布），当前官方主推模型。
  'deepseek-flash': {
    currency: 'CNY', input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0,
    ...dsPeak({ input: 1, output: 4, cacheRead: 0.02 }),
  },
  // V4 Flash（0731）已下线，官方保留旧 id 作为临时别名并路由到 V4.1 Flash，
  // 按 Flash 价计费，因此预设价与 `deepseek-flash` 完全一致。
  'deepseek-v4-flash': {
    currency: 'CNY', input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0,
    ...dsPeak({ input: 1, output: 4, cacheRead: 0.02 }),
  },
  'deepseek-v4-flash-0731': {
    currency: 'CNY', input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0,
    ...dsPeak({ input: 1, output: 4, cacheRead: 0.02 }),
  },
  // V4 Flash Vision Exp 同样已下线并路由到 V4.1 Flash，按 Flash 价计费。
  'deepseek-v4-flash-vision-exp': {
    currency: 'CNY', input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0,
    ...dsPeak({ input: 1, output: 4, cacheRead: 0.02 }),
  },
  // V4 Pro：官方定价页脚注 (2)（2026-09-14 抓取）明确「在 2026 年 9 月 14 日之后
  // **继续提供** DeepSeek V4 Pro 的 API 调用服务，**计费方式保持不变**」。
  // 因此原先那条"9/14 之后改道到 Flash"的规则已被官方推翻，必须删掉：
  // 保留它会把 9/14 之后的 V4-Pro 调用错误地按 Flash 价计费（低报约 5 倍）。
  'deepseek-v4-pro': {
    currency: 'CNY', input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0,
    ...dsPeak({ input: 4.5, output: 13.5, cacheRead: 0.15 }),
  },
  'deepseek-v4-pro-0813': {
    currency: 'CNY', input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0,
    ...dsPeak({ input: 4.5, output: 13.5, cacheRead: 0.15 }),
  },
  // `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停止服务，官方定价页
  // 不再列出。保留最后一段计费口径（按 V4-Flash 价），仅供历史统计对账。
  'deepseek-chat': { currency: 'CNY', input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
  'deepseek-reasoner': { currency: 'CNY', input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
  // OpenAI（海外，USD / 百万 tokens）
  'gpt-5.6-luna': { currency: 'USD', input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  'gpt-5.6-terra': { currency: 'USD', input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-sol': { currency: 'USD', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  'gpt-5.5': { currency: 'USD', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  'gpt-5.4': { currency: 'USD', input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  'gpt-5.4-mini': { currency: 'USD', input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  'gpt-5.4-nano': { currency: 'USD', input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  'gpt-5.3': { currency: 'USD', input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5.2': { currency: 'USD', input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5.1': { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5': { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5-mini': { currency: 'USD', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  'gpt-5-nano': { currency: 'USD', input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  'gpt-4.1': { currency: 'USD', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  'gpt-4.1-mini': { currency: 'USD', input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
  'gpt-4.1-nano': { currency: 'USD', input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
  'gpt-4o': { currency: 'USD', input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  'gpt-4o-mini': { currency: 'USD', input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  'o3': { currency: 'USD', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  'o3-mini': { currency: 'USD', input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 },
  'o4-mini': { currency: 'USD', input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
  // Anthropic（海外，USD）
  'claude-opus-4.8': { currency: 'USD', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4.7': { currency: 'USD', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4.5': { currency: 'USD', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4': { currency: 'USD', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4.6': { currency: 'USD', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4.5': { currency: 'USD', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { currency: 'USD', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4.5': { currency: 'USD', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Google Gemini（海外，USD）
  'gemini-3-pro-preview': { currency: 'USD', input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
  'gemini-3-flash': { currency: 'USD', input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.0833 },
  'gemini-2.5-pro': { currency: 'USD', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.375 },
  'gemini-2.5-flash': { currency: 'USD', input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.0833 },
  'gemini-2.5-flash-lite': { currency: 'USD', input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.0833 },
  // 通义千问 Qwen（国产，CNY）
  'qwen3-max': { currency: 'CNY', input: 5.58, output: 27.89, cacheRead: 1.12, cacheWrite: 6.97 },
  'qwen3-max-thinking': { currency: 'CNY', input: 5.58, output: 27.89, cacheRead: 1.12, cacheWrite: 6.97 },
  'qwen-plus': { currency: 'CNY', input: 1.86, output: 5.58, cacheRead: 0.37, cacheWrite: 2.32 },
  // 月之暗面 Kimi（国产，CNY）
  'kimi-k2': { currency: 'CNY', input: 4.08, output: 16.45, cacheRead: 0.68, cacheWrite: 0 },
  'kimi-k2-thinking': { currency: 'CNY', input: 4.29, output: 17.88, cacheRead: 1.07, cacheWrite: 0 },
  'kimi-k2.7': { currency: 'CNY', input: 5.08, output: 25.03, cacheRead: 1.07, cacheWrite: 0 },
  // 智谱 GLM（国产，CNY）
  'glm-4.6': { currency: 'CNY', input: 3.58, output: 14.3, cacheRead: 0.72, cacheWrite: 0 },
  'glm-4.5': { currency: 'CNY', input: 4.29, output: 15.73, cacheRead: 0.79, cacheWrite: 0 },
  'glm-4.5-air': { currency: 'CNY', input: 0.93, output: 6.08, cacheRead: 0.18, cacheWrite: 0 },
  // GLM-5.1：阿里云百炼官方价，≤32K 输入 ¥6 / 输出 ¥24 / 缓存命中 ¥1.6 每百万 tokens。
  // 32K–200K 档 ¥8 / ¥28（沿用此前核对的记录，本次未重新抓取官方页）；该档缓存命中价
  // 没有记录，留空沿用基础档的 ¥1.6。
  'glm-5.1': {
    currency: 'CNY', input: 6, output: 24, cacheRead: 1.6, cacheWrite: 0,
    tiers: [{ above: 32000, input: 8, output: 28, cacheRead: 0, cacheWrite: 0 }],
  },
  // GLM-5.3-Flash：Z.ai 列表价 $0.15 / $0.50 / 缓存 $0.03 每百万 tokens（USD）。
  // 注意 $0.075/$0.25 是限时 5 折，不能当默认价用。
  'glm-5.3-flash': { currency: 'USD', input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  // GLM-5.2 / GLM-5.3：Z.ai 官方**尚未公布 API 价格**（官方文档只列到 GLM-5.1 / GLM-5）。
  // 这里按上一代旗舰的公开行情 $1.40 / $4.40 预置，属于**参考值**——它比"0 元"
  // 诚实（0 会被读成免费），但请以官方公布为准。缓存价未公布，按 0 处理。
  'glm-5.2': { currency: 'USD', input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'glm-5.3': { currency: 'USD', input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  // OpenAI GPT-6 Astra：$10 / $50 每百万 tokens（USD）。
  'gpt-6-astra': { currency: 'USD', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  // ---- OpenAI GPT-6 系列（标准价，短上下文 ≤272K；USD / 百万 tokens）----
  // 来源：https://developers.openai.com/api/docs/pricing （2026-10-23 抓取）
  // gpt-6-sol：$2 / $10，缓存读 $0.20，缓存写 $2.50
  'gpt-6-sol': { currency: 'USD', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // gpt-6.1-sol：$2 / $10，缓存读 $0.10（0.05x），缓存写 $2.50
  'gpt-6.1-sol': { currency: 'USD', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // gpt-6.1-terra：$1 / $5，缓存读 $0.05，缓存写（30 分钟）$1.25
  // 来源：https://developers.openai.com/api/docs/models/gpt-6.1-terra （2026-10-26 核对）
  // 输入 >272K 时整次请求输入与缓存翻倍、输出 ×1.5（$2 / $7.50，缓存读 $0.10，写 $2.50），
  // 用 tiers 表达；Batch/Flex 半价、Fast 2 倍未计入。
  'gpt-6.1-terra': {
    currency: 'USD', input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
    tiers: [{ above: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
  },
  // gpt-6-luna：$0.10 / $0.50，缓存读 $0.01，缓存写 $0.125
  'gpt-6-luna': { currency: 'USD', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },

  // ---- Anthropic Claude 5.5 系列（USD / 百万 tokens）----
  // 来源：https://platform.claude.com/docs/en/about-claude/pricing （2026-10-23 抓取）
  // Opus 5.5：$4 / $20；5 分钟缓存写 $5；缓存命中 $0.20（0.05x）
  'claude-opus-5-5': { currency: 'USD', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Sonnet 5.5：$2 / $10；缓存写 $2.50；缓存命中 $0.10（0.05x）
  'claude-sonnet-5-5': { currency: 'USD', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // Haiku 5.5：prompt ≤100K 时 $0.10 / $0.50，缓存写 $0.125，命中 $0.01；
  // >100K 档为 $0.50 / $2.50、写 $0.625、命中 $0.05。
  'claude-haiku-5-5': {
    currency: 'USD', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    tiers: [{ above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  },

  // ---- 同代对照（便于核对：Claude 5 系列 / Fable）----
  // Opus 5：$5 / $25，缓存写 $6.25，命中 $0.50
  'claude-opus-5': { currency: 'USD', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Sonnet 5：$2 / $10，缓存写 $2.50，命中 $0.20
  'claude-sonnet-5': { currency: 'USD', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // Fable 5.1：$10 / $50，缓存写 $12.50，命中 $0.25（0.025x）
  'claude-fable-5-1': { currency: 'USD', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
}

/**
 * 归一化模型 id：小写、去首尾空白，并把版本号里的点变成连字符
 * （`claude-sonnet-5.5` → `claude-sonnet-5-5`），让网关与官方 id 的写法差异不影响匹配。
 */
function normalizeId(model) {
  return String(model || '').trim().toLowerCase().replace(/(\d)\.(\d)/g, '$1-$2')
}

/** 归一化 id → 预置价的索引（同时登记原样 id，点号写法也能直接命中）。 */
const PRESET_LOOKUP = (() => {
  const lookup = new Map()
  for (const [id, price] of Object.entries(PRESET_PRICES)) {
    lookup.set(id, price)
    lookup.set(normalizeId(id), price)
  }
  return lookup
})()

/** 按模型 id 查预置价；大小写、首尾空白与版本号点号/连字符写法不敏感。 */
export function presetFor(model) {
  const key = String(model || '').trim().toLowerCase()
  return PRESET_LOOKUP.get(key) || PRESET_LOOKUP.get(normalizeId(key))
}
