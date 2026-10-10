# Changelog

## Unreleased

## v2.1.0 · 2026-10-08

**第一期改造：P0 拆门槛 + P1 策略池播种 + P2 检索信号落盘 + LLM 候选默认开**

- **P0 三阶段门槛（S/M/F，替代单一 `n < minNodes` 硬闸）**：
  - 新增 `dream.minNodesProvisional`（N1=5）、`dream.minValidNodes`（=3）；`dream.minNodes`
    （N2=20）语义改为"正式期起点"。阶段判定集中在 `src/lib/stages.ts:getStage`，
    dream/nudge/菜单/低分提示全部走封装，无散落的字面阈值判断。
  - S 播种期（n<5）：不再静默 return——**写一条 `status:"done"` 的 DreamRunRecord**
    （`notes: insufficient: n=<n> < 5`、`candidatesJson:"[]"`），返回文案显式声明
    "证据不足、信号采集中"（论文附录 B.2 的 bootstrap 语义）。
  - M 试用期（5≤n<20）：正常评估；valid 样本数 < `minValidNodes` 时改走
    **只过 train 且 ε 加倍**（`2*epsilon`）的放宽门槛，否则维持现有双门槛；
    切换出的策略带 `provisional: true` 标记（`PolicyRecord` 新字段）。
  - F 正式期（n≥20）：门槛不变；dream 后若 active 带 provisional：发生切换→新策略无标记，
    守擂成功→清除其 provisional 标记（转正）。
  - 文案按阶段三选一：菜单 sizeLine、`/dream` 帮助、低分劝 dream 的提示
    （n<5 改劝 search/commit，避免撞 S 期返回）；nudge：F 期照旧催进化，
    **M 期新增低频试调提示**（`DREAM_NUDGE_TRIAL`，同 GateRegistry 节流），S 期不催。
  - **接通死配置 `dream.enabled`**：false 时 `dream_rsi_memory_dream` 工具与 `/dream run`
    返回"已禁用"、nudge 不注入、低分提示不劝 dream。
- **P1 初始池播种 + 候选多样性**：
  - 新增 `dream.seedCount`（=5）、`dream.seed`（测试固定种子）；建库/索引重建时在
    p-default 之外生成 5 组对 DEFAULT_PARAMS 做 **seeded ±20% 扰动**的候选
    （`source:"seed"`、`isActive:false`、不激活），p-default 标 `source:"default"`。
    RNG 为 mulberry32，种子 = `config.seed ?? fnv1a32(projectId+createdAt)`，写进
    `PolicyRecord.seed` 保证可复现。
  - dream 候选装配 = π₀ 保底（active 永远第一位）+ 池中全部 seed 策略 + 启发式变体
    （每次运行再做一次 seeded ±20% 微扰，补上设计文档 §9.6 规划的探索）+ LLM ≤2。
  - **LLM curator 默认开**：`curator.enabled` 默认 `true`，默认
    `providerID:"opencode"` / `modelID:"mimo-v2.6-flash-free"`（可在配置覆盖）；
    **LLM 调用失败/超时优雅降级**——只损失本次候选，dream 照常完成，
    `DreamRunRecord.notes` 记 `curator: <error>`。
- **P2 queryLog 落盘 + 真实查询回放 + 在线战绩**：
  - 新文件 `src/lib/querylog.ts`：三个用户面检索出口（工具 search / 命令 `/dream search`
    / 菜单 teaser）写 `dataDir/<projectId>/querylog.jsonl`
    （`{ts, turnIndex, query, policyId, trigger, results[]}`）；内部评估
    （status/menuStats/dream 打分）不落盘。上限 `queryLogMax`（=1000），append 后裁最旧。
  - `replay.ts` 新增真实查询用例：可见集 = turnIndex ≤ 查询时刻的节点，用 log.query
    原文检索；标签集 = 窗口 `queryWindowTurns`（=50）内 outcome=success 且 files 与查询
    提取文件有交集的节点（**标签与被评估策略无关**，防自我确认）；真实 ∪ 合成并入 train
    （valid 仍是纯合成 holdout）。真实用例数 < `replayMinRealQueries`（=10）时回退现状，
    旧用例不依赖 queryLog 也全绿。`ReplayReport` 新增 `realCases` 字段。
  - 新增 `store.onlineStats(policyId)`：served = queryLog 中该策略服务过的查询数，
    success/failed/partial = `policyVersion === policyId` 的节点 outcome 计数；
    `dream_rsi_memory_status` 输出末尾附每策略一行在线战绩。**本版只聚合展示，
    不做任何自动调参（P3a 属第二期）**。
- **opencode 2.x 集成第二期：安装布局 + CLI + 双入口**：
  - 安装布局：**scope 根即插件目录**——`~/.cache/opencode/packages/dream-rsi-memory@latest/`
    顶层就是 `index.js` + `package.json` + `dist/`，`node_modules/`（`@opencode-ai/plugin` +
    `zod` 闭包）随载荷自带，不再嵌套 `node_modules/dream-rsi-memory` 层（`scripts/install.mjs` 重写）。
  - 配置编辑 JSONC 感知：`plugins`/`plugin` 数组**元素级**定位与升级（整文件正则替换废除），
    注释透明的深度扫描（元素含 `]`、行/块注释不再截断或劈开元素），写盘前一律 `JSON.parse`
    校验，空配置插入不产生尾逗号；带 BOM 的配置文件不再解析炸掉（原字节保留写回）。
  - 安装健壮性：swap 后**先断言 + 冒烟再删备份**（坏 payload 不架空可用安装）；uninstall
    先删目录（被进程占用时提示退出 opencode 后重跑、**配置不动**）再删配置；原地升级
    `mergeTree` keep 集合大小写感知（Windows）+ 逐文件复制失败汇总告警。
  - 新 CLI：`dreamrsimem`（bin → `dist/cli.js`）——默认 `doctor`，`plugin install|remove|status`、
    `memory list|export`、`--version/--help`；只读诊断库 `src/lib/opencode-install.ts`，
    安装/卸载委托 `scripts/install.mjs`（透传退出码）。
  - 双入口：默认导出 `{ id, setup, server }`——V2 `setup(ctx)` 与 V1 `server` hooks 共用
    同一 runtime / 数据目录；`package.json` exports 补 `./server`；新增 `src/lib/v1-host.ts`
    （opencode 1.x CLI 宿主：6 工具复用、命令走**非空模板**、`server` 即 V1 Plugin）。
- 测试 67 → 81：新增 S 期 insufficient 记录、M 期放宽门槛+provisional、F 期转正、
  播种可复现、queryLog 写入/裁剪、replay 真实用例回退与并入、curator 关闭/失败降级、
  `dream.enabled:false` 全禁用、三阶段 nudge 注入等用例；
  `test/config.test.mjs` 断言 curator 默认值按新默认更新（旧行为断言过期）。
- 第二期再加至 93：双入口导出、V1 宿主 hooks/命令模板、`dreamrsimem` CLI
  （doctor/plugin/memory/退出码）、`opencode-install` 诊断等用例。
- 版本 2.0.1 → 2.1.0。

## v2.0.1 · 2026-10-08

**破坏性变更：全量改名为 `dream-rsi-memory`（工具名变化对旧调用是 breaking）**

- 插件 id、输出/日志前缀、配置文件名、数据目录三层统一为 `dream-rsi-memory`：
  - 插件 id：`dream-memory` → `dream-rsi-memory`
  - 输出/日志前缀：`[dream-memory]` → `[dream-rsi-memory]`（工具描述、命令回显、logger、菜单/系统提示、注入标记）
  - 配置文件：`dream-memory.json(c)` → `dream-rsi-memory.json(c)`；各查找位置**新名优先、旧名兜底**（升级用户的旧名配置不丢）
  - 数据目录：`…/opencode/storage/plugin/dream-memory/` → `…/dream-rsi-memory/`
- **工具名改名（breaking）**——旧工具名调用会直接失败：

  | 旧（≤ 2.0.0） | 新（2.0.1） |
  | --- | --- |
  | `dream_memory_commit` | `dream_rsi_memory_commit` |
  | `dream_memory_search` | `dream_rsi_memory_search` |
  | `dream_memory_node` | `dream_rsi_memory_node` |
  | `dream_memory_status` | `dream_rsi_memory_status` |
  | `dream_memory_policy` | `dream_rsi_memory_policy` |
  | `dream_memory_dream` | `dream_rsi_memory_dream` |

  聊天命令 `/dream *`、`/memory *` 不变；npm 包名 `dream-rsi-memory` 不变。
- **旧数据目录自动迁移**：启动（`resolveConfig`）时，仅当使用**默认**数据目录且新目录
  不存在、旧 `dream-memory/` 存在 → 整体 `rename` 过去；新旧目录都存在 → 用新目录、
  旧目录原样保留（绝不合并/覆盖）并提示残留路径；用户显式配置 `dataDir` 的一律不碰。
  失败原样抛出，不静默吞。配置文件读取同步加旧名 fallback。
- `scripts/install.mjs` 冒烟校验（dist 魔串、`default.id`）同步改为新名。
- 版本 2.0.0 → 2.0.1；`test/config.test.mjs` 新增旧配置名 fallback、数据目录迁移
  （迁移/双目录并存/显式 dataDir 跳过）用例，测试全程沙箱 `XDG_DATA_HOME`。

## v2.0.0 · 2026-10

**破坏性变更：整体迁移到 opencode 2.x 的 V2 插件 API（不再支持 opencode 1.x）**

- 入口由 V1 `{ id, server(input) }` 改为 V2 `{ id, setup(ctx) }`；`input.client`
  与 `hooks.*` 全部换成 V2 域：
  - 工具：`ctx.tool.transform(e => e.add({ name, description, input: z.object(args), execute }))`，
    `execute` 返回 `{ content }`，第二参是 `{ sessionID, agent, messageID, id, signal, progress }`
  - 命令：`ctx.command.transform` 注册 `/dream`、`/memory`（V2 无 `template`，
    补全列表读服务端 `command.list`，照常出现）
  - 菜单与系统提示：`ctx.session.hook("context", ...)`（`system` / `messages` 可写，
    `sessionID` / `agent` 只读），注入标记从 `synthetic: true` 挪到 `metadata`
  - 事件：`ctx.event.subscribe()` 自己拉流（setup 返回 cleanup 中止）
  - 编辑采集：`ctx.tool.hook("execute.before")`
- **新增 `src/lib/v2-compat.ts`（薄兼容层）**：把 V2 `ctx` 包回 V1 形状的 `client`，
  `src/lib/{capture,meta-llm,hooks,tools,store,menu,report,prompts}.ts` 一行未改，
  既有 10 个单测原样通过：
  - `session.messages` → `session.context`（`type`↔`role`、`content`↔`parts`，
    保留 `state.status === "error"` 的工具失败判定；非 user/assistant 消息标 `summary` 跳过）
  - `session.prompt({ noReply })` → `session.synthetic({ resume: false })`（只落可见消息、不唤醒模型）
  - `session.create/delete` → `session.create/remove`
  - V1 `{ providerID, modelID }` → V2 `ModelRef { providerID, id }`；V2 `session.prompt`
    已无 `model` 字段，curator 隐藏会话的模型改在建会话时指定
  - `time.created` 秒/毫秒容错（meta-llm 的轮询以 `Date.now()` 毫秒为基准）
- **新增 `src/lib/v2-types.ts`**：手写窄类型 —— npm 上 `@opencode-ai/plugin@1.18.31→1.18.35`
  只类型化 9 个域，2.0.24 运行时 `setup(ctx)` 实际注入 26 个（`session`/`tool`/`event`/
  `permission` 均无类型），按 v2.0.24 源码逐字段标注出处。
- **安装与配置口径变更（根因：两个插件在 2.x 上静默失效）**：
  - 2.x 的 `plugin` 条目必须是**目录**，绝对**文件**路径会打
    `configured plugin path must be a directory` 并被丢弃；裸包名会让每次启动
    去 registry 跑 `npm install`（不可达时卡住会话启动）
  - 目录解析用 `Bun.resolveSync("<dir>/server")` → `"<dir>/index"`，**不读
    `package.json` 的 `main`** —— 仓库根新增 `index.js` 入口 shim
  - `scripts/install.mjs` 改写**目录**条目、拷贝 shim、把旧的裸名/文件路径条目
    原地升级，冒烟自检增加 `default.setup` 断言；内嵌 PowerShell / bash 同步
- **已无 V1 `experimental.primary_tools` 等价物**（`options.pinned` 仅在 codemode
  下生效），`dream_memory_search` 的常驻提示改为完全依赖菜单注入。
- 测试 50 → 63：`test/entry.test.mjs` 重写为 fake-ctx 接线测试（注册了哪些工具/命令/
  hook、工具返回 `{content}`、命令走 `synthetic({resume:false})`、context hook 注入菜单），
  新增 `test/v2-compat.test.mjs` 覆盖上面每一条映射；`npm run typecheck` 与
  `npm test` 均 exit 0。

## v0.4.5 — 2026-09

**修复：桌面版（GUI）与无 cwd 场景下插件不注册**

- 根因：opencode 桌面版以 `worktree="/"` 启动时，`isRootPath("/")` 触发跳过逻辑，
  `server()` 返回空，导致 GUI 会话里看不到任何 `dream_memory_*` 工具或 `/dream` 命令。
