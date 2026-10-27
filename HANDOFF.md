# 交接：dsh-cost-meter（DSH 费用计量插件）

**代码目录**：`/Users/vincent/Documents/deepseek-harness/default-workspace/dsh-cost-meter`（git 仓库，主线 `main`；GitHub 私有仓库 `Norixor/dsh-cost-meter`，`origin` 指向它；`README.md` 英文、`README.zh-CN.md` 中文，截图在 `docs/images/`）
**版本**：0.7.0（`package.json`）。Windows 副本在 `C:\dsh-plugins\dsh-cost-meter`，经 `ssh win`（`~/.ssh/config` 别名，Tailscale 上的 Windows 电脑，密钥登录）由 `scripts/sync-windows.sh` 同步：只推 `package.json` 与其 `files` 列表，逐文件校验 SHA-256，`--check` 只比对，`--backup` 先备份远端旧目录（默认不备份，用户确认都是测试环境）。**用户要求每次 Mac 上交付（运行时文件有变、`npm test` 通过）后同步一次，并提醒在 Windows 上重启 DSH 才生效**；桌面另有 0.4.2 的 zip。0.4.2 的目录备份在 `../dsh-cost-meter-0.4.2-backup.tgz`。
**包名与安装**：包名 `@norixor/dsh-cost-meter`（原 `@local/dsh-cost-meter`；无作用域的 `dsh-cost-meter` 在 npm 上已被别人占用，不能用），已去掉 `private`，`publishConfig.access` 为 public；**0.7.0 已于 2026-10-26 由用户自己 `npm publish --access public` 发布**（核对过：25 个文件、515,748 字节、latest 标签；npm 页的 README 是 0.7.0 那一份，下次发布才会更新，仓库私有时 README 里的相对图片在 npm 页看不到）。桌面端与 DSH Web 是两个独立 profile（`~/.dsh/profiles/desktop`、`~/.dsh/profiles/web`），同一个包两边通用，README 的快速使用按这两种写（桌面：左侧栏「插件」→ 添加插件，在「包名或地址」填包名（也接受 Git 地址和本地目录绝对路径，不是 npm 网址）→ 安装；Web / CLI：`dsh plugin --profile web add <包名>`；卸载 / 升级：桌面端在「插件」里卸载再装），本地目录安装降为「开发 / 试用」小节。本地目录安装是软链接，目录不可移动/删除。
**本机现状（2026-10-26 已迁移到新包名）**：Mac `~/.dsh/profiles/desktop` 与 Windows `C:\Users\Administrator\.dsh\profiles\desktop`（`admin` 用户的 profile 没装本插件）里，依赖键、`dsh.profile.bundles` 条目、`pnpm-lock.yaml` 的 importer 键都改成了 `@norixor/dsh-cost-meter`，`node_modules/@norixor/dsh-cost-meter` 是指向代码目录的软链接（Windows 是 junction，指向 `C:\dsh-plugins\dsh-cost-meter`），旧的 `node_modules/@local` 已删。这是只改名的最小手工迁移，没有跑 pnpm（跑一次会动其他插件）；回退用 profile 目录里的 `package.json.bak-rename-*` / `pnpm-lock.yaml.bak-rename-*`（Mac 与 Windows 各一份）。**两边都要重启 DSH 才生效，重启后能否正常加载还没有在真实 DSH 里验证。** Windows 副本已用 `scripts/sync-windows.sh` 同步到新名。

## 结构

