# Changelog

## Unreleased

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