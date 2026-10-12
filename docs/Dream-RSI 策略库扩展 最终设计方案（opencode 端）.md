# Dream-RSI 策略库扩展 · 最终设计方案（opencode 端）

> 本文是**实现依据定稿**。前身 [`Dream-RSI 策略库扩展方案 v2（opencode 端）.md`](<Dream-RSI 策略库扩展方案 v2（opencode 端）.md>) 保留修订理由与逐条更正记录；本文按「模块依赖 → 数据流 → 调用层级 → 状态管理 → 错误处理」四轴重组，并内联 4 路并行代码侦察的实证结论。
>
> 所有 `文件:行号` 均为当前代码库实测，非推测。

---

## 0. 目标、边界与论文归属

### 0.1 目标：三段闭环（人工起点 + 数据优化）

在现有「检索策略进化」之外，新增**设计决策策略库**：

```
【段1 首次·人工选】  新设计决策，search 发现库里无该问题的候选
  → 模型（经提示词驱动）开 sub-agent 并行探索 ≥20 个方向
  → 模型自己的 LLM 筛出约 5 个可靠的
  → question 工具与用户交互 → 用户选 1 个       ← 人工冷启动，非自动
  → propose 入库候选（全部 unproven）+ pick 选中的 → chosen
  → 开始执行

【段2 持续·累积】    commit 挂 chosen 子树，累积真实 outcome

【段3 优化·自动】    dream 跑
  → Wilson 打分「试过的」分支
  → 显著更优 → 自动 pick 切换 → 菜单通知
  → 回到段2 持续累积
```

**为什么人工只在冷启动**：首次没有 outcome 数据，dream 对未执行的候选打不出分（`n < minSubtreeNodes → score=null`），数学上不可能自动选优；此时人工判断是唯一信号。一旦累积了 outcome，交给数据（RSI 的意义：数据 > 直觉）。

**全程零新增后台 LLM**：插件不 spawn agent、不调 LLM、不与人对话——探索/筛选/交互全由 opencode 模型自己完成（它本来就有 subagent 与 question 工具），插件只提供工具 + 提示词指令。

### 0.2 架构边界（关键）

| 层 | 负责什么 | 载体 |
|---|---|---|
| **模型（opencode agent）** | 检测「无候选」→ 开 sub-agent 穷举 ≥20 → 筛 ~5 → question 与人选 1 → 调 propose+pick → 执行 | 系统提示 WHEN 条件驱动的工具循环 |
| **插件（dream-RSI-memory）** | 存候选、累积 outcome、Wilson 打分、自动切换、注入指令 | `propose`/`pick` 两个新工具 + 提示词注入 + dream 评估段 |

插件是**存储 + 评估引擎**，模型是**工作流引擎**。这个切分让插件守住「零 LLM」的立身之本。

### 0.3 边界（不做的事）

1. 不碰 Claude Code / MCP server。
2. 不新增后台 LLM 调用；不引入第二个记忆库。
3. 不改现有 6 个 `dream_rsi_memory_*` 工具的签名。
4. 插件代码内不 spawn sub-agent（探索由模型做）；不与人对话（交互由模型的 question 工具做）。
5. 不做跨进程一致性保证（§4.7 仅最小收窄一处）。
6. 不拆 `recall.ts`（store↔replay 环），列为 Phase 2。

### 0.4 论文归属分层（README 已同步）

**派生自 Dream-RSI 论文**（保留引用）：决策树历史、离线回放 Dreaming、`epsilon` 不退化门槛、进化对象是策略。
**本项目独立扩展**（不引用论文作为方法来源）：`strategy_set`/`strategy_alt` 节点 + `superseded` 第三语义、Wilson 下界 + `partial` 半权分支打分、**全自动分支切换**、`adviceLog` 检索注入、`propose`/`pick` 护栏、每会话 ≤1 `chosen` 不变量、提示词驱动的三段闭环工作流。

---

## 1. 模块依赖

### 1.1 分层全景

```
L0  纯类型/纯函数   types.ts  ←  scoring.ts / stages.ts / querylog.ts / logger.ts / config.ts / utils.ts
                          ↑
L0.5 新增纯函数      strategy.ts   （只 import types/utils/scoring/stages）
                          ↑
L1  轻逻辑/工厂      policy.ts（新，从 store 抽出） / prompts.ts / menu.ts / meta-llm.ts
                          ↑
L2  领域服务         store.ts（瘦） / replay.ts / report.ts
                          ↑
L3  编排             dream.ts / runtime.ts
                          ↑
L4  宿主适配         hooks.ts / tools.ts / index.ts / v1-host.ts / v2-compat.ts / opencode-install.ts
```

依赖方向严格自下而上。既有全仓唯一互引对是 `store.ts:31 → replay`（值）+ `replay.ts:3 → store`（`import type` 破环）——`strategy.ts` 照抄此惯例。

### 1.2 新增与改动文件