- `index.js`（Host 半部）：监听 `llm/stream` 瀑布流，从 `chunk.type === 'usage'` 取用量；webServer 注册 `/__cost-meter`（GET 快照 / POST 操作，仅 loopback）；状态存 `$DSH_HOME/cost-meter.json`（临时文件 + rename）。POST 动作：`set-price`、`remove-price`、`set-budget`、`reset-totals`、`stats`（按天 / 按小时明细 + `slowest` + `latencyBounds`）、`set-prefs`（部分更新）、`set-media-rules`、`clear-observed`。**GET 快照不含 `daily` / `hourly`**（体积大、被每 3 秒轮询），含 `media:{rules,templates,observed}`。
- `pricing.js`：纯函数计价规则（峰谷、分档、`priceCall()`、`parsePeak()` / `parseTiers()`）。
- `daily.js`：本地日期键、90 天保留（`pruneDaily`）、`hourOf`。
- `timing.js`：耗时累加（总耗时 / 首字延迟 / 生成速度的和，加对数分桶直方图 `durHist` / `ttftHist`，边界 `LATENCY_BOUNDS_MS` 随 `stats` 回包下发）与最慢 30 次的有界列表。
- `media.js`（实验性）：图片 / 语音 / 识别的计量规则（`sanitizeRules`、`matchRule`、`quantityOf`、`modelOf`）与观察到的工具表（只存工具名和参数名）；Host 通过 `ctx.on('tools/result')` 接入，`prefs.mediaMeter` 关闭时既不计量也不观察。
- `calllog.js`：每个会话 `{ at, calls[], msgs{} }`，最近 80 次调用、200 个消息映射、最多 20 个会话。调用带 `turn`（开始时所在轮次，轮次之外如标题请求为 null）、起止时间、模型、已锁定的费用、Token、首字延迟；图片 / 语音工具调用也记（`media` / `units`）。`msgs` 是 `messageId → turn`。Host 用 `ctx.on('session/event', (session, event))` 维护每个会话的开放轮次：`turn/start` 开、`turn/end` 关、`assistant/message` 写映射；调用在**开始时**取轮次，所以收尾晚于 `turn/end` 的调用仍归原轮次。POST `calls {sessionId}` 返回 `{ calls, msgs, callSeq }`，快照里的 `callSeq`（以启动时刻为起点的计数）告诉浏览器何时重取。
- `prefs.js`：显示偏好的默认值与校验（`sanitizePrefs`）。Host 是唯一的合法性裁判；client 的 `35-prefs.js` 只镜像默认值与枚举，**两处要同步**。
- `presets.js`：66 个模型预置价（部分带 `tiers`），`presetFor()` 做 id 归一化。
- `route-security.js`：loopback 校验 + 有界 JSON 解析。
- **`client.js` 是生成文件，不要直接改。** 源码在 `src/client/`：`lib/*.js`（工厂作用域，按文件名排序拼接）、`apply/*.js`（`apply(ctx)` 作用域）、`banner.txt`；`scripts/build-client.mjs` 负责拼接并给每行加缩进（片段里不要写多行模板字符串、不要 import；片段里的 `export` 会在内联时去掉，这样 `85-stats-data.js` 既能被拼进 client 也能被测试直接 import）。改完源码跑 `npm run build`；`npm test` 会先校验 `client.js` 与源码一致。
  - `10-core.js` 共享快照 store（单个轮询定时器 + `useStore()` / `usePrefs()` / `store.setPrefs()`）、`t` 翻译器；`20/21` 中英词典；`30-format` 格式化；`35-prefs` 偏好镜像 + `dockTheme()`；`36-money` 显示币种视图 `moneyView(prefs)`（折算函数 / 脚注，所有显示面共用）；`50-dock` 输入框统计条（`DockStrip` 纯展示，设置页预览复用）；`55-turn-label` 消息下方的费用标签与摘要行（只负责排版）；`58-peak-ui` 峰谷显示（统计条徽标 `PeakBadge`、右侧栏 / 设置页的 `PeakBlock`、设置分区 `PeakSettings`、每 15 秒走一次的 `useNow`）；`84-peak` 峰谷判断的纯函数（`isPeakNow` 照抄 `pricing.js` 的 `isPeakAt`，因为浏览器半部不能 import，测试里按网格对拍；`peakState` 逐分钟找下一次切换，周末与跨零点窗口不用特判；`peakSchedules` 按「本会话用过的模型 → 见过的模型 → 全部有价格的模型」取适用的时段，`allPeakSchedules` 给设置页，`peakMultiplier`、`windowsText`、`formatCountdown`）；`89-session-view` 会话分模型汇总（纯函数 `sessionBreakdown(snap, sessionId, convert?)`：行、总额、Token、占比、未计价；输入框浮窗与右侧栏页签共用，有单测）；`98-side-tab` 右侧栏「费用」页签的正文（`SideCostTab`）与打开用的 `sideRight` 控制器；`22`–`28` 七套译文、`29-locales` 登记表 `EXTRA_LOCALES`；`88-turn-cost` 用 `turnOfMessage` / `callsOfTurn` / `turnNumberOf` 把消息或轮次对应到调用并汇总（纯函数，有单测）；`62-dropdown` 自绘下拉（代替原生 select：原生弹层在深色下白字白底）；`77-media-drafts` 媒体规则编辑器的纯逻辑（按观察到的模型生成规则、去重、校验、被遮挡规则）；`60-ui` 设置页控件（沿用官方设置页风格）；`65-display` 显示样式设置；`70-prices` 模型单价编辑；`75-settings` 设置页；`76-media-settings` 实验性图片 / 语音计量设置；`80-charts` 手绘 SVG 图表原语；`85-stats-data` / `86-stats-latency` / `87-stats-insights` 纯聚合与观察（有单测，也被测试直接 import，所以不能有 import / 多行模板字符串）；`90-stats-common` 共用块、`91`–`94`、`96` 各分页、`95-stats` 页面骨架与状态、`97-stats-filters` 二级筛选。
  - 注册（`apply/10-register.js`）：`zh` / `en` 与 `EXTRA_LOCALES` 的词典（额外语言各自 try/catch，被宿主拒绝只跳过）、`conversation.composer.dock`、`conversation.chat.assistant-actions`、`conversation.chat.turnTail`、`settings.section`、`sidebar.panellist` + `main`；右侧栏页签用 `ctx.inject(['sidebarRight','sidebarRightTabs'], …)` 登记（可选服务：宿主没有时不运行，抛错时只丢这一块）：`sidebarRightTabs.register({ id: '@norixor/dsh-cost-meter/side', kind: 'cost-meter', title, guide:[{id,title,description,icon}] })` + `sidebar.right.pane.tab` 槽按同一个 id 作 `key` 登记正文，正文的标准 props 里有 `sessionId`；打开用 `sidebarRight.openTab('cost-meter')`（引导页「+」的卡片与输入框浮窗里的链接都会调用）。API 的依据是 `app.asar` 里 `ui-sidebar-right` 的 README 与内置插件（终端、浏览器、计划、定时任务）的注册代码。侧边栏入口随偏好动态注册 / 撤销（`slots.inject()` 返回幂等的撤销函数），上次的开关缓存在 `localStorage['dsh-cost-meter:sidebar']`，避免关闭后每次启动入口闪一下。
  - 左侧栏入口的写法来自对 `/Applications/DeepSeek Harness.app` 的 `app.asar` 的 grep（官方文档没有这一节）：`sidebar.panellist` 登记 `{ name, id, order, label, locale }` + 图标组件（宿主只传 `{ size }`）；`main` 槽用同一个 id 作 `key` 登记整页，`inject` 返回值就是页面 props。
