# Dream-RSI 策略库扩展方案 v2（opencode 端）

> 目标：在现有 dream-RSI-memory（opencode 插件）之上，加一层「设计选型候选入库 — 真实试错 — dream 复盘建议」的闭环。
> 候选枚举完全由主 agent 在对话中完成，**不新增任何后台 LLM 模型配置、不新增任何 npm 依赖**。
> 范围：**仅 opencode**（插件 V2 + V1 双入口），不含 Claude Code / MCP。

---

## 0. v1 → v2 修订摘要

| # | v1 的问题 | v2 的处置 |
|---|---|---|
| 1 | Claude Code / MCP 端（v1 §4.3）牵出 stdio server、新依赖、`CLAUDE.md`、session 语义缺失 | **整节删除**，范围收窄为 opencode |
| 2 | 「会话当前选中哪个 alt」状态无处安放，`commit` 自动挂父无法稳定成立 | 改为**从会话内节点推导**（§4），零新增状态、重启安全 |
| 3 | `pick` 把「主动让位」记成 `rejected + failed`，污染 §5 胜率统计 | 新增第三语义 `superseded`，评分时与真实证伪区分（§6） |
| 4 | 胜率公式 `(success−failed)/len`：`partial` 计分母不计分子、无置信度、3 节点与 30 节点直接比 | 改 Wilson 下界 + `partial` 半权 + 双门槛（§7） |
| 5 | 跨 set 同名方案归并、adviceLog 注入点与上限全部未定义 | 显式定义（§8） |
| 6 | v1 用 `BaseNode.id`/`agentName?` 自造类型，与真实 `NodeRecord`（`nodeId`、`agentName` 必填、`outcome` 必填）脱节且自相矛盾 | 不造新类型，直接扩展现有 `NodeRecord`，`outcome` 改可选 + 读取兜底（§3） |
| 7 | 新工具前缀 `dream_rsi_strategy_*` 与现有 `dream_rsi_memory_*` 分裂 | 统一为 `dream_rsi_memory_strategy_*`（§5） |
| 8 | 无版本化概念，兼容靠「缺省兜底」 | 复用已有 `version: 2` 门，新键**懒补空值**、不新增版本号、不重写节点文件（§10） |
| 9 | `propose` 无任何护栏，可存 1 个候选、可重复建雷同 set | 工具内纯规则校验（§5.3） |
| 10 | 步骤估时 5 天含 MCP | 去 MCP 后 **3.5 天**（§11） |

### 0.1 v2 → v2.1 修订（多路只读复核推翻 v2 自身 3 处，另补 4 个设计维度）

> 复核方式：4 路并行只读侦察（模块依赖 / 数据流与持久化 / 状态与并发 / 异常与失败面），逐条对齐真实代码。

| # | v2 的问题 | 复核证据 | v2.1 的处置 |
|---|---|---|---|
| 1 | `strategySets` 进 `index.json` | `patchNode`（`store.ts:463-478`）**不置 `indexDirty`**，只加 `dirtySessions` → `pickStrategy` 改 `chosenAltId` 永远不落盘；`rebuildFromSessions`（`store.ts:206-254`）丢 index 键但节点健在 → 双源分叉 | **从 `index.json` 删除**，改为派生索引（§10.1） |
| 2 | `resolveActiveAlt` 按 `turnIndex` 取最后一个 | `order` 按**节点创建序**（`store.ts:433,348`），`patchNode` 只 `Object.assign` 不改 `turnIndex`（`:467`）→ 先 pick b2(turn21) 后 pick a1(turn10) 会返回 b2，**「当前分支」是错的** | 改为 pick 时强制「每会话 ≤1 chosen」不变量（§4.1），排序问题消失 |
| 3 | `outcome` 改可选 + 读取兜底 | 直接读 `node.outcome` 的点有 **10 处**（`report.ts:21,84`、`hooks.ts:79,233`、`tools.ts:81,115`、`store.ts:604-610,673`、`opencode-install.ts:333`、`replay.ts:84-86,145`） | **保持必填**，set/alt 写占位 `"partial"`，在**本来就必改的 5 个点**按 `type` 过滤（§3.1） |
| 4 | §7.2「现有 7 浮点 replay 完全不受影响」 | set/alt 节点进 `sortedNodes()` 后：`evalRange`（`replay.ts:66-92`）把它们当 target → `precCount`/`budgetCount` 膨胀稀释 recallBudget；`store.count()`（`:381`）进 `getStage`（`report.ts:32`）→ S/M/F 阈值 5/20 提前触发；`splitIndex` 位移（`replay.ts:181`） | **必须过滤 `type === "experience"`**（§7.2 已更正） |
| 5 | pick 的 3 次 patchNode 各自 `persist()` | 每个 patch 都 `void this.persist()`（`store.ts:476`），中断会留下「0 个 chosen」或「2 个 chosen」，且无「每 set 唯一 chosen」不变量校验 | 新增 `batchPatch`：批量 apply + 单次 persist（§4.2） |
| 6 | propose 未要求显式 `parentId` | `commit` 未传 parentId 时默认挂同会话最近节点（`store.ts:430-431`）→ 若 `provisionalPick` 让某 alt 立即 chosen，随后创建的 alt#2 会挂到 **alt#1** 而非 set → `descendantsOf(alt1)` 吞掉 alt#2 子树，Wilson 统计双算 | **propose 必须显式传 `parentId=setId` + `branchId=alt 自身 id`**（§5.1） |
| 7 | 未定义模块结构、状态控制、异常处理、失败面 | — | 新增 §14 模块结构 / §15 状态控制与并发 / §16 异常处理与失败面 |
| 8 | 未处理 `store.ts` 728 行、5 类职责的复杂度 | `store.ts:109-164`（`makePolicy`/`seedPolicies`/`initialPolicies`/`StoreLoadOptions`）+ `types.ts:52-70 PolicyRecord` 可独立成 `policy.ts`，只 import `types`+`utils`，入度不增反减 | 借本次扩展抽出（§14.2），直接响应「降低复杂度」 |

**关于引用归属**：本扩展属**本项目独立创新**，不引用 Dream-RSI 论文作为方法来源；但 replay 骨架、决策树、`epsilon` 不退化保证仍是论文派生，README 现有引用与免责声明保持不变（分层标注见 `README.md`）。

---

## 1. 背景与边界

现有 dream-RSI-memory 进化的是**记忆检索策略**（7 个浮点参数），在同一项目历史节点上离线回放，选 train+valid 都稳健提升的参数组。