| 文件 | 角色 | 改动量 |
|---|---|---|
| **`src/lib/strategy.ts`**（新增） | 纯函数：护栏校验、Wilson 打分、advice 产出、active-alt 推导、`descendantsOf`/`buildChildIndex`。**不碰 I/O** | ~200 行 |
| **`src/lib/policy.ts`**（新增） | 从 `store.ts:109-164` 搬出 `makePolicy`/`seedPolicies`/`initialPolicies`/`LoadOptions` + `types.ts:52-70 PolicyRecord` | 搬移 ~60 行 |
| `src/lib/types.ts` | 加可选 `type?: NodeType` + `NodeType`/`AdviceRecord` | +25 行 |
| `src/lib/store.ts` | `batchPatch`/`proposeStrategySet`/`pickStrategy`/派生 set 索引/`descendantsOf`/`commit` 挂靠/`adviceLog` 懒补 | +100 −60 行 |
| `src/lib/tools.ts` | 2 个新工具 + 空 `sessionID` guard + search 注入 + status 概览 | +120 行 |
| `src/lib/dream.ts` | 互斥门 + **全自动分支评估与切换** + `adviceLog` 写入 | +40 行 |
| `src/lib/prompts.ts` | 系统帮助块 WHEN 第 4 条（工作流指令）+ 菜单动作行 | +6 行 |
| `src/lib/replay.ts` / `report.ts` / `store.ts` | 5 处 `type === "experience"` 过滤（§3.4） | 每处 1 行 |

### 1.3 零环保证

`strategy.ts` **不值 import `store`**（仅可 `import type`）。禁止 `strategy` 反向 import `dream`/`report`/`config`/`store`（值）/ 任何 L3-L4 模块。`dream`/`tools`/`report` 单向消费 `strategy`。

### 1.4 降复杂度：抽出 `policy.ts`

`store.ts` 现 **728 行、5 类职责**（策略工厂 `:109-164`、fs 原语 `:66-107`、加载 `:171-368`、API `:369-540`、打分 `:541-647`），是全仓最胖模块。抽出独立的策略工厂（只依赖 `types`+`utils`）后：新增 L1 叶子，`store.ts` 入度**不增反减**（现 6 引用方 `dream`/`hooks`/`replay`/`report`/`runtime`/`tools`，多为 `import type`）。作为**步骤 0 独立落地**，回归先绿再动后续。

---

## 2. 数据模型与数据流

### 2.1 `NodeRecord` 扩展

现有定义 `src/lib/types.ts:33-50`：必填 `nodeId:34`/`projectId:35`/`sessionId:36`/`agentName:37`/`summary:40`/`files:46`/`turnIndex:47`/`createdAt:48`；`outcome: Outcome` **必填:41**；可选 `parentId?:38`/`branchId?:39`/`score?:42`/`why?:43`/`errorMessage?:44`/`policyVersion?:45`/`autoCreated?:49`。

**扩展（只加一个可选字段）**：

```ts
type NodeType = "experience" | "strategy_set" | "strategy_alt";
type AltStatus = "unproven" | "chosen" | "superseded" | "rejected";   // 4 个，不新增
// NodeRecord 增加：type?: NodeType   // 缺省视为 "experience"
// StrategySetNode 额外字段：problem, altIds, chosenAltId?
// StrategyAltNode 额外字段：setId, name, approach, tradeoffs, estimatedRisk, status: AltStatus
```

**`outcome` 保持必填**，set/alt 节点填占位 `"partial"`。理由：若转可选，全仓 10 处读取点需改（`report.ts:21,84`/`hooks.ts:79,233`/`tools.ts:81,115`/`store.ts:604-610,673`/`opencode-install.ts:333`/`replay.ts:84-86,145`），爆炸半径大；保持必填 + 占位值净成本为 0，只需在 5 个打分/统计点按 `type` 过滤（§3.4）。

**状态机维持 4 个不变**（`unproven | chosen | superseded | rejected`）：未被筛中的候选就是 `unproven`，需要换分支时模型重新筛即可（模型随时有 LLM），插件不必标记「可靠短名单」——20→5 的筛选是模型侧的事，不入库。

### 2.2 落盘布局

- `<dataDir>/<projectId>/index.json`（`store.ts:263-264`）
- `<dataDir>/<projectId>/sessions/<sessionId 清洗>-<sha1(sessionId)[0:8]>.json`（`store.ts:100-103`），体为 `{version:2, sessionId, nodes: NodeRecord[]}`（`store.ts:60-64,702`）

`IndexFile` 7 键（`store.ts:50-58`，序列化 `:678-688`）：`version`/`projectId`/`rootPath`/`createdAt`/`activePolicyId`/`policies`/`dreamRuns`。

**本次 `index.json` 只加 1 个键：`adviceLog: AdviceRecord[]`。不加 `strategySets`。**

### 2.3 `strategySets` 为何删除（推导而非存储）

若把 set 元数据写进 `index.json`，有三处致命问题（侦察证实）：

1. **`patchNode` 不置 `indexDirty`**（`store.ts:463-478`）→ `pick` 改的 `chosenAltId` 永远不落盘；而 `persist` 只在 `needIndex = this.indexDirty`（`:692`）时写 index.json。状态更新静默丢失。
2. **`rebuildFromSessions`（`:206-254`）会丢弃 index 键但节点健在**（测试 `test/store.test.mjs:153-172`）→ 双源分叉，index 与节点不一致。
3. **推导成本≈0**：set 元数据是 set 节点字段的纯投影，每次现算即可。

**改为派生索引**：在 `store.ts:192` 构造函数处遍历一次建 `Map<setId, SetMeta>`；失效钩子挂 `commit`（`:454-459`）与 `patchNode`（`:463-478`）——**全仓仅这两处改节点**。

### 2.4 `adviceLog` 的懒补与 undefined 坑

**磁盘不会落 `undefined`**（`JSON.stringify` 丢键），坑在**内存侧**：`store.ts:286` 直取 `index.dreamRuns`，缺失则 `data.dreamRuns === undefined` → `recordDream` 的 `this.data.dreamRuns[runId] = run`（`:521`）抛 TypeError，且 `buildIndex:686` 每次产出 `undefined` 被 `JSON.stringify` 丢键 → **磁盘键永远修不回来（自持循环）**。`adviceLog` 绝不能复制这个行为。