- `test/`：`pricing.test.mjs`（计价）、`stats.test.mjs`（按天 / 小时分桶、补算、prefs）、`stats-data.test.mjs`（统计页聚合）、`calllog.test.mjs`（调用日志的上限、清洗、Host 记账与 `calls` 动作）、`turn-cost.test.mjs`（按轮次归属与汇总）、`media-drafts.test.mjs`（规则草稿、模板预填、校验、遮挡）、`timing.test.mjs`（耗时累加、慢调用、`llm/stream` 假时钟、0.6.x 按小时桶迁移）、`stats-latency.test.mjs`（分位数 / 观察）、`media.test.mjs`（规则、数量、Host 的 `tools/result` 记账与失败不计费）、`client.test.mjs`（生成文件一致性、1000 行上限、浏览器侧偏好默认值与枚举同 `prefs.js` 一致、9 套词典的键 / 占位符 / 清单文件一致与注册、被宿主拒绝语言 id 时仍能加载、沙箱里跑 `apply()` 校验槽位注册与侧边栏开关、右侧栏页签类型的登记与失败时的退化）、`session-view.test.mjs`（会话分模型汇总）、`peak.test.mjs`（峰谷状态：与计价窗口逐分钟对拍、下一次切换含周末与跨零点、倒计时与时区换算、倍率、适用时段的取法）、`host-harness.mjs`（假宿主，供 Host 测试用）。