本扩展新增的是**设计决策策略**：当主 agent 面临选型问题（SQLite vs JSON、读时计算 vs 写时聚合……），把候选结构化入库；每被真实尝试一次就累积 outcome；dream 时比较「哪条子树的真实结局更优」，给出只读建议。

**不做的事：**
- 不在零历史时「dream 选最优」——零历史回放是噪声。
- 不引入第二个后台 LLM 模型配置。
- 不改变现有 7 浮点检索策略的任何行为（回归必须通过）。
- dream **不自动切换**分支；切换权永远在主 agent / 用户。

---

## 2. 事实基线（已逐条对齐当前代码，行号可核）

以下均为仓库已成立的事实，v2 的所有设计建立在此之上：

1. **节点已有父子字段，但无类型字段**：`NodeRecord`（`src/lib/types.ts:33-50`）含必填 `nodeId`/`projectId`/`sessionId`/`agentName`/`summary`/`files`/`turnIndex`/`createdAt`，可选 `parentId?`/`branchId?`/`score?`/`why?`/`errorMessage?`/`policyVersion?`/`autoCreated?`。**没有 `type`/`kind`**（全仓 grep 仅 `src/lib/hooks.ts:290` 一条注释）→ 本扩展新增的就是「节点种类」这一维度。
2. `Outcome = "success" | "failed" | "partial"`（`src/lib/types.ts:1`），与节点种类正交。
3. **`parentId` 已有默认行为**：`commit` 未传 `parentId` 时挂到**同会话最近节点**（`src/lib/store.ts:430-431`），`branchId` 同理（`store.ts:432`）。§4 的自动挂靠是在这个默认之上改写，不是从零实现。
4. **没有任何树遍历代码**：全仓 `parentId` 仅 9 处（定义/入参/赋值/`src/lib/report.ts:89-90` 展示），`children|descendant|subtree` 零命中 → `descendantsOf()` 必须新增。
5. 磁盘布局：`<dataDir>/<projectId>/index.json`（`store.ts:263-264`）+ `sessions/<清洗后 sessionId>-<sha1 前 8>.json`（`store.ts:100-103`）+ `querylog.jsonl`（`src/lib/querylog.ts:32,41`）。`projectId = sha1(rootPath.toLowerCase()).slice(0,12)`（`src/lib/utils.ts:5-11`，调用点 `src/lib/runtime.ts:54`）。
6. `index.json` 现有 7 键：`version`(=2)/`projectId`/`rootPath`/`createdAt`/`activePolicyId`/`policies`/`dreamRuns`（`store.ts:50-58`，序列化 `store.ts:678-688`）；**无节点计数键**（CLI 的 `nodes=` 是运行时扫 `sessions/*.json` 数的，`src/lib/opencode-install.ts:267-300`）。
7. **兼容机制是宽松的**：无 zod/ajv；读取只校验 `version === DISK_VERSION(2)` + `nodes` 为数组 + `node.nodeId` 存在（`store.ts:292-294`）；**未知字段原样保留、缺字段不补默认** → 给节点加新**可选**字段天然向后兼容，无需迁移函数。
8. `MemoryStore` 是唯一导出类（`store.ts:256` `load`、`:428` `commit`、`:463` `patchNode`、`:377` `sortedNodes`、`:385` `getNode`、`:619` `search`、`:664` `onlineStats`）；新能力应作为 `MemoryStore` 方法，而非模块级函数。
9. dream 三阶段：S `n < 5` 不评估、M `5 ≤ n < 20`、F `n ≥ 20` 双门槛；默认 `trainRatio 0.8`、`epsilon 0.005`、`minValidNodes 3`、`seedCount 5`、`candidateCount 3`、`replayMinRealQueries 10`；结果写进 `index.json` 的 `dreamRuns`（`store.ts:520-524`）。
10. 工具定义：`tool({ description, args, execute })` + `tool.schema`（`src/lib/tools.ts:1`、`:34`），`createTools(deps)` 返回 `Record<string, ToolDefinition>`（`tools.ts:25-32`，键名 `:191-198`），`execute(args, ctx)` 的 `ctx` 提供 `sessionID`/`worktree`/`agent`（`tools.ts:54`）。
11. 菜单/系统提示文案：动作清单在 `src/lib/prompts.ts:62-71`，WHEN 条件在 `:13-16`；注入与节流见 `src/lib/menu.ts:14-30`、`src/lib/hooks.ts:83`。
12. **零 runtime 依赖**（`package.json` 无 `dependencies`，仅 peerDep `@opencode-ai/plugin`），构建 `tsc` → ESM（`type: module` + `NodeNext`），测试 `node --test test/*.test.mjs` 且 import `dist/lib/*.js`（需先 build）。不得为本扩展引入新包。

---

## 3. 节点类型扩展（修正 v1 的类型矛盾）

在现有 `NodeRecord`（`src/lib/types.ts:33-50`）上**加一个可选字段**，不重写该接口。读取端对缺 `type` 的旧节点按 `experience` 处理；由于磁盘读取不 strip 未知字段、也不补默认（`store.ts:292-294`），加可选字段无需迁移函数。

```ts
type NodeType = "experience" | "strategy_set" | "strategy_alt";

// NodeRecord 新增（唯一改动）：type?: NodeType   // 缺省 = "experience"

interface StrategySetNode extends NodeRecord {
  type: "strategy_set";
  outcome: "partial";           // 保持必填，写占位值（§3.1：set 自身无结局，但从不进打分口径）
  problem: string;              // ≤80 字
  altIds: string[];
  chosenAltId?: string;
}

interface StrategyAltNode extends NodeRecord {
  type: "strategy_alt";
  outcome: Outcome;             // 保持必填：rejected 时 "failed"，其余 "partial" 占位
  setId: string;
  name: string;                 // ≤20 字，set 内唯一
  approach: string;             // ≤300 字
  tradeoffs: string;            // ≤200 字
  estimatedRisk: string;        // ≤200 字
  status: "unproven" | "chosen" | "superseded" | "rejected";
}
```

### 3.1 为什么 `outcome` 保持必填（v2 结论的更正）

v2 曾推荐「改可选 + 读取兜底」，复核发现代价被低估：直接读 `node.outcome` 的点有 **10 处**，不兜底虽不崩但会打印 `undefined` 并改变统计口径。

**v2.1 改为：`outcome` 保持必填，set/alt 写占位值，在本来就必须按 `type` 过滤的 5 个点一并处理。**