**懒补必须覆盖 4 个数据构造点**，统一在汇合点 `store.ts:341` 写 `data.adviceLog ??= []`（`tsconfig.json:4` target=ES2022 支持 `??=`）。最危险的是 legacy V1 迁移 `store.ts:311 data = legacy`。

### 2.5 数据流总览

```
【写】propose  → tools.ts → store.proposeStrategySet()
                     ├─ 新增 1 个 strategy_set 节点（parentId=显式传入或缺省）
                     ├─ 新增 N(3~10) 个 strategy_alt 节点（parentId=setId, branchId=alt自身id, status=unproven）
                     └─ 每节点走 commit 路径 → appendToSession → dirty → replayCache=null → void persist()

【写】commit   → tools.ts → store.commit(input)
                     ├─ 显式 parentId 优先
                     ├─ 未传且有 active alt → 填 active alt 的 id（§4.1）
                     └─ appendToSession → dirty → replayCache=null → void persist()

【写】pick     → tools.ts → store.pickStrategy()   （agent 手动换路 / 冷启动选 1 个）
                     ├─ batchPatch 一次 apply 3 个 patch（旧alt/newalt/set）
                     ├─ 单次 persist（原子性 §4.5）
                     └─ 写 1 条隐式记录节点（outcome=partial, parentId=setId）

【写】dream自动切换 → dream.ts → store.pickStrategy()  （全自动，§4.8）
                     ├─ 评估产出 best（margin > autoSwitchDelta 且 best ≠ 当前 chosen）
                     ├─ 复用 pickStrategy 原子切换（旧 chosen → superseded）
                     └─ adviceLog 追加 + 菜单告知 agent 已切换

【读】search   → tools.ts → store.search()
                     ├─ scoreCandidates（:569，按 type 过滤 §3.4）
                     ├─ strategy_set 高权重命中 + 注入 adviceLog
                     └─ replayCache 缓存命中

【读】dream    → tools.ts → dream.runDream()
                     ├─ 互斥门（§4.4）
                     ├─ 现有浮点 replay（照常）
                     └─ 分支评估 + 全自动切换（§4.8） → 产出 adviceLog → recordDream
```

---

## 3. 调用层级

### 3.1 层间契约

| 层 | 职责 | 失败约定 |
|---|---|---|
| L4 宿主适配 | 参数解析、空 `sessionID` guard、把 store 返回翻译成中文串 + 「可用：…」 | **从不 throw**，返回 `[dream-rsi-memory] ` 前缀串（`tools.ts:169-175`、`report.ts:81`） |
| L3 编排 | 互斥门、串联 replay + 分支评估 + 自动切换、写 adviceLog | 捕获后写 `logger`，返回文本 |
| L2 领域服务 | 节点增删改、落盘、打分 | 返回 `undefined`/`null`/`[]`；脏数据 try/catch 跳过 + logger |
| L0.5 纯函数 | 校验、Wilson、推导、树遍历 | 返回判定结果对象，**不抛** |

**只有底层 IO / 宿主能力缺失才 throw**：`store.ts:76`（rename 失败 rethrow）、`v2-compat.ts:253`。

### 3.2 模型侧工作流（提示词驱动，插件不参与执行）

模型读到系统帮助块 WHEN 第 4 条后，自己循环完成：

```
1. dream_rsi_memory_search 查库 → 确认无该问题的候选 set
2. 开 sub-agent 并行探索 ≥20 个方向（各含 approach/tradeoffs/estimatedRisk）
3. 自己的 LLM 筛出约 5 个可靠的
4. question 工具与用户交互 → 用户选 1 个
5. dream_rsi_memory_strategy_propose 入库（收筛后的 3~10 个）
6. dream_rsi_memory_strategy_pick 定为当前分支
7. 开始执行；后续 commit 自动挂该分支
```

插件只在第 1、5、6 步被调用；第 2-4 步是模型自己的 subagent + question 能力。

### 3.3 `propose` 调用链（插件侧）

```
tools.ts: dream_rsi_memory_strategy_propose.execute(args, ctx)
  → 校验空 sessionID（guard）
  → strategy.checkPropose(args, store.setMetaList())   // 纯规则护栏，不调 LLM
      ├─ alternatives.length ∈ [3, 10]
      ├─ name set 内去重
      ├─ problem 与历史 set 相似（scoring.ts:121 tokenSimilarity + :14 tokenizeText）
      │    └─ 相似 → 返回 alreadyExisted + 该 setId（不新建）
      └─ 字段超长 → 返回点名字段
  → store.proposeStrategySet({ problem, alts, provisionalPick, parentId })
      → 逐节点 commit（见 §2.5 propose 路径）
  → 返回 { setId, altIds, alreadyExisted, note }
```

### 3.4 `pick` 调用链（agent 手动换路 / 冷启动选 1 个）

```
tools.ts: dream_rsi_memory_strategy_pick.execute(args, ctx)
  → store.pickStrategy({ setId, altName, reason, verdict })
      ├─ setId 不存在 → 返回 undefined（工具层翻译中文 + 可用列表）
      ├─ altName 不属于该 set → 返回 undefined
      ├─ 目标已 chosen → 幂等返回 {previousAlt:null, currentAlt, note:"已在该分支"}
      │    （对齐 setActivePolicy store.ts:411-418）
      ├─ 目标已 superseded/rejected → 拒绝并报当前状态（不静默按 unproven）
      └─ batchPatch([...]) → 单次 persist（§4.5）
      → 写 1 条隐式记录节点（outcome=partial, parentId=setId）
  → 返回 { previousAlt, currentAlt, note }
```