## 关键语义（改代码前必读）

1. **写时锁定**：每次调用拿到 usage 后，按调用开始时刻（峰谷）与本次上下文长度（分档）算好并累加，改价不回算历史。
2. **峰谷**：整次调用按峰价；窗口 UTC、可两段、可限工作日；峰价某项为 0 时回落到下一层。
3. **上下文分档**：`price.tiers = [{ above, input, output, cacheRead, cacheWrite }]`，`above` 单位是 token（界面以 K 编辑），最多 4 档。上下文 = `inputTokens + cacheReadTokens + cacheWriteTokens`，**严格大于** `above` 时整次请求按该档计价；多档取阈值最高的。优先级 **峰价 > 分档价 > 基础价**，某层某项为 0 沿用下一层。命中次数记在 `tierCalls`（旧桶没有该字段，累加时要 `|| 0`）。
4. **补算**：模型先调用后配价时，`backfillUnpriced()` 按基础价从已累计 token 折算，比例 = `unpriced / (calls − failed)`（失败调用没有 usage，不能算进分母——0.6.0 修正了此前用 `calls` 做分母导致补算偏低的问题），清零 unpriced；总桶、会话桶、按天桶都会补。不含峰价与分档价，是偏低估计。
5. **预置 vs 自定义**：`effectivePrice()` = `prices[model] || presetFor(model)`；自定义整体覆盖预置；「恢复预置」= 删除自定义项。
6. 预算只按预算货币统计；红绿灯 <70% 绿、70–100% 黄、≥100% 红。
7. **按天 / 按小时桶（0.6.0 起）**：每次调用同时累加到「本地日期 × 模型」的桶（同样的计数字段）与「本地日期 × 小时 × 模型」的轻量桶（`hourly[day][hour][model] = { calls, tokens }`，0.7.0 起带模型；0.6.x 的 `{ calls, tokens }` 加载时迁移到模型 `"unknown"`；不存费用，因为补算无法还原到小时）。保留最近 90 天；`reset-totals` 一并清空。旧状态文件没有这两个字段，加载时为空。会话桶新增 `firstAt`（旧会话没有）。
7a. **耗时（0.7.0 起）**：`llm/stream` 包装里用 `performance.now()` 量总耗时与首字延迟（第一个 `text-delta` / `tool-call-delta`），随 `recordCall` 累加进总桶、会话桶、按天桶（字段 `timed / durationMs / ttftCalls / ttftMs / genTokens / genMs / durHist / ttftHist`，旧桶没有，累加时都要 `|| 0`）。P50 / P95 在客户端由直方图线性插值估算；生成速度 = 输出 token ÷（总耗时 − 首字延迟），生成段不足 50 ms 不计。
7b. **图片 / 语音计量（0.7.0，实验性，默认关）**：规则把工具名映射到模型与单价；`tools/result` 里 `exec.name` / `exec.arguments`，失败（`result.isError`）只计一次失败不计费；数量取不到则记未计价；桶多出 `units` 与 `media`（image / speech / transcribe）。「最近观察到的工具」只存工具名与参数名（上限 60 个）。规则可带内容条件 `whenArg` / `whenValue`（精确不分大小写或 `/正则/`，只比较字符串 / 数字参数），按列表顺序第一条命中的生效；条件只有一半或正则无效时**整条规则丢弃**（只去掉条件会把规则放宽到该工具的所有调用）。观察表额外记 `modelArg` 与 `models`（名为 `model` / `model_id` / `model_name` / `engine` 的参数的值，≤ 8 个，不存其他内容）。**这套对 `tools/result` 载荷的假设来自 `app.asar` 里的事件签名与文档，没在真实 DSH 里跑过。**
7c. **币种与统计**：用量、缓存、Token、耗时与币种无关；记录与计费始终按调用当时的币种存（写入时不换算）。统计页、右侧栏页签、输入框统计条与消息标签在**显示时**折算（同一个设置，设置页「显示币种与汇率」）：偏好 `statsCurrency`（名字沿用统计页时期，现在管所有显示面）（CNY / USD / original，默认 CNY）加汇率 `usdCny`（1 USD = N CNY，默认 6.8，范围 0.01–1000，设置里填）；已是所选币种的金额不动，CNY / USD 以外的币种保持原样；original 时图表用区间内费用最多的币种。折算函数在 `85-stats-data.js`（`convertCosts` / `convertDaily` / `convertModels` / `convertSessions` / `convertedFrom`，有单测）。不过滤模型（用户明确指出过：把 CNY / USD 当成筛选条件是误区）。输入框统计条用 `sessionBreakdown(…, money.convert)`，消息标签用 `convertSummary`（`88-turn-cost.js`，有单测），共用 `moneyView(prefs)`（`36-money.js`）；折算过时在浮窗页脚、统计条 tooltip、消息悬停卡与 TurnLine tooltip 里写 `fxNote`。会话预算的红绿灯仍按预算币种的原始金额算，只有显示的金额折算。
7d. **用量片段合并**：一次调用的多个 `usage` 片段用 `mergeUsage` 按计数取最大值，不再只留最后一个。**GPT（gpt-6.1-terra）9 次调用 `inputTokens` 为 0、输出 105 的现象是否由此造成没有确认**；Claude 的缓存读写是被记下来的（claude-haiku-5-5 读 241,609 / 写 242,968）。
8. **输入框统计条默认「纯文字」：无背景、无边框，与旁边系统 UI 一致**（用户明确要求过两次）。用户随后要求在设置里提供其他样式，所以软胶囊 / 描边 / 一体条是**可选项**，**默认值不要改**。点开的明细浮窗不随样式变，始终是系统观感。
9. **设置页不放任何统计**（用户明确要求）：连模型行里的调用次数 / token / 费用也不放，只保留「有 N 次调用未计价」这种需要动手配置的提示。统计只在左侧栏统计页。

