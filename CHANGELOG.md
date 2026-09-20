# Changelog

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