`pick` 同时服务两个场景：**冷启动**（人选 1 个定为 chosen）与**手动换路**（撞墙时切下一个）；日常最优分支选择由 dream 自动完成（§4.8）。

### 3.5 打分/统计点的 `type` 过滤（5 处，必做）

set/alt 节点进入 `sortedNodes()` 后，会被现有 5 个读取点当成普通经验节点，稀释统计。**必须按 `type === "experience"` 过滤**：

| 位置 | 危害（不过滤） |
|---|---|
| `replay.ts:66-92` `evalRange` | 把 set/alt 当 target 稀释 `recallBudget`，浮点 replay 数值漂移 |
| `store.ts:381` `count()` → `report.ts:32` `getStage` | 节点数虚增，提前触发 S→M→F 阶段切换 |
| `store.ts:569` `scoreCandidates` | set/alt 混入检索候选 |
| `store.ts:664` `onlineStats` | 策略胜率被 set/alt 稀释 |
| `report.ts:18-24` 概览 | set/alt 计入经验统计 |

**这是「现有 7 浮点 replay 数值基线不变」的唯一判据**。

---

## 4. 状态管理

### 4.1 会话态：active alt 从节点推导（零新增持久化）

```ts
// strategy.ts 纯函数
resolveActiveAlt(nodes: NodeRecord[], sessionId: string): NodeRecord | null
```

取**本会话最后一个 `type==="strategy_alt"` 且 `status==="chosen"` 的节点**。挂靠优先级：

1. 显式传 `parentId` → 以显式为准（不改现有行为，agent 可随时打断挂靠）
2. 未传且有 active alt → 自动填 active alt 的 id（`branchId` 一并继承 active alt 的）
3. 未传且无 active alt → 维持现状（缺省父）

**排序键更正**：不能按 `turnIndex` 排序取最后。`patchNode` 只 `Object.assign` 不改 `turnIndex`（`:467`）→ 先 pick b2(turn 21) 后 pick a1(turn 10) 会错误返回 b2。正确做法是**每会话 ≤1 `chosen` 不变量**（§4.2），使「最后一个 chosen」无歧义。

复杂度：每次 commit 扫本会话节点一次，O(本会话节点数)，可接受。

### 4.2 不变量：每会话至多一个 `chosen`

由 `pickStrategy` 强制：切换前先把本会话所有 `status==="chosen"` 的 alt 置为 `verdict`（`superseded`/`rejected`），再置新 alt 为 `chosen`。这样 §4.1 的「最后一个 chosen」推导天然正确，且不会出现「provisionalPick 后创建的 alt#2 挂到 alt#1 下」的劫持（§2.5 已通过显式 `parentId`/`branchId` 规避）。

**dream 自动切换复用同一 `pickStrategy`**，不变量自动保持。

### 4.3 进程内并发（现状已够用，不新增锁）

一个 opencode 进程 = 1 个 `MemoryStore` 实例（`runtime.ts:55` 唯一 `load` 调用点）。安全性来自既有机制：

| 机制 | 位置 | 作用 |
|---|---|---|
| 同步突变 + 同步快照 | `store.ts:697-704` | 新节点必进本次快照，并发 mutator 不丢更新 |
| `writeChain` 串行队列 | `store.ts:176,708-726` | 落盘不交错 |
| per-session 脏文件 | `store.ts:180,714-716` | 各写各的 session part，互不覆盖 |
| `atomicWrite`（tmp+rename） | `store.ts:66-78` | 崩溃不留半截文件 |

**本次不新增任何锁。**

### 4.4 dream 互斥（复用现成字段，成本≈0）

两 dream 并发会互相覆盖 `patchNodePolicy`（`store.ts:421-426`），provisional 转正（`dream.ts:206-208`）语义乱。`types.ts:72 DreamStatus` 已预留 `"queued"|"running"|"failed"`，但实现只写 `"done"`（`dream.ts:114-122,221-229`）。

**修法**：`runDream`（`dream.ts:93`）入口置 `running`，出口（成功/异常 `finally`）置 `done`/`failed`；入口若已是 `running` 直接返回文本。**用现成字段，不加新键。**

### 4.5 `batchPatch`：pick 的原子性

`pickStrategy` 涉及 3 次 `patchNode`。若各自 `void this.persist()`（`store.ts:476`），中断会留下「0 个 chosen」或「2 个 chosen」，且代码无唯一性校验。

```ts
batchPatch(patches: Array<[nodeId: string, patch: Partial<NodeRecord>]>): void
  // 同步 apply 全部 Object.assign → 重算受影响 session 分组
  // → dirtySessions.add（去重）→ replayCache = null → 单次 persist()
```

`persist()`（`store.ts:690`）本就是「同步拍快照 → 排队异步写」，批量 apply 后单次调用保证原子性。

### 4.6 空 `sessionID` guard

`sessionKeyOf = node.sessionId || "unknown"`（`store.ts:105-107`）—— 空 sessionId 节点共用一文件与分组。hooks 有 guard（`hooks.ts:95`），**commit 工具没有**（`tools.ts:53-77` 直接透传 `ctx.sessionID`）。宿主给空串 → 落 `unknown` 桶 → `resolveActiveAlt` 跨会话串味。**修法**：commit 工具 `execute` 开头 `if (!sessionID) return`。

> sessionId 清洗不致碰撞：`sessionFileName`（`store.ts:100-103`）= 非法字符替换 + 截 80 + `-sha1(完整 sessionId)[0:8]`，唯一性由摘要后缀保证。

### 4.7 跨进程（明确不做 + 一处最小收窄）

三个既有洞：①无文件锁（grep `lock|mutex` 仅 `store.ts:74` 注释）②`cleanupStaleTmp`（`store.ts:86-98`，调用 `:712-719`）每次删目录所有 `.tmp-`，会删他进程在写的 tmp，rename 抛错被 `:723-725` 静默吞 → 静默丢一次写（它自己是跨进程破坏源）③`index.json` last-writer-wins。

**本次只收窄 ②**：`cleanupStaleTmp` 按 pid + mtime 过滤（只删非本进程且超龄的 tmp）。其余**明确不做**。

### 4.8 全自动分支切换（dream 内，非建议）

**触发条件**（§7.1 打分产出 `best` 且同时满足）：

1. `best.score - second.score > autoSwitchDelta`（默认 0.2，比 adviceDelta 0.15 更保守，避免频繁切换）
2. `best` ≠ 当前 `chosen`（否则已是当前分支，无切换）
3. 当前会话 `resolveActiveAlt(nodes, sessionId)` 返回非 null（有明确在执行的分支，切换语义清晰）
4. `best.n ≥ autoSwitchMinSamples`（默认 5，比打分门槛 3 更高，确保自动切换基于稳健样本）

**动作**（复用 `pickStrategy`，原子）：

```ts
// dream.ts 内，评估段结束后
if (canAutoSwitch(best, currentChosen, nodes, sessionId)) {
  store.pickStrategy({
    setId: set.nodeId,
    altName: best.name,
    reason: `dream 自动切换：${best.name} 显著优于 ${currentChosen.name}（margin=${margin}）`,
    verdict: "superseded",   // 旧 chosen 主动让位，不记 failed
  });
}
```

**切换的副作用处理**：

- **旧 chosen 的 outcome 不受影响**：子树节点已落盘，`superseded` 只改 `status`，不动 `outcome`（§5.2 三分语义）。
- **agent 感知**：菜单动作数组追加「策略库已自动切换到 alt X（原 Y），后续 commit 将挂到 X」；系统提示 WHEN 条件「当你收到策略库切换通知时，后续工作按新分支 approach 继续」。
- **回滚**：agent 可手动 `pick` 回旧分支（幂等）。

**为什么不做「无 active alt 时也自动切」**：若当前会话从未 pick 过任何 alt（`resolveActiveAlt` 返回 null），说明 agent 还没开始执行任何分支，此时「切换」没有意义——它会在下次 commit 时自动挂到新的 chosen（§4.1 规则 2），语义正确。

**残余风险（已接受）**：agent 在任务正中间调用 dream，可能触发切换、导致后续 commit 挂错分支。靠三条缓解（dream 显式调用而非后台守护、菜单强制通知、pick 幂等回滚），但窗口真实存在。

---

## 5. 工具接口

工具名统一 `dream_rsi_memory_strategy_*`（与现有 6 个同前缀，不引入第二前缀）。

### 5.1 `dream_rsi_memory_strategy_propose`

```ts
{
  problem: string;                 // ≤80 字，设计决策问题陈述
  alternatives: Array<{
    name: string;                  // ≤20 字，set 内唯一
    approach: string;              // ≤300 字，怎么实现
    tradeoffs: string;             // ≤200 字，代价/取舍
    estimatedRisk: string;         // ≤200 字，预估风险
  }>;                              // **3~10 个**（模型筛后的可靠短名单）
  provisionalPick?: string;        // alternatives[i].name，冷启动选中的那个
  parentId?: string;               // set 节点挂哪（省略走既有默认）
}
// 返回 { setId, altIds, alreadyExisted, note }
```

**必须显式传 `parentId` 与 `branchId`**：set 节点 `parentId` = 调用方传入（省略走既有默认挂最近经验节点）；每个 alt 节点 `parentId=setId`、**`branchId=alt 自身 id`**。否则 `store.ts:432` 让一个 set 下所有 alt 共享同一 `branchId`，且 `provisionalPick` 让某 alt chosen 后创建的 alt#2 会挂到 alt#1 下 → `descendantsOf(alt1)` 吞掉 alt#2 子树 → Wilson 统计双算。

**护栏**：`alternatives.length ∈ [3, 10]`；name set 内去重；problem 与历史 set 高相似返回 `alreadyExisted` 不新建；字段超长点名；`provisionalPick` 不在 alternatives 中则拒绝。

### 5.2 `dream_rsi_memory_strategy_pick`

```ts
{
  setId: string;
  altName: string;
  reason?: string;
  verdict?: "superseded" | "rejected";   // 缺省 superseded
}
// 返回 { previousAlt, currentAlt, note }
```

**pick 语义分层（避免污染统计）**：

| 情形 | status | outcome | Wilson 评分 |
|---|---|---|---|
| 纯放弃（无子节点、无 reason） | 保持 `unproven` | — | 不计入 |
| 主动让位给更优分支（含 dream 自动切换） | `superseded` | — | **不计入失败** |
| 真实证伪（撞墙/踩坑） | `rejected` | `failed` + `why` | 计入失败 |

消除 v1「A 成功但 B 更好」与「A 根本走不通」都被记 failed 的胜率失真。

### 5.3 现有工具角色（不动签名）

| 工具 | 角色 |
|---|---|
| `dream_rsi_memory_commit` | 累积 outcome；`parentId` 按 §4.1 自动挂靠（显式优先） |
| `dream_rsi_memory_search` | set 作为「决策入口」高权重命中 + 注入 adviceLog |
| `dream_rsi_memory_dream` | 浮点 replay 之外追加**分支评估 + 全自动切换**（§4.8） |
| `dream_rsi_memory_status` | 末尾追加策略库概览：set/alt 数、当前 chosen、最近 advice、最近自动切换 |
| `dream_rsi_memory_node` | 类型分派展示 set/alt 详情 |

### 5.4 提示词注入（两处，§0.2 架构边界的载体）

**① 系统帮助块**（`prompts.ts:9-28` `renderSystemHelpText()`）WHEN 列表追加第 4 条：

```
4. 你面临需要多路尝试的设计决策（技术选型/架构取舍/方案对比），且检索确认策略库没有该问题的候选——按「设计决策工作流」：开 sub-agent 并行探索 ≥20 个可行方向（每个含 approach/tradeoffs/estimatedRisk）→ 你的判断筛出约 5 个可靠的 → question 工具与用户交互确认选哪个 → dream_rsi_memory_strategy_propose 入库候选 → dream_rsi_memory_strategy_pick 定为当前分支。
```

同时在 WHEN 追加第 5 条（自动切换感知）：

```
5. 当你收到策略库自动切换通知时——后续工作按新分支的 approach 继续；若确认切错，可 dream_rsi_memory_strategy_pick 手动切回。
```

**② 菜单**（`prompts.ts:48-74` `renderMenuText()`）「可动作」列表加一行（现有约 117 tokens，上限 200，预算充足）：

```
- dream_rsi_memory_strategy_propose 设计决策候选入库 / strategy_pick 切换分支
```

`src/lib/menu.ts:14-38` `GateRegistry` 冷却门控**不动**。

---

## 6. 错误处理与失败面

### 6.1 全仓约定（决定返回形态）

- **工具层从不 throw**，错误返回 `[dream-rsi-memory] ` 前缀中文串 + 「可用：…」列表（`tools.ts:169-175`、`report.ts:81`）
- **store 层返回 `undefined`/`null`/`[]`**
- 可恢复脏数据 try/catch 跳过 + `logger`
- **只有底层 IO / 宿主能力缺失才 throw**（`store.ts:76`、`v2-compat.ts:253`）

`commit` 从不校验永不失败（`store.ts:428-461`）：`parentId` 悬空 → `parent=undefined`、节点照建、`branchId` 回落自身（`:431-432`）→ §4.1 挂靠插入后**悬空 alt 天然被容忍，不用额外守卫**。

### 6.2 失败面清单

| 场景 | 返回 |
|---|---|
| `alternatives.length <3` / `>10` | `[dream-rsi-memory] 候选数需 3~10，当前 ${n} 个（应先探索 ≥20 再筛）。` 不写库 |
| `name` 重复 | `[dream-rsi-memory] 候选 name 重复：a、b（set 内需唯一）。` 不写库 |
| 字段超长 | 点名字段与限长（problem≤80/name≤20/approach≤300/tradeoffs≤200/estimatedRisk≤200） |
| `problem` 与已有 set 相似 | 复用：`[dream-rsi-memory] 与已有决策问题相似，复用 set ${setId}：${problem}` |
| `provisionalPick` 不在 alternatives | 拒绝：`[dream-rsi-memory] provisionalPick "${x}" 不在 alternatives 中。` |
| `pick` 的 `setId` 不存在 | `[dream-rsi-memory] 策略集 ${setId} 不存在。可用：${ids...}` |
| `pick` 的 `altName` 不属于该 set | 中文串 + 列出该 set 可用 altName |
| `pick` 目标已 `chosen` | 幂等成功 `{previousAlt:null, currentAlt, note:"已在该分支"}`（对齐 `store.ts:411-418`） |
| `pick` 目标已 `superseded`/`rejected` | **拒绝并报当前状态**，不静默按 `unproven`（污染 §5.2 胜率） |
| `commit` 的 `parentId` 悬空 | store 容忍不阻断；工具层加 `⚠ parentId ${id} 不存在，已挂为根节点`（仿 `tools.ts:136`） |
| `adviceLog` 单条/整体类型坏 | 逐条 filter 丢弃 + `logger.warn`（仿 `querylog.ts:65-78`），**不触发 rebuild** |
| `adviceLog` > 50 | 静默 FIFO 裁最旧（仿 `querylog.ts:45-49`），不进工具返回 |
| `descendantsOf` 起点不存在 / 悬空 `parentId` | 返回 `[]`，不抛；打分自然落入 `n < minSubtreeNodes → null` |
| set 的 `altIds` 含不存在 nodeId | 打分前 filter；展示复用 `report.ts:81` 不存在串 |
| 新键 persist 写盘失败 | 与现状一致：`store.ts:723-725` 吞掉 + `logger.error`，工具照常返回成功 |
| dream 自动切换条件不满足 | 不切，正常返回浮点 replay 结果 |
| dream 自动切换 `pickStrategy` 失败 | catch + logger.error，dream 继续完成 recordDream；菜单告知「自动切换失败：...」 |

### 6.3 `adviceLog` 脏数据的特殊约束（最重要）