## 已验证 / 未验证

- 已验证（0.7.0 起）：`npm test` 98 条通过（计价、按天 / 小时分桶与补算、prefs 校验与落盘、耗时累加与慢调用、0.6.x 迁移、统计聚合 / 筛选 / 观察、媒体规则与 `tools/result` 记账、`client.js` 与源码一致、中英词典一致、1000 行上限、沙箱里 `apply()` 的槽位注册与侧边栏动态开关）；统计页五个分页、模型筛选、二级区间、图片用量显示、实验性设置区块（开关、模板、观察到的工具做成规则、保存发出 `set-media-rules`）都在浏览器测试页里渲染过；用真实 React 18 + mock slots 的浏览器页面渲染过设置页（4 套样式预览、字体 / 字号 / 内容、侧边栏开关实际让入口消失并发出 `set-prefs`）、统计页（全部图表、悬停提示、表格视图、会话与使用时间区块），覆盖浅色 / 深色 / 375px 手机宽度（无横向溢出）/ 空数据 / 英文。 消息操作栏标签（悬停明细在 375px 下被收在视口内）、轮次摘要行、对不上的消息不显示、自绘下拉（深色下可读、按类型分组）、「按 N 个模型做成规则」与保存按钮的校验也在测试页里渲染过。
- 峰谷显示（`dockPeak` 默认开 / `peakCountdown` 默认关 / `sidePeak` 默认开 / `sidePeakDetail` 默认关）在浏览器测试页里渲染过：统计条默认只有图标 + 高峰 / 低谷、倒计时是可选项、四个开关实际发出 `set-prefs` 并让对应部分消失、右侧栏区块（深色 + 英文；默认只有状态和时段，详情可选）、设置分区与「当前状态」；测试页用 `?now=ISO` 冻结时钟、`?peak=0` 去掉带峰价的示例模型。时段在真实 DSH 里是否与官方公布的一致没有核对（预置沿用 `presets.js` 里的 UTC 工作日 01–04、06–10 点）。
- 右侧栏页签、模板搜索、消息样式、汇率输入、币种切换（统计条 / 消息标签 / 预览卡 / 统计页 / 右侧栏页签随之变化）、日文词典在浏览器测试页里渲染过（页签：浅色 / 深色、280–340px 宽、折算成美元、无会话；测试页用假的 `sidebarRight` / `sidebarRightTabs`）。
- **未验证**：右侧栏「费用」页签在真实 DSH 里能否登记与打开（`ctx.inject` 的可选服务写法、`sidebar.right.pane.tab` 正文拿到 `sessionId`、引导页卡片、`openTab('cost-meter')` 是否被接受）；七套额外词典被语言包选中的行为与 id 大小写；消息下方的费用标签 / 摘要行：Host 的 `session/event` 是否真的送达插件、`assistant/message` 的 `data.turn` / `data.message.id` 与槽位 props 里的 `sessionId` / `messageId` / `turn.turn` 是否如 `app.asar` 里读到的那样，都没在真实 DSH 里看过（对不上时两处都不显示）；真实 DSH 里 `tools/result` 的载荷（参数是对象还是 JSON 字符串、`exec.agent.session.id` 是否总有）与用户的工具名是否真的命中图片 / 语音规则；真实 DSH 客户端里的视觉效果与 slot props 兼容性（只在自建测试页里渲染，主题变量用的是近似值）；深色检测依赖 `--dsw-alias-label-primary` 的计算色（解析不了时退回 `prefers-color-scheme`），真实客户端里没测；左侧栏入口的 `order: 20` 排位、`main` 页滚动与留白，以及运行中动态撤销 / 重新注册入口在真实客户端的表现；Windows 上的表现。
- 渲染测试页在会话临时目录里，不在项目内；需要时按 `window.__ModuleLoader__.load` + `ctx.get('slots'|'locale')` 约定重搭（slots 的 `inject` 要返回撤销函数）。

