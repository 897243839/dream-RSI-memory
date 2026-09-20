# Changelog

## Unreleased

**修复**
- `dream_memory_search` 不传 `limit` 时现在默认取当前策略 `maxRecall`（此前被钳到 1，只返回单条）。
- 回合菜单现在会真实检索并在命中跨会话节点时附带 teaser 提示（此前 teaser 触发链未接线，系统提示承诺的"命中历史"始终不出现）。
- `dream_memory_dream` 的 `focus` 参数现在真正引导做梦的最薄弱指标选择（此前为空操作）。

**重构**
- 工具名统一为 `dream_memory_` 前缀（原前缀混杂、不易阅读，且 `memory_` 无法与其他插件区分）：`commit_task_trace → dream_memory_commit`、`search_history_experience → dream_memory_search`、`inspect_node_detail → dream_memory_node`、`dream_status → dream_memory_status`、`switch_policy → dream_memory_policy`、`run_dream_optimization → dream_memory_dream`。菜单/系统提示/文档同步更新。

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