| 过滤点 | 为什么本来就必改 |
|---|---|
| `store.scoreCandidates`（`store.ts:569`）/ `search`（`store.ts:619`） | 不过滤，set/alt 混进召回 |
| `replay.runReplay`（`replay.ts:178`）`evalRange` | 不过滤，recallBudget 被稀释、`splitIndex` 位移（`replay.ts:181`） |
| `store.count()`（`store.ts:381`）→ `getStage`（`report.ts:32`） | 不过滤，S/M/F 阈值 5/20 提前触发 |
| `store.onlineStats`（`store.ts:664`） | 同上，统计口径污染 |
| `report.ts` `nodeStats`（`report.ts:18-24`） | 展示口径 |

这 5 个过滤是**强制的**（见 §0.1 第 4 条），所以净改动成本 = 0；而「转可选」会额外新增 10 处兜底。

**树结构约定：**
- `strategy_set.parentId` → 触发该决策时正在做的经验节点（或缺省 = 同会话最近节点，沿用 `store.ts:430-431` 的既有默认）
- `strategy_alt.parentId` → 所属 `strategy_set`
- 之后的普通 `commit` 节点 `parentId` → 当前 `chosen` 的 alt（自动挂靠规则见 §4）

**关键差异点（对 v1）：**
- 不再引入 `BaseNode`，直接扩展现有 `NodeRecord` —— 避免与真实类型脱节（v1 的 `id`/`agentName?` 与真实 `nodeId`/`agentName` 必填均不符）。
- `outcome` 改可选 + 读取兜底，消除 v1「基类必填 + 注释说可留空」的矛盾。
- `status` 新增 `superseded`（§6）。

---

## 4. 会话级「当前选中 alt」：从节点推导，不新增状态（v1 最大缺口的修法）

**问题**：`commit` 要自动把 `parentId` 挂到当前 chosen alt，就必须知道「本会话此刻在走哪条分支」。v1 没定义这个状态存哪，重启即失效。

**v2 方案：推导而非存储。**

```
resolveActiveAlt(sessionId):
  candidates = store.sortedNodes().filter(n =>
      n.sessionId === sessionId &&
      n.type === "strategy_alt" &&
      n.status === "chosen")
  // 不变量（§4.1 保证）：candidates 恒为 0 或 1 个 → 无需排序、无排序 bug
  return candidates[0] ?? null
```

### 4.1 推导键的更正：用「不变量」替代「按 turnIndex 排序」

v2 写的是「取 `sortedNodes()` 排序最后一个」，但 **`order` 按节点创建序（`store.ts:433,348`），`patchNode` 只 `Object.assign` 不改 `turnIndex`（`store.ts:467`）**。反例：setA 的 alt 创建于 turn 10/11、setB 的 alt 创建于 turn 20/21；先 pick b2、后 pick a1 → chosen 候选 = {a1(turn10), b2(turn21)} → 返回 b2，**「当前分支」是错的**，后续 commit 全挂错父。

**v2.1 改为在 `pickStrategy` 里强制不变量「每会话至多 1 个 chosen」：**

```
pickStrategy(setId, altId, verdict, reason?):
  1. 把**本会话所有** status=chosen 的 alt → superseded   ← 不只同 set
  2. patchNode(新 alt, { status: "chosen" })
  3. patchNode(set, { chosenAltId: altId })
  4. batchPatch 一次性落盘（§4.2）
```

不变量成立后，`resolveActiveAlt` 的候选**恒为 0 或 1 个**，排序问题从根上消失 —— 比「找最后一次 pick」更简单且更正确。

- **零新增持久化字段**，重启、跨会话都安全。per-session 隔离是推导的默认结果（过滤键是 `alt.sessionId` 而非 set 的 `chosenAltId`），无需额外字段。
- `commit` 的 `parentId` 自动挂靠规则：
  1. 调用方**显式传了 `parentId`** → 以显式为准（不改现有行为，用户/agent 可随时打断挂靠）。
  2. 未传且存在 active alt → 自动填 active alt 的 id。
  3. 未传且无 active alt → 维持现状（缺省父）。
- 复杂度：每次 commit 扫本会话节点一次，量级为 O(本会话节点数)，可接受；实现时可只扫内存中已加载的 session 节点。

---

## 5. 新增工具（2 个，前缀与现有一致）

工具名统一用 `dream_rsi_memory_strategy_*`，与现有 6 个 `dream_rsi_memory_*` 同前缀（历史上曾统一前缀以利于插件识别，不引入第二前缀）。

### 5.1 `dream_rsi_memory_strategy_propose`

入参：

```ts
{
  problem: string;                 // ≤80 字，决策问题
  alternatives: Array<{
    name: string;                  // ≤20 字，set 内唯一
    approach: string;              // ≤300 字
    tradeoffs: string;             // ≤200 字
    estimatedRisk: string;         // ≤200 字
  }>;
  provisionalPick?: string;        // alternatives[i].name，可省
  parentId?: string;               // 可选：显式挂在哪个经验节点下
}
```

返回：`{ setId, altIds, alreadyExisted: boolean, note }`

行为：建一个 `strategy_set` + N 个 `strategy_alt`（初始 `unproven`）；给了 `provisionalPick` 则该 alt 立即 `chosen`。**工具内部不调用任何 LLM**，只做存储与规则校验。

> **必须显式传 `parentId` 与 `branchId`**（v2.1 新增要求）：`commit` 未传 `parentId` 时默认挂到**同会话最近节点**（`store.ts:430-431`）。若 `provisionalPick` 让某 alt 立即 `chosen`，随后创建的 alt#2 会挂到 **alt#1** 而非 set → `descendantsOf(alt1)` 吞掉 alt#2 子树，Wilson 统计双算。
>
> - set 节点：`parentId` = 调用方传入的 `parentId`（省略则走既有默认挂最近经验节点）
> - 每个 alt 节点：`parentId = setId`，**`branchId = alt 自身 id`**（否则 `store.ts:432` 会让一个 set 下所有 alt 共享同一 branchId，无法区分子树）

### 5.2 `dream_rsi_memory_strategy_pick`

```ts
{
  setId: string;
  altName: string;
  reason?: string;                 // 为什么切（建议必填）
  verdict?: "superseded" | "rejected";   // 缺省 superseded
}
```

返回：`{ previousAlt, currentAlt, note }`