## 已知限制与待办

- 会话分析不显示会话标题（已用 `app.asar` 核实）：`ctx.sessionTitle` 只有 `register()` / `refresh()`，没有读取接口，`llm/stream` 也没有标题字段；目前用「`#` + 会话 id 末 6 位 + 主要模型」区分。若以后宿主给了读取接口，改 `94-stats-sessions.js` 的会话名函数和 Host 即可。
- 云端语音识别没有可观察的事件，无法计量；本地 TTS（sherpa-onnx）/ STT（SenseVoice）免费，也不计。图片 / 语音模板价（2026-10-26 核对）：OpenAI tts-1 $15 / 百万字符、tts-1-hd $30、whisper-1 与 gpt-4o-transcribe $0.006 / 分钟、mini $0.003；阿里云百炼 qwen-image / wan 系列按张。
- 预置只含有官方依据的分档：Claude Haiku 5.5（>100K）、gpt-6.1-terra（>272K）、glm-5.1（>32K，该档缓存读价没有记录，沿用基础价，数值沿用旧注释、本次未重新抓取官方页）。其他 OpenAI 模型的 >272K 档尚未核实。
- 发布前注意：GitHub 仓库是私有的，npm 页面上 README 的相对路径图片（`icon.svg`、`docs/images/*`）和 `repository` 链接对外不可见；README 里的包名安装步骤在发布之前无法照做（本地目录那一节现在可用）。
- 分档是「整次请求」计价，不支持阶梯累进；货币只在显示时折算（固定汇率）；无价格表导入 / 导出。
- 模板价：gpt-image-2 各档与 2.5-sunburst / flare 是按 token 价估算的每张价（标 `est.`），2.5 两个来自页面摘要，gemini-2.5-flash-image 已标注 2026-10-02 停用；USD/CNY 默认 6.8 只是约数。
- 会话只保留最近 200 个；会话统计是累计值，只按最近活跃时间筛进区间。
- `client.js` 曾被外部编辑器改动过（出现 `uiIcon`、slot 改为 `composer.dock` 等非本会话改动），继续改前先对比。

## 验证命令

```sh
cd .../dsh-cost-meter
npm run build   # 改了 src/client 之后
npm test        # build --check + node --test test/*.test.mjs
```