**任何新键的脏数据都不得让 `load` 掉进 `rebuildFromSessions`。**

`load` 的 index 门（`store.ts:275`）只看 `version === DISK_VERSION && index.policies && index.activePolicyId`。若把 `adviceLog` 塞进门条件，一条脏数据就触发 rebuild —— 而 rebuild **只恢复节点**，`policies` 和 `dreamRuns` 被重置为初始值（`:238-241`）→ **策略库历史与 dream 运行记录全丢**，代价完全不对等。

正确做法：门条件不动；解析后 `Array.isArray(index.adviceLog) ? index.adviceLog.filter(isValidAdvice) : []`，单条缺 `setId`/`recommendedAltId`/`margin` 非数的逐条丢弃。

**一句话规范**：用户输入类失败 → 中文串 + 可用列表；数据不存在类 → store 返回 `undefined`/`[]`，工具层翻译中文；脏数据类 → 静默跳过 + logger；**新键脏数据绝不动 `load` 门**。

---

## 7. 分支评估（dream 段，全自动）

### 7.1 打分

```
for 每个 strategy_set:
  for 每个 alt in set.altIds:
    subtree = descendantsOf(alt)         // 新增函数，以 parentId 建一次 childIndex 后 O(1)
    s = #success, f = #failed, p = #partial, n = s + f + p
    if n < minSubtreeNodes (默认 3): alt.score = null   // 样本不足，不参与比较
    else:
      w = s + 0.5 * p                    // partial 半权
      alt.score = wilsonLowerBound(w, n, z = 1.0)
  proven = alts.filter(a => a.score != null)
  if proven.length >= 2:
    best, second = 按 score 降序前两名
    margin = best.score - second.score
    if margin > adviceDelta (0.15) 且 两者 n ≥ minSubtreeNodes:
      → 产出 advice（写 adviceLog）
    if margin > autoSwitchDelta (0.2) 且 best.n ≥ autoSwitchMinSamples (5) 且 best ≠ 当前 chosen:
      → 触发全自动切换（§4.8）
```

Wilson 下界小样本天然保守，`z=1.0`（约 68% 置信）避免 n=3 过度严苛；`adviceDelta`/`autoSwitchDelta` 双门槛避免「差 0.01 也发建议/切换」。

### 7.2 与现有 dream 的关系

- 浮点参数 replay **照常跑，数值基线不变** —— **前提是完成 §3.5 的 5 处 `type` 过滤**。
- 分支评估**自动切换**（§4.8）：不切浮点 policy、不写节点、只改 strategy_alt 的 `status`（经 `pickStrategy`）。
- 达门槛才产出 advice + 自动切换，写入 `index.json` 的 `adviceLog`（§2.4 懒补）。

### 7.3 `descendantsOf`（新增，全仓现无树遍历）

全仓 grep `children|descendant|subtree` 零命中；`parentId` 仅 9 处（`types.ts:38,91`/`tools.ts:50,73`/`store.ts:430-431,440`/`report.ts:89-90`）。需 `buildChildIndex(nodes) → Map<parentId, childId[]>` 一次建索引，`descendantsOf` O(子树大小) 遍历。

---

## 8. adviceLog 与检索注入

**记录结构**（追加到 `index.json`，§2.4 懒补）：

```ts
interface AdviceRecord {
  setId: string;
  problem: string;
  recommendedAltId: string;
  recommendedAltName: string;
  margin: number;
  nBest: number;          // best 的子树节点数
  nSecond: number;
  autoSwitched: boolean;  // 是否触发了自动切换
  createdAt: string;
}
```

- 上限 50，FIFO 裁最旧（仿 `querylog.ts:45-49`）
- 注入：`search` 命中 `strategy_set` 时附加该 set 最新 advice；`status` 末尾显示最近 advice + 最近自动切换

---

## 9. 实现步骤（4 天）

| 步骤 | 内容 | 估时 |
|---|---|---|
| 0 | 抽 `policy.ts`（§1.4），**回归先绿** | 0.5 天 |
| 1 | `types.ts`：`NodeType` + `type?: NodeType` + `AdviceRecord`；保持 `outcome` 必填 | 0.5 天 |
| 2 | `strategy.ts` 纯函数（护栏/Wilson/推导/`descendantsOf`）+ `store` 增量（`batchPatch`/`proposeStrategySet`/`pickStrategy`/派生索引/`commit` 挂靠/`adviceLog` 懒补） | 1.5 天 |
| 3 | `tools.ts` 2 新工具 + 空 `sessionID` guard + search 注入 + status 概览；`prompts.ts` WHEN 第 4/5 条 + 菜单行（§5.4） | 1 天 |
| 4 | `dream.ts` 互斥门 + 分支评估 + **全自动切换** + `adviceLog` 写入；5 处 `type` 过滤 | 0.5 天 |

---

## 10. 测试与验收（15 条）

1. **兼容**：旧库无 `type`/无新键启动不报错，且节点文件**不被重写**。
2. `propose` 护栏：候选数 2/11 被拒、name 重复被拒、字段超长点名。
3. `propose` 相似复用：`problem` 高相似返回 `alreadyExisted` 不新建。
4. **`provisionalPick` 后第二个 alt 的 `parentId` 仍是 `setId`**（防劫持）。
5. **`pick` 原子性**：中断模拟下不出现 0/2 个 `chosen`。
6. **每会话 ≤1 `chosen` 不变量**：先后 pick 两个 set，`resolveActiveAlt` 返回最后一次 pick 而非创建序最后。
7. `superseded` 不计入失败、`rejected` 计入失败。
8. **`adviceLog` 脏数据不触发 rebuild**，且 `policies`/`dreamRuns` 完好。
9. **空 `sessionID` 不落 `unknown` 桶**。
10. **`descendantsOf` 悬空 `parentId` 返回 `[]`**。
11. Wilson：n<3 → null；partial 半权生效。
12. 跨进程：`cleanupStaleTmp` 按 pid+mtime 不删他进程 tmp。
13. **回归：浮点 replay 数值基线完全一致**（§3.5 五处 `type` 过滤是否到位的唯一判据）。
14. **全自动切换**：构造 2 个 alt 各自 n=5 子树（score 差 >0.2），dream 跑完后 chosen 变为 best，旧 chosen 变 superseded，outcome 不变；菜单有切换通知。
15. **提示词注入**：`renderSystemHelpText()` 含 WHEN 第 4/5 条；`renderMenuText()` 含新动作行且总长 ≤200 tokens。

---

## 11. 风险（8 条）

1. **`codemode` 字段宿主版本依赖**（既有，非本次）：`options.codemode:false` 需宿主 ≥2.0.26 才生效。
2. ~~pick 污染统计~~ **v2.1 已消除**（§5.2 三分语义）。残余风险：挂靠语义本身——pick 后本会话所有 commit 都挂该 alt，即使决策已结束。
3. **`provisionalPick` 劫持**（§2.5 已通过显式 `parentId`/`branchId` 规避，需测试 4 钉死）。
4. **set/alt 稀释浮点 replay**（§3.5 五处过滤，测试 13 钉死）。
5. **`outcome` 必填 vs set 节点语义**（占位 `"partial"`，靠 `type` 过滤区分，不改必填性）。
6. **跨进程不做一致性保证**（§4.7 三个既有洞，本次只收窄 `cleanupStaleTmp`）。
7. **跨会话不传播**（`resolveActiveAlt` 按 `sessionId` 过滤 → set 在会话 A 提出、会话 B 继续做时 B 无 chosen → 该 set 等不到 outcome。opencode 换 tab/恢复会话即新 sessionID，策略库会长期零样本。这是 per-session 隔离的代价，属设计取舍）。
8. **全自动切换的副作用**（§4.8）：agent 正在执行 A 方案时 dream 切到 B，若 agent 未读菜单通知，后续 commit 挂错分支。缓解：菜单强制提示 + 系统提示 WHEN 第 5 条；agent 可手动 pick 回滚（幂等）。

---

## 附：关键行号速查

| 事实 | 位置 |
|---|---|
| `NodeRecord` 定义 | `src/lib/types.ts:33-50` |
| `Outcome` 类型 | `src/lib/types.ts:1` |
| `DreamStatus` 预留 running | `src/lib/types.ts:72` |
| 策略工厂（待抽 policy.ts） | `src/lib/store.ts:109-164` |
| `MemoryStore.load` 唯一调用 | `src/lib/runtime.ts:55` |
| `commit` 默认挂最近节点 / branchId | `src/lib/store.ts:430-431,432,441` |
| `commit` 落盘序 | `src/lib/store.ts:456-459` |
| `patchNode` 不置 indexDirty | `src/lib/store.ts:463-478` |
| `persist` needIndex | `src/lib/store.ts:690-704,692` |
| `buildIndex` | `src/lib/store.ts:678-688` |
| `recordDream` TypeError 风险 | `src/lib/store.ts:521,686` |
| `dreamRuns` 直取坑 | `src/lib/store.ts:286` |
| index 门 / rebuild / legacy 迁移 | `src/lib/store.ts:275,206-254,238-241,306-317,311` |
| `setActivePolicy` 幂等 | `src/lib/store.ts:411-418` |
| `patchNodePolicy` dream 覆盖 | `src/lib/store.ts:421-426` |
| `sessionKeyOf` unknown 桶 | `src/lib/store.ts:105-107` |
| `sessionFileName` 清洗 | `src/lib/store.ts:100-103` |
| `atomicWrite` / `cleanupStaleTmp` | `src/lib/store.ts:66-78,86-98,712-719,723-725` |
| `writeChain` / 同步快照 | `src/lib/store.ts:176,708-726,697-704` |
| `runDream` / `status:"done"` | `src/lib/dream.ts:93,114-122,221-229` |
| provisional 转正 | `src/lib/dream.ts:206-208` |
| `evalRange` / `splitIndex` | `src/lib/replay.ts:66-92,181` |
| store↔replay 破环 | `src/lib/store.ts:31` + `src/lib/replay.ts:3` |
| `tokenizeText` / `tokenSimilarity` / CJK | `src/lib/scoring.ts:14,121,23-26` |
| 工具层错误约定 | `src/lib/tools.ts:169-175`、`src/lib/report.ts:81` |
| commit 工具无 sessionID guard | `src/lib/tools.ts:53-77` |
| hooks 有 guard | `src/lib/hooks.ts:95` |
| `getStage` / 概览过滤点 | `src/lib/report.ts:32,18-24` |
| querylog FIFO / 过滤 | `src/lib/querylog.ts:45-49,65-78` |
| `renderSystemHelpText` WHEN 块 | `src/lib/prompts.ts:9-28` |
| `renderMenuText` 可动作列表 | `src/lib/prompts.ts:48-74` |
| `GateRegistry` 冷却门控 | `src/lib/menu.ts:14-38` |
| `tsconfig` target ES2022 | `tsconfig.json:4` |