行为：
1. 被切走的 alt：`status = verdict`。`superseded`（缺省，主动让位）**不写 outcome**；`rejected`（真实证伪）写 `outcome=failed`、`why=reason`。若该 alt 尚无任何子节点且未给 reason → 保持 `unproven`（纯放弃不记账）。
2. 新 alt → `status=chosen`，更新 `set.chosenAltId`。
3. 写一条隐式记录节点（`outcome=partial`，`summary` 记录本次切换与 reason），`parentId = setId`。

> **必须原子落盘**（v2.1 新增）：以上 3 步若各自 `patchNode` → 各自 `void this.persist()`（`store.ts:476`），中断会留下「0 个 chosen」或「2 个 chosen」。改用 `store.batchPatch(patches)`：同步 apply 全部 → 单次 `persist()`（§4.2）。
>
> **边界行为**（v2.1 补齐，对齐 `setActivePolicy` 的幂等风格 `store.ts:411-418`）：
> - `setId` / `altName` 不存在 → 返回中文串 + 「可用：…」列表，不写库
> - 目标 alt 已是 `chosen` → 幂等成功，返回 `{ previousAlt: null, currentAlt, note: "已在该分支" }`
> - 目标 alt 已是 `superseded`/`rejected` → **拒绝并报当前状态**，不得静默按 `unproven` 处理（会污染 §7 胜率）

### 5.3 propose 的护栏（纯规则，零 LLM）

| 校验 | 不通过时的行为 |
|---|---|
| `alternatives.length < 2` 或 `> 5` | 直接报错：候选数需 2~5 |
| `alternatives` 内 `name` 重复 | 报错并列出重复项 |
| 与历史某个 set 的 `problem` 相似度过高（分词重叠 ≥ 阈值，复用现有分词/FTS 能力） | **不新建**，返回该 `setId` 且 `alreadyExisted: true` |
| 任一字段超长 | 报错并指出超限字段 |

### 5.4 现有工具的角色（不动签名）

| 工具 | 在本扩展中的角色 |
|---|---|
| `dream_rsi_memory_commit` | 正常累积 outcome；`parentId` 按 §4 规则自动挂靠（显式传参优先） |
| `dream_rsi_memory_search` | `strategy_set` 作为「决策入口」高权重命中；并注入 advice（§8） |
| `dream_rsi_memory_dream` | 在现有浮点 replay 之外，追加**只读**分支评估段（§7） |
| `dream_rsi_memory_status` | 末尾追加策略库概览：set 数 / alt 数 / 已证明 / 当前 chosen / 最近 advice |
| `dream_rsi_memory_node` | 可直接查看 set / alt 节点详情（类型分派展示） |

### 5.5 菜单与系统提示

- 回合结束菜单的可动作清单追加一条（`renderMenuText` 的动作数组）：
  `strategy_propose 把设计选型的候选存进策略库 / strategy_pick 切换分支`
- 系统提示帮助块的 WHEN 触发条件追加：「当你在设计阶段列举了 ≥2 个可行方案、或当前分支已撞墙需要换路时」。

---

## 6. `pick` 的语义分层（避免污染统计）

| 情形 | status | outcome | 说明 |
|---|---|---|---|
| 纯放弃（无子节点、无 reason） | 保持 `unproven` | — | 不记账 |
| 主动让位给更优分支 | `superseded` | — | §7 评分时**不计入失败** |
| 真实证伪（撞墙/踩坑） | `rejected` | `failed` + `why` | §7 评分计入失败 |

这样「A 成功了但 B 更好」与「A 根本走不通」在统计上被区分开，v1 把两者都记 failed 导致的胜率失真被消除。

---

## 7. dream 追加段：分支选择评估（只读）

### 7.1 打分

```
for 每个 strategy_set:
  for 每个 alt in set.altIds:
    subtree = descendantsOf(alt)         // 新增函数：全仓现无任何树遍历（见 §2.4），以 parentId 建一次 childIndex 后 O(1) 取子树
    s = #success, f = #failed, p = #partial, n = s + f + p
    if n < minSubtreeNodes (默认 3): alt.score = null   // 样本不足，不参与比较
    else:
      w = s + 0.5 * p                    // partial 半权，消除 v1「计分母不计分子」的偏差
      alt.score = wilsonLowerBound(w, n, z = 1.0)
  proven = alts.filter(a => a.score != null)
  if proven.length >= 2:
    best, second = 按 score 降序前两名
    if best.score - second.score > adviceDelta (默认 0.15) 且 两者 n ≥ minSubtreeNodes:
      set.advice = { recommendedAltId: best.nodeId, margin: best.score - second.score }
```

Wilson 下界在小样本下天然保守，`z=1.0`（约 68% 置信）避免 n=3 时过度严苛；`adviceDelta` 双门槛避免「差 0.01 也发建议」。

### 7.2 与现有 dream 的关系（v2.1 更正：原「完全不受影响」的说法**不成立**）

> **原 v2 写「现有 7 浮点 replay 完全不受影响（两段代码路径独立）」是错的。** set/alt 节点进入 `sortedNodes()` 后：
> - `evalRange`（`replay.ts:66-92`）把每个节点当 target，set/alt 的 `files=[]`、outcome 为占位 `partial` → `precCount`/`budgetCount` 增加 → **recallBudget 被稀释**
> - `store.count()`（`store.ts:381`）进入 `getStage`（`report.ts:32`）→ **S/M/F 阈值 5/20 提前触发**
> - `splitIndex` 位移（`replay.ts:181`）→ train/valid 切分点漂移
>
> **必须在 5 个点按 `type === "experience"` 过滤**（清单见 §3.1）。过滤后，7 浮点参数 replay 的数值基线才与改动前一致，§12 的回归验收才有意义。

- 现有 7 浮点参数 replay **行为与数值基线保持不变** —— 前提是完成 §3.1 的 5 处 `type` 过滤。
- 分支评估**只读**：不切 policy、不写节点、不改 status。
- 达到门槛才产出 advice，写入 `index.json` 的 `adviceLog`（§8）。

---

## 8. adviceLog 与检索注入

**记录结构**（追加到 `index.json`）：

```ts
interface AdviceRecord {
  setId: string;
  problem: string;
  recommendedAltId: string;
  recommendedAltName: string;
  margin: number;
  runId: string;          // 来源 dream 运行
  createdAt: string;
}
```

**上限与去重**：
- 容量上限 50 条，FIFO 淘汰。
- 同一 `setId` + 同一 `recommendedAltId` 重复产出 → **更新**已有记录（刷新 `margin`/`runId`/`createdAt`），不新增，避免刷屏。