- 修复：rootPath 无效时不再静默跳过，改为**回退到用户主目录**注册插件，
  使桌面版默认会话也能使用记忆库（真实项目打开的窗口仍按项目根路径入库）。
- 新增回归测试：`worktree="/"` 时 hooks.tool 与命令处理器仍存在。

## v0.4.4 — 2026-09

**新增：补齐聊天命令**

- 所有记忆库操作均可通过聊天命令触发，与 MCP 工具等价：
  - `/dream commit <结论摘要>` — 记一条结论（等价 `dream_memory_commit`；摘要可带 `成功|失败|部分` 关键词，自动关联本轮触碰文件）
  - `/dream search <关键词>`、`/memory search <关键词>` — 检索历史（等价 `dream_memory_search`）
  - `/memory show <nodeId>` 沿用，`/dream status`、`/memory stats`、`/memory policy`、`/dream run` 不变
  - 工具描述同步标注聊天命令等价写法
- `normalizeFiles` 移入 `utils.ts` 供 hooks（idle 自动采集、/dream commit）与 tools 共用。

**修复：无重叠关键词的幽灵命中**

- `bm25Normalized` 对 `bm25 == 0` 返回 `1 / (1 + 0) = 1`，即 query 词与节点文档完全无重叠时 fts 仍满分，导致无关幻想命中（如搜 `nothing-here` 命中 invoice 节点，score 0.300）。现对 `bm25 <= 0` 直接返回 0。

## v0.4.3 — 2026-09

**重构：配置段拆分，消除 describe 命名错位**

- 原 `distill` 段名不副实（v0.4.0 已删除 LLM 蒸馏，`distill` 实际承载两件不同的事）。拆为两个语义对齐的段：
  - `capture.maxMaterialChars`：素材采集预算（captureTurn 用，commit/search 自动抓取对话的最大字符数）
  - `curator.*`：后台「馆藏管理员」LLM（dreaming 参数突变候选来源），`enabled` 默认 `false` + 需 `providerID`/`modelID` 才生效
- 旧 `distill` 配置自动迁移（`maxMaterialChars`→`capture`，`enabled`/`providerID`/`modelID`/`timeoutMs`→`curator`），删除旧键。
- 口头命名统一为「馆藏管理员」。

## v0.4.2 — 2026-09

**修复：失败相似阈值统一**

- `scoreCandidates` 判定"同源失败"的 errorMessage 余弦阈值（`0.15`）此前与 replay 评估使用的阈值（`0.1`）不一致，导致计时线上"是否避免踩坑"的统计口径与在线检索不一致，dreaming 定位失败风险偏离。现统一导出 `FAILURE_SIM_THRESHOLD = 0.15`，两处共用。

**修复：路径分词适配 win32 反斜杠**

- `tokenizePath` 此前按 `/` 切分，win32 反斜杠路径（`src\lib\store.ts`）只产生一个无区分度 token。改为 `/` 与 `\` 混合切分，与 `normalizeProjectPath` 的规范化结果一致。

**修复：stripJsonc 转义引号误判**

- JSONC 剥离时仅检查前一个字符是否为 `\`，字符串 `"he said \"hi\""` 中 `\\"`（偶数反斜杠）之后的引号会被误判为字符串结束，后续 `//` 注释清理失效。改为统计连续反斜杠个数的奇偶性判断转义状态。

## v0.4.1 — 2026-09

**修复：原子写入残留 tmp 清理**

- 崩溃/中断的 atomicWrite 会在项目目录留下 `*.tmp-<pid>-<n>` 孤儿文件。现在每次 persist 写入前都会扫描 sessions 目录与项目根目录，清除历史残留（此前仅清理本次写入目标，收不到长期不变文件的旧残留）。

**修复：文件路径跨盘/越界/大小写**

- `normalizeProjectPath` 此前用字符串前缀判断越界，win32 上跨盘符输入（如 `C:\...` 之于 `D:\proj`）会以绝对路径形式绕过检查，导致工作区外临时文件被记入节点（实测捕获到 `temp/opencode/*.graphql`）。现改为比较 resolve 后的物理路径并显式拒绝 `isAbsolute` 结果。
- 移除 win32 全小写化，文件路径保留原始大小写（`README.md` 不再变成 `readme.md`），跨平台迁移时检索一致。

**修复：异常 rootPath 防护**