**检索注入**：`search` 执行时，若查询与某条 advice 的 `problem` 词重叠达到阈值（复用现有分词能力），在返回的召回列表**顶部**插入至多 1 条 advice，标注来源 `runId` 与 `margin`，明确写「这是历史分支复盘建议，不是预测」。

---

## 9. opencode 接入点（全部为现有文件内的增量）

**新增文件（2 个）**

| 文件 | 职责 | 依赖方向 |
|---|---|---|
| `src/lib/strategy.ts` | 纯函数：护栏校验、Wilson 打分、advice 产出、active-alt 推导、`descendantsOf`/`buildChildIndex`。**不碰 I/O** | 只 import `types`/`utils`/`scoring`/`stages`；**禁 import `dream`/`report`/`config`/`store`（值）** |
| `src/lib/policy.ts` | 从 `store.ts:109-164` 搬出（`makePolicy`/`seedPolicies`/`initialPolicies`/`StoreLoadOptions`）+ `types.ts:52-70 PolicyRecord`。**降复杂度** | 只 import `types`/`utils` |

**改动文件**

| 改动 | 位置 | 性质 |
|---|---|---|
| 新增 2 个 tool 定义并加入返回对象 | `src/lib/tools.ts` | 增量 |
| `commit` 加空 `sessionID` guard | `src/lib/tools.ts:53-77` | 1 行；挂靠逻辑下沉 store 层 |
| `NodeRecord` 加可选 `type`（§3） | `src/lib/types.ts:33-50` | 增量 1 行；`outcome` **不改** |
| 5 处按 `type === "experience"` 过滤（§3.1） | `store.ts:569,381,664` + `replay.ts:66-92` + `report.ts:18-24` | 强制，否则回归漂移 |
| `batchPatch` + `proposeStrategySet` + `pickStrategy` + 派生 set 索引 + `adviceLog` | `src/lib/store.ts` | 增量方法；派生索引在构造函数 `store.ts:192` 折叠建 |
| `index.json` 懒补 `adviceLog`（**只有这一个新键**） | `src/lib/store.ts:341` 汇合点 | 增量 1 行 |
| dream 互斥门（复用 `types.ts:72` 的 `running`）+ 分支评估段 + `adviceLog` 写入 | `src/lib/dream.ts` | 增量 |
| 策略库概览展示 | `src/lib/report.ts` | 增量片段 |
| 菜单动作清单 + 系统提示 WHEN 条件 | `src/lib/prompts.ts:13-16,62-71` | 增量字符串 |
| V1 兼容 | `src/lib/v1-host.ts` | 复用同一份 tools 表，预期无需改动 |

不新增文件依赖、不新增 npm 包、不改 V2 注册链路（`ctx.tool.transform` → `editor.add`）与 `options: { codemode: false }` 顶层直调设置。

---

## 10. 数据布局与兼容（不引入新版本号；`index.json` 只加 1 个键）

```
<projectId>/
├─ index.json        # 追加：adviceLog: AdviceRecord[]（≤50）  ← 唯一新键
├─ querylog.jsonl    # 不动
└─ sessions/*.json   # 文件体 {version:2, sessionId, nodes} 不变，节点自然含三种 type
```

### 10.1 `strategySets` 从 `index.json` 删除（v2.1 重大更正）

v2 把 `SetMeta` 放进 `index.json`，复核发现**必须去掉**，理由三条，每条都是真实 bug：

1. **`patchNode` 不置 `indexDirty`**（`store.ts:463-478` 只加 `dirtySessions`）→ `pickStrategy` 若用 `patchNode` 改 `set.chosenAltId`，而 `SetMeta` 在 `index.json`，**改动永远不落盘**；必须额外手动 `indexDirty = true`，漏写就静默分叉。
2. **`rebuildFromSessions` 会丢 index 键但节点健在**（`store.ts:206-254`，`dreamRuns` 在 `:240` 被重置为 `{}`）——这条路真实发生（现有测试 `test/store.test.mjs:153-172`）。→ `strategySets` 只在 index 里就会在重建后全丢，而 set 节点还在，**状态视图与节点视图不一致**。
3. **推导成本≈0，纯冗余**：`SetMeta` 所需信息（`problem`/`altIds`/`chosenAltId`/`createdAt`）全部是 `strategy_set` 节点字段的投影；节点本就全量在内存，构造函数 `store.ts:192` 的既有全量循环里折叠建索引 = 零额外扫描，且 rebuild 后天然存活。

**v2.1 方案：改为派生索引。**

```
store.ts:192  构造函数的 for (node of data.nodes) 循环内折叠建 setIndex
失效钩子：commit（store.ts:454-459）与 patchNode（store.ts:463-478）
          —— 全仓仅这两处改节点（Object.assign 是唯一外部 mutation 入口）
```

**派生索引与 childIndex（§7.1）同用一套失效钩子**，不新增任何持久化。

### 10.2 `adviceLog` 的读写（保留，但插入点要对）

`adviceLog` 无节点对应物、有 FIFO≤50 + 同 set/alt 去重更新语义（§8），**保留在 `index.json`**。它与 `dreamRuns` 同属"衍生产物"，rebuild 时丢弃与现状一致。

- **写入**：挂在 dream 已有的 `recordDream` → `indexDirty` 周期里（`store.ts:520-524`，调用点 `dream.ts:114,221`），**不新增独立 persist** → 零额外磁盘 IO。
- **懒补插入点**：`store.ts:341` 汇合处 `data.adviceLog ??= []`。**必须在这里，不能只加在加载门** —— 数据构造点共 4 处，漏一处就复现 `dreamRuns` 的 undefined 坑：

| 构造点 | 位置 | 风险 |
|---|---|---|
| rebuild | `store.ts:230-241` | 安全（已写死 `{}`） |
| index 加载 | `store.ts:276-287` | **危险源头** |
| legacy V1 迁移 | `store.ts:311`（`data = legacy`） | **最危险，整个 StoreData 从 `memory.json` 读回、新键必然缺失** |
| fresh | `store.ts:327-339` | 安全 |

> **undefined 坑的机制**（务必理解后再动手）：`store.ts:286` 直接取 `index.dreamRuns`，缺失时 `data.dreamRuns === undefined` → `recordDream` 的 `this.data.dreamRuns[runId] = run`（`store.ts:521`）直接 TypeError；同时 `buildIndex:686` 每次产出 undefined 被 `JSON.stringify` 丢弃，**磁盘键永远修不回来**（自持循环）。新键若照抄 `:286` 写法会以同样方式崩。`tsconfig.json:4` target=ES2022，支持 `??=`。

`index.json` 已有 `version: 2`（`DISK_VERSION`，`store.ts:47`、加载门 `store.ts:275`），**不再新增 schemaVersion**。

- **读取**：解析后 `Array.isArray(index.adviceLog) ? index.adviceLog.filter(isValidAdvice) : []`，单条缺 `setId`/`recommendedAltId`/`margin` 非数的逐条丢弃 + `logger.warn`（复用 `querylog.ts:65-78` 的坏行跳过风格）。**门条件（`store.ts:275`）不动** —— 若把 `adviceLog` 塞进门，一条脏数据就会掉进 `rebuildFromSessions`，**policies 和 dreamRuns 全丢**（`:238-241` 只恢复节点），代价完全不对等。
- **写入**：`buildIndex()`（`store.ts:678-688`）照常带上 `adviceLog`，旧库首次保存时自然补全。
- **节点文件不重写**：旧节点缺 `type` 在内存按 `experience` 处理（`store.ts:292-294` 宽松读取：未知字段原样保留、缺字段不补默认），不主动回填落盘。

---

## 11. 落地步骤与估时（约 4 天，比 v2 多 0.5 天 —— 补了状态控制/异常处理/policy 抽取）

| 步骤 | 内容 | 预估 |
|---|---|---|
| 0 | 抽出 `src/lib/policy.ts`（§14.2，纯搬移 + `store.ts` 改 import，回归必须绿） | 0.5 天 |
| 1 | `NodeRecord` 加可选 `type`；**5 处 `type === "experience"` 过滤**（§3.1）；`index.json` 懒补 `adviceLog` 于 `store.ts:341`（§10.2） | 0.5 天 |
| 2 | 新建 `src/lib/strategy.ts` 纯函数（§14.1）；`store.ts` 加 `batchPatch`/`proposeStrategySet`/`pickStrategy`/派生 set 索引/`descendantsOf`+childIndex/`commit` 自动挂靠 | 1.5 天 |
| 3 | 两个工具 + 护栏 + 菜单/系统提示 + 空 `sessionID` guard（§5、§5.5） | 0.5 天 |
| 4 | dream 互斥门 + 分支评估 + adviceLog + search 注入 + status 展示（§7、§8、§15.2） | 0.5 天 |
| 5 | 测试：propose/pick/挂靠/advice/并发/异常/回归（§12） | 0.5 天 |

---

## 12. 测试与验收

沿用 `node --test` + `test/*.test.mjs`（测试 import `dist/lib/*.js`，需先 build）。

- [ ] 旧记忆库（无 `type`、无 `adviceLog`）启动不报错、数据不丢，且**节点文件不被重写**
- [ ] `propose` 建 3 候选 → 3 个 alt 正确落盘；`alternatives.length < 2` 被拒；重复 `problem` 命中已有 set 且 `alreadyExisted === true`
- [ ] **`provisionalPick` 后创建的第二个 alt，其 `parentId` 仍是 `setId` 而非第一个 alt**（§5.1 的劫持防护）
- [ ] `pick` 切换后，后续 `commit`（不传 `parentId`）的父正确指向新 alt；**显式传 `parentId` 时不被覆盖**
- [ ] **`pick` 原子性**：批量 patch 后单次落盘；中断模拟下不会出现 0 个或 2 个 chosen
- [ ] **每会话 ≤1 chosen 不变量**：先后 pick 两个不同 set，`resolveActiveAlt` 返回的是**最后一次 pick**（不是创建序最后的那个 alt）
- [ ] `pick(verdict="superseded")` 不写 outcome、`verdict="rejected"` 写 `failed`
- [ ] 两个 alt 各 ≥3 个子节点后，`dream` 在 `adviceLog` 产出胜率更高的建议；差值不足 `adviceDelta` 时不产出
- [ ] `search` 命中同类问题时注入 ≤1 条 advice 且标注来源
- [ ] **`adviceLog` 脏数据**：单条缺 `recommendedAltId` → 该条被丢弃，**不触发 rebuild**，`policies`/`dreamRuns` 完好
- [ ] **空 `sessionID`**：commit 工具收到空串不落 `unknown` 桶
- [ ] **`descendantsOf` 悬空 `parentId`**：返回 `[]` 不抛
- [ ] **回归**：现有 7 浮点检索策略的 dream 数值基线与改动前**完全一致**（现有测试全绿；这是 §3.1 五处 type 过滤是否到位的唯一判据）

---

## 13. 风险与已知限制

1. **候选质量取决于主 agent 自觉**：工具只做规则校验，不做语义把关。缓解：菜单/系统提示引导 + §5.3 护栏 + `problem` 去重防膨胀。
2. ~~**自动挂靠可能挂错**：同一会话内先后走两个 set 时，取「最后一次 pick」~~ → **v2.1 已消除**：改为「每会话 ≤1 chosen」不变量（§4.1），`resolveActiveAlt` 候选恒为 0 或 1，排序问题从根上消失。残余风险是**挂靠语义本身**：pick 之后本会话所有 commit 都挂到该 alt 下，即使决策已结束。缓解：显式 `parentId` 永远优先，agent 可随时打断。
3. **分支建议是复盘不是预测**：只在 ≥2 条分支都被真实走过、且差值过门槛时产出；新项目零历史无建议，这是设计选择。
4. **切换决策权不在 dream**：dream 永不自动改 status/chosenAlt，只写 adviceLog。
5. **跨项目不迁移**：仍按工作区路径哈希隔离（沿用现状）。
6. **跨 opencode 进程不做一致性保证**（v2.1 新增说明）：进程内靠「同步突变 + `writeChain` 串行队列 + per-session 脏文件」（`store.ts:176,697-704,714-716`）足够安全；跨进程有 3 个既有洞 —— 无文件锁、`cleanupStaleTmp`（`store.ts:86-98`）会误删他进程正在写的 tmp、`index.json` 整文件 last-writer-wins。本次只做一处最小收窄：`cleanupStaleTmp` 按 pid + mtime 过滤，避免它自己成为破坏源。多进程同时操作同一 set 属中风险，需明示不做。
7. **跨会话不传播**：`resolveActiveAlt` 按 `sessionId` 过滤 → set 在会话 A 提出、会话 B 继续做时 B 无 chosen，走既有默认挂最近节点 → 该 set 等不到 outcome。opencode 换 tab/恢复会话就是新 sessionID，策略库会长期零样本。这是 per-session 隔离的代价，属设计取舍。

---

## 14. 模块结构（v2.1 新增）

### 14.1 模块全景：新增 2 个 + 改若干

```
L0 纯类型/纯函数  types.ts ← scoring.ts / stages.ts / querylog.ts / logger.ts
                        ↑
L0.5 新增          strategy.ts   ← 只 import types/utils/scoring/stages
                        ↑
L1 轻逻辑          policy.ts（新，从 store 抽出） / utils.ts / prompts.ts / menu.ts / config.ts
                        ↑
L2 领域服务        store.ts（瘦） / replay.ts / report.ts / meta-llm.ts
                        ↑
L3/L4 编排与适配   dream.ts / tools.ts / runtime.ts / hooks.ts / index.ts / v1-host.ts
```

| 文件 | 角色 | 改动量 |
|---|---|---|
| **`src/lib/strategy.ts`**（新增） | 纯函数：护栏校验、Wilson 打分、advice 产出、active-alt 推导、`descendantsOf`/`buildChildIndex`。**不碰 I/O** | ~200 行 |
| **`src/lib/policy.ts`**（新增） | 从 `store.ts:109-164` 搬出（`makePolicy`/`seedPolicies`/`initialPolicies`/`StoreLoadOptions`） | 搬移 ~60 行 |
| `src/lib/types.ts` | 加可选 `type?: NodeType` + `NodeType`/`AdviceRecord` 类型 | +25 行 |
| `src/lib/store.ts` | `batchPatch`/`proposeStrategySet`/`pickStrategy`/派生 set 索引/`descendantsOf`/`commit` 挂靠/`adviceLog` 懒补 | +100 行 −60 行（净 +40） |
| `src/lib/tools.ts` | 2 个新工具 + 空 `sessionID` guard + search 注入 + status 概览 | +120 行 |
| `src/lib/dream.ts` | 互斥门 + 只读分支评估段 + `adviceLog` 写入 | +30 行 |
| `src/lib/replay.ts` / `report.ts` / `store.ts` | 5 处 `type === "experience"` 过滤（§3.1） | 每处 1 行 |
| `src/lib/prompts.ts` | 菜单行 + WHEN 条件 | +4 行 |

**零环保证**：`strategy.ts` **不值 import `store`**（照抄既有破环惯例 `store.ts:31 → replay` + `replay.ts:3 import type`）；`dream`/`tools`/`report` 单向消费 `strategy`。禁止 `strategy` 反向 import `dream`/`report`/`config`/`store`（值）/ 任何 L3-L4 模块。

**`strategy.ts` 核心签名**（全部纯函数，可脱离磁盘测试）：

```ts
checkPropose(input: ProposeInput, existingSets: SetMeta[]): ProposeCheck
resolveActiveAlt(nodes: NodeRecord[], sessionId: string): NodeRecord | null
buildChildIndex(nodes: NodeRecord[]): Map<string, string[]>
descendantsOf(nodeId, childIndex, nodesById): NodeRecord[]
wilsonLowerBound(w: number, n: number, z = 1.0): number
scoreAlt(subtree: NodeRecord[], minSubtreeNodes: number): number | null
adviseSet(setId, alts, cfg): AdviceRecord | null
```

`similarity()` **不新写**：直接 `tokenSimilarity(tokenizeText(a), tokenizeText(b))`，复用 `scoring.ts:121` 与 `scoring.ts:14`（后者已处理 CJK 二元组，`scoring.ts:23-26`）。

### 14.2 降复杂度：抽出 `policy.ts`

`store.ts` 现 **728 行、5 类职责**，是全仓最胖模块（Agent A 定位）。其中 `:109-164`（`makePolicy`/`seedPolicies`/`initialPolicies`/`StoreLoadOptions`）是独立的策略工厂，只依赖 `types`+`utils`，搬出后：

- 新增 L1 叶子 `policy.ts`，`store.ts` 改为 import 它
- `store.ts` 入度**不增反减**（现 6 个引用方：`dream`/`hooks`/`replay`/`report`/`runtime`/`tools`，多数是 `import type`）
- 作为**步骤 0 独立落地**，回归必须先绿，再动后续步骤

> 另一候选「拆 `recall.ts`（把 `store.ts:569-647` 参数化，消灭 store↔replay 唯一环）」**列为 Phase 2**，不在本次范围 —— 它牵动 replay 签名与测试基线，爆炸半径大。

---

## 15. 状态控制与并发（v2.1 新增）

### 15.1 进程内模型（现状已够用，不新增锁）

一个 opencode 进程 = 1 个 `MemoryStore` 实例（`runtime.ts:55` 唯一 `load` 调用点），同进程所有 agent/session 共享。安全性来自既有机制：

| 机制 | 位置 | 作用 |
|---|---|---|
| 同步突变 + 同步快照 | `store.ts:697-704` | 新节点必进本次快照，并发 mutator 不丢更新 |
| `writeChain` 串行队列 | `store.ts:176,708-726` | 落盘不交错 |
| per-session 脏文件 | `store.ts:180,714-716` | 各写各的 session part，互不覆盖 |
| `atomicWrite`（tmp + rename） | `store.ts:66-78` | 崩溃不留半截文件 |

**本次不新增任何锁。** 理由：进程内已有足够保证；跨进程是既有问题（§15.5），不在策略库扩展范围内。

### 15.2 dream 互斥（用现成字段，成本≈0）

两个 dream 并发会互相覆盖 `patchNodePolicy`（`store.ts:421-426`），provisional 转正逻辑（`dream.ts:206-208`）语义会乱。`types.ts:72` 的 `DreamStatus` 已预留 `"queued"|"running"|"failed"`，但实现只写 `"done"`（`dream.ts:114-122,221-229`）。

**修法**：`runDream` 入口置 `running`，出口（成功/异常 `finally`）置 `done`/`failed`；入口检查若已是 `running` 则直接返回文本。**用现成字段，不加新键。**

### 15.3 `batchPatch`：pick 的原子性

`pickStrategy` 涉及 3 次 `patchNode`（旧 alt / 新 alt / set）。若各自 `void this.persist()`（`store.ts:476`），中断会留下「0 个 chosen」或「2 个 chosen」，且代码无「每 set 唯一 chosen」不变量校验。

```ts
batchPatch(patches: Array<[nodeId: string, patch: Partial<NodeRecord>]>): void
  // 同步 apply 全部 Object.assign → 重算受影响的 session 分组
  // → dirtySessions.add（去重）→ replayCache = null → 单次 persist()
```

`persist()` 内部本就是「同步拍快照 → 排队异步写」，批量 apply 后单次调用即可保证原子性。

### 15.4 空 `sessionID` guard

`sessionKeyOf = node.sessionId || "unknown"`（`store.ts:105-107`）—— 所有空 sessionId 节点共用一个文件与分组。hooks 的 command 路径有 guard（`hooks.ts:95`），但 **commit 工具没有**（`tools.ts:53-77` 直接透传 `ctx.sessionID`）。

宿主给空串 → 落 `unknown` 桶 → `resolveActiveAlt` 跨会话串味。**修法**：commit 工具 `execute` 开头 `if (!sessionID) return` 一行。

> sessionId 清洗本身不致碰撞：`sessionFileName`（`store.ts:100-103`）= 非法字符替换 + 截 80 字符 + `-sha1(完整 sessionId)[0:8]`，唯一性由摘要后缀保证。

### 15.5 跨进程（明确不做 + 一处最小收窄）

**三个既有洞**（与本次扩展无关，但需记录）：

1. **无文件锁**（grep `lock|mutex` 仅命中 `store.ts:74` 注释）
2. **`cleanupStaleTmp` 自己就是破坏源**：`store.ts:86-98`（调用点 `:712-719`）每次 persist 删掉目录里**所有** `.tmp-` 文件 → 进程 B 会删掉进程 A 正在写的 tmp，A 的 `rename` 抛错后被静默吞（`:723-725`）→ **静默丢一次写**
3. **`index.json` 整文件快照回写**，两进程 last-writer-wins

**本次处置**：只做一处最小收窄 —— `cleanupStaleTmp` 按 **pid + mtime** 过滤（只删非本进程且超龄的 tmp）。其余**明确不做**，在文档明示：多 opencode 进程同时操作同一 set 属中风险。

> 设计文档 `docs/Dream-RSI-记忆库设计方案.md:727-728` 曾承诺「SQLite 单写连接 + busy_timeout」，实际是 JSON 文件 + 全仓无锁 —— 该承诺未落地，本次也不去补。

---

## 16. 异常处理与失败面（v2.1 新增）

### 16.1 全仓约定（决定 propose/pick 的返回形态）

- **工具层从不 throw**，错误一律返回 `[dream-rsi-memory] ` 前缀中文串 + 「可用：…」列表（`tools.ts:169-175`、`report.ts:81`）
- **store 层返回 `undefined`/`null`/`[]`**
- **可恢复的脏数据** try/catch 后跳过 + `logger`
- **只有底层 IO / 宿主能力缺失才 throw**（`store.ts:76` rename 失败 rethrow、`v2-compat.ts:253`）

`commit` 从不校验、永不失败（`store.ts:428-461`）：`parentId` 悬空 → `parent=undefined`、节点照建、`branchId` 回落自身（`:431-432`）。→ §4 的 active-alt 挂靠插入后，**悬空 alt 天然被容忍，不用额外守卫**。

### 16.2 失败面清单

| 场景 | 返回 |
|---|---|
| `alternatives.length < 2` / `> 5` | `[dream-rsi-memory] 候选数需 2~5，当前 ${n} 个。` 不写库 |
| `name` 重复 | `[dream-rsi-memory] 候选 name 重复：a、b（set 内需唯一）。` 不写库 |
| 任一字段超长 | 点名字段与限长（problem≤80 / name≤20 / approach≤300 / tradeoffs≤200 / estimatedRisk≤200） |
| `problem` 与已有 set 相似 | 复用：`[dream-rsi-memory] 与已有决策问题相似，复用 set ${setId}：${problem}` |
| `provisionalPick` 不在 alternatives 中 | 拒绝（静默忽略会让调用方以为选中了）：`[dream-rsi-memory] provisionalPick "${x}" 不在 alternatives 中。` |
| `pick` 的 `setId` 不存在 | `[dream-rsi-memory] 策略集 ${setId} 不存在。可用：${ids...}` |
| `pick` 的 `altName` 不属于该 set | 中文串 + 列出该 set 的可用 altName |
| `pick` 目标已是 `chosen` | 幂等成功 `{previousAlt: null, currentAlt, note: "已在该分支"}`（对齐 `setActivePolicy` `store.ts:411-418`） |
| `pick` 目标已 `superseded`/`rejected` | **拒绝并报当前状态**，不得静默按 `unproven` 处理（污染 §6 胜率） |
| `commit` 的 `parentId` 悬空 | store 保持容忍不阻断；工具层加 `⚠ parentId ${id} 不存在，已挂为根节点`（仿 `tools.ts:136`） |
| `adviceLog` 单条/整体类型坏 | 逐条 filter 丢弃 + `logger.warn`（仿 `querylog.ts:65-78`），**不触发 rebuild** |
| `adviceLog` > 50 | 静默 FIFO 裁最旧（仿 `querylog.ts:45-49`），不进工具返回 |
| `descendantsOf` 起点不存在 / 悬空 `parentId` | 返回 `[]`，不抛；打分自然落入 `n < minSubtreeNodes → null` |
| set 的 `altIds` 含不存在 nodeId | 打分前 filter；展示复用 `report.ts:81` 的不存在串 |
| 新键导致 persist 写盘失败 | 与现状一致：`store.ts:723-725` 吞掉 + `logger.error`，工具照常返回成功 |

### 16.3 `adviceLog` 脏数据的特殊约束（最重要的一条）

**任何一条新键的脏数据都不得让 `load` 掉进 `rebuildFromSessions`。**

`load` 的 index 门（`store.ts:275`）只看 `version === DISK_VERSION && index.policies && index.activePolicyId`。若把 `adviceLog` 塞进门条件，一条脏数据就会触发 rebuild —— 而 rebuild **只恢复节点**，`policies` 和 `dreamRuns` 会被重置为初始值（`:238-241`）→ **策略库历史与 dream 运行记录全丢**。代价完全不对等。

正确做法：门条件不动；解析后 `Array.isArray(index.adviceLog) ? index.adviceLog.filter(isValidAdvice) : []`，单条缺 `setId`/`recommendedAltId`/`margin` 非数的逐条丢弃。

**一句话规范**：用户输入类失败 → 返回中文串 + 可用列表；数据不存在类 → store 返回 `undefined`/`[]`，工具层翻译成中文；脏数据类 → 静默跳过 + logger；**新键脏数据绝不动 `load` 门**。