- 新增 `isRootPath()`：`/`、盘符根等不能作为项目目录的路径直接跳过插件注册，避免再产生 `rootPath="/"` 的垃圾项目目录（实测存在 `index.json` 中持久化 `/` 的孤立项目）。
- `load()` 检测到持久化的 rootPath 是根路径时，用当前 cwd 覆盖并回写磁盘。

## v0.4.0 — 2026-09

**重构：纯计算提取，去除 distill LLM 依赖**

- `dream_memory_commit` 不再异步调用小模型补全字段。节点数据在 commit 时从对话素材同步提取（规则：summary=前 60 字，outcome=按工具错误判断，why=截取 errorMessage）。无 LLM 调用，无隐藏 session 泄漏。
- `MetaLlm` 类仅保留 `mutate()` 方法（dreaming 参数突变），删除 `distill()`、`ensureSession()`、持久 session 缓存。每次 mutate 创建临时 session，用完即关闭。
- 删除 `DistillResult` 类型、`buildDistillPrompt`/`parseDistillJson` 函数、`NodeRecord.distillPending` 字段。
- idle auto-commit 同步使用 `extractNodeFields` 提取结构化字段，不再硬编码 `outcome: "partial"`。

**修复：index.json 丢失时从 session 文件重建**

- `MemoryStore.load()` 新增 `rebuildFromSessions()` 静态方法：当 index.json 和 V1 均失败时，扫描 `sessions/*.json` 收集所有节点，重建索引（默认策略 + 空 dreamRuns）。日志记录恢复的节点数。
- 重建后自动持久化写入正确的 index.json，防止二次丢失。

**修复：默认同 session 父链**

- `commit()` 默认父节点改为同 session 最新节点（此前连接全局最新节点，导致不同 session 的发现树被隐式串链）。
- 新增 `latestNodeForSession(sessionId)` 方法。显式传 `parentId` 的跨 session 行为不受影响。

**其他**

- `debug` 默认值从 `true` 改为 `false`，减少控制台噪音。

## v0.3.1 — 2026-09

插件入口改为新版 V1 对象格式（`export default { id, server }`）。

- 修复 file 插件被 opencode 判定「插件名字不正确」：新版加载器要求 file 插件显式导出 `id`（`resolvePluginId`：`Path plugin X must export id`），npm 插件名来自 package.json 故 `opencode-acp` 正常。
- 新增 `test/entry.test.mjs`：断言 V1 形状（`id` / `server` / 无 `tui`）与隔离项目下 hooks 装配（共 2 项）。

## v0.3.0 — 2026-09

存储优化：不再按项目保存单个大型 JSON。

- 数据按会话拆分：`index.json`（小型索引：项目元信息 + 检索策略 + 做梦记录）+ `sessions/*.json`（每会话一个文件）。
- 写入只重写对应会话文件与小型索引，不再每次全量序列化整个项目；原子写按目标文件独立临时名，避免并发互相覆盖。
- 旧版单文件 `memory.json` 启动时自动迁移为 v2 布局，原文件改名 `memory.json.bak`。
- 新增 3 项存储用例：v2 布局/按会话分文件断言、v1→v2 迁移、跨会话重载时序往返。

## v0.2.1 — 2026-09

- 许可证由 Apache-2.0 改为 **AGPL-3.0-or-later**（LICENSE / package.json / README）。

## v0.2.0 — 2026-09

工程化与可靠性改进。

**功能**
- `session.idle` 兜底自动归档：会话空闲且收集到文件/素材时，把当前回合自动存为记忆节点（`autoCommitOnIdle` / `autoCommitIdleGapMs` 可配置，默认开启、间隔 5 分钟）。再次空闲在间隔内去重。
- 策略切换时记录当选参数基线 `replayAtCreation`；`status` 命令在重放结果相对基线退化（超出 `2 × epsilon`）时给出看门狗警示。

**修复**
- `captureTurn` 不再把更早回合的助手文本混入当前回合素材。
- 修复并发写库时 `persist()` 共用临时文件导致竞态的隐患（改为串行化写入队列）。
- `search()` 现在会透传 `minScore` 参数（此前只透传 `limit`）。

**工程**
- 新增测试套件（`test/*.test.mjs`，Node 原生 test runner）：`utils / store / replay / dream / hooks` 共 19 项用例，覆盖打分边界、门控注入时间线、idle 自动归档、策略切换与看门狗、多回合素材隔离。`npm test` = 构建 + 运行全部用例。
- 文件路径在所有入口统一经 `normalizeProjectPath` 归一化（正斜杠、小写、阻止越级目录）。