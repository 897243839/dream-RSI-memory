# Dream-RSI 长期记忆库 · 完整设计文档

> 整理时间：2026-09-18
> 主题：基于 Dream-RSI（arXiv:2609.14858）思想，为 OpenCode 设计一个可自主进化的长期记忆插件
> 本文档汇总了从论文调研到最终 v3 设计的完整演进过程

---

## 目录

1. [Dream-RSI 论文详解](#一-dream-rsi-论文详解)
2. [开源现状调研](#二-开源现状调研)
3. [现有开源项目盘点](#三-现有开源项目盘点)
4. [设计演进过程](#四-设计演进过程)
5. [最终方案 v3（推荐实现）](#五-最终方案-v3推荐实现)
6. [梦境模拟器细化](#六-梦境模拟器细化重点)
7. [落地路线图](#七-落地路线图)
8. [关键决策记录](#八-关键决策记录)

---

## 一、Dream-RSI 论文详解

**标题**：Dream-RSI: Recursive Self-Improvement through Evolving Worlds
**arXiv**：2609.14858
**提交时间**：2026-09-14
**作者团队**：Google / Google DeepMind / 马里兰大学 / 弗吉尼亚大学
**官方 repo**：`github.com/zhengkid/Dream-RSI`（截至 9 月 18 日完整代码仍在准备中）

### 1.1 要解决的问题

递归自我改进（RSI）系统在巨大搜索空间中寻找高价值解，成败高度依赖**探索策略**：
- 选哪些分支继续探索
- 并行多少候选
- 何时放弃无效路径
- 资源如何分配

现有系统两难：
- **固定人工策略**：搜索空间扩大后无法自适应，持续浪费算力
- **在线优化元策略**：每测一个新策略都要跑完整轮真实评测，反馈延迟、成本极高

### 1.2 核心思想

> 已经跑完的历史发现轨迹，本身就是免费可用的模拟器。

把真实探索产生的**发现树（discovery tree）**保存下来，树上记录每次尝试：生成的候选代码、快照、得分、失败/成功信息。

不需要重复调用底层 Agent 重跑真实任务；**直接在历史树上回放测试各种候选探索策略**，快速拿到离线反馈——论文称为 **"Dreaming"（做梦）**。

### 1.3 三阶段循环

```
① Online Explore 在线真实探索
   当前策略驱动底层 Agent 运行真实任务 → 生成发现树
        ↓
② Construct Replay Simulator 构建回放模拟器
   把发现树转化为回放模拟器（节点结果都是真实发生过的，无需预测）
        ↓
③ Dreaming-based Policy Improvement 离线策略迭代
   元 LLM 改写探索策略代码 → 在回放模拟器中零成本打分 → 选最优
        ↓
   新策略部署回①，新发现树扩充模拟器池 → 闭环
```

### 1.4 关键机制

- **底层 Agent 不变**：只进化上层编排策略
- **策略可执行代码化**：不是 prompt，是可执行 Python 函数
- **不退化保证**：候选集合包含原始旧策略，新策略性能不会比旧策略差
- **成本感知**：回放打分兼顾输出质量，同时惩罚过多尝试

### 1.5 实验结果

覆盖三大领域：算法工程、数学优化、GPU Kernel 工程。
- 同等效果下大幅减少 Agent 调用次数
- 部分场景算力开销下降到基线的 1/162
- 结果质量不输甚至优于现有系统（AlphaEvolve、SimpleTES 等）

### 1.6 局限

1. 回放模拟器只能评估已经访问过的搜索空间区域
2. 性能上限依赖底层发现 Agent 能力
3. 模拟器池需要积累足够历史轨迹，早期离线改进能力有限

---

## 二、开源现状调研

### 2.1 Dream-RSI 官方代码状态

| 内容 | 状态 |
|---|---|
| 论文 PDF | ✅ 已公开 |
| 项目页 dream-rsi.com（含交互式 demo） | ✅ 已公开 |
| 论文中的 prompts、Lasso solver 结果 | ✅ 已公开 |
| GitHub repo 本体 | ⚠️ 已建，README + 论文链接 + demo 占位 |
| **完整代码库、复现脚本** | ❌ 仍在准备中 |

**第三方复现**：截至 2026-09-18（论文发表 4 天），**尚无第三方复现**。HN/Reddit 有活跃讨论，但都是解读和机制讨论。

### 2.2 时间预期

- 第 1-2 周：新闻解读、讨论（当前阶段）
- 第 2-4 周：官方 repo 补全 + 第一批技术博客带简化代码
- 第 4-8 周：独立复现/改进工作出现

### 2.3 相关前序工作

- **Codeevolve**（arXiv:2510.14150）：Dream-RSI 作者团队之前开源的进化式编码 agent，是 Dream-RSI 的底层基础设施

---

## 三、现有开源项目盘点

### 3.1 记忆底座（可直接复用）

| 项目 | 定位 | 适用场景 |
|---|---|---|
| **Mem0** (mem0ai/mem0) | 事实抽取 + 向量检索的记忆层 | 轻量对话事实记忆（41k+ star） |
| **Letta / MemGPT** | 操作系统式分层记忆，自带 sleep-time compute | 长期会话记忆，分层管理 |
| **Zep / Graphiti** | 时序知识图谱，追踪事实随时间变化 | 需要时序性的事实记忆 |

### 3.2 经验回放 / 自我进化机制

| 项目 | 核心机制 | 可借鉴度 |
|---|---|---|
| **SkillRL** (aiming-lab/SkillRL) | 从轨迹蒸馏分层技能库 + 自适应检索 + 递归进化 | **最高**——"经验→技能→检索→进化"闭环 |
| **SAGE** (amazon-science/SAGE) | Amazon 技能库 + RL，交互步数降 26% | 技能库接 RL loop |
| **EvolveR** (Edaizi/EvolveR) | 经验驱动的 agent 自进化生命周期 | 生命周期四阶段 |
| **AgentHER** (alphadl/AgentHER) | Hindsight Experience Replay 用于轨迹重标记 | 失败轨迹转有效经验 |
| **Retrospex** | 离线 RL Critic 给历史经验估值 | 经验价值评估 |
| **SLEA-RL** | 步级经验增强 RL | 步级粒度经验管理 |

### 3.3 opencode-acp（关键参考）

**仓库**：`github.com/ranxianglei/opencode-acp`
**许可证**：AGPL-3.0
**定位**：Active Context Pruning for OpenCode——让模型自己决定何时压缩上下文

**核心机制**：
- **三层 LSM-tree 压缩**（灵感来自数据库存储引擎）：
  - T1 Capture：原始对话 → 详细摘要（~45x 压缩），上下文超限时触发
  - T2 Distill：T1 摘要 → 浓缩决策/结果（~10x 压缩），T1 积累到阈值时触发
  - T3 Condense：T2 摘要 → 裸事实（~5x 压缩），T2 积累到阈值时触发
- 模型有 `compress` / `decompress` 工具，自主决定压缩/解压
- T1 压缩优先级：子agent审查结果 → 冗长命令输出 → **没结果的探索（失败路径）** → 冗余工具结果 → 中间步骤 → 已解决讨论 → 大文件内容
- 质量门：L1 长度下限 + L2 ROUGE 关键词召回（非阻塞，off 默认）
- GC 安全网：100% 时硬截断
- 实测：30,000+ API 调用，97% 请求在 200K tokens 内；单会话最长 3,300+ 消息

**ACP 不提供的能力**：
- 不向其他插件暴露 hook / 事件
- block 状态存在 `~/.local/share/opencode/storage/plugin/acp/`
- 可通过 `/acp export --tier t2,t3 --output <path>` 导出 markdown

---

## 四、设计演进过程

### v1：基于向量库 + 三层架构（早期）

**思路**：用 Mem0 做记忆底座，上面叠 Dream-RSI 的回放和进化层。

**问题**：用户指出——**用作代码项目编写，向量库不合适**。代码是结构化、符号化的，向量模糊匹配会召回无关代码。

### v2：转向 SQLite + FTS5，融合 ACP 思想

**改进**：
- 放弃向量库，改用 SQLite + FTS5 全文检索
- 代码项目记忆分四类：项目约定（MEMORY.md）、决策记录（ADR）、踩坑经验（lessons）、可复用模式（patterns）
- 参考 ACP 的三层 LSM 压缩思想

**问题**：开始考虑和 ACP 共存 vs 自己重写三层压缩。

### v2.5：与 ACP 共存方案

**思路**：ACP 管会话内压缩，自己的插件管跨会话记忆。
- ACP 已做：T1/T2/T3 压缩、本地持久化
- 插件补：跨项目检索、按文件召回、做梦进化

**关键发现**：
- ACP 不暴露 plugin hook
- ACP 状态已跨 session 持久化
- 插件应通过 `/acp export` 消费 ACP 输出，不直接读内部存储

### v3：完全脱离 ACP，模型自主决策（最终方案）

**用户核心诉求**：
1. 参考 ACP 思想但**脱离 ACP 依赖**
2. **不修改主上下文**——记忆通过工具调用，模型自主选择
3. **对话结束时注入提示词**，让模型自己决定是否建节点、是否做梦
4. 细化梦境模拟器

---

## 五、最终方案 v3（推荐实现）

### 5.1 设计原则

1. **插件不替模型做决定**——只提供工具和提示
2. **不自动注入记忆到主上下文**——模型自己调 search 工具
3. **不依赖 opencode-acp**——ACP 的 LSM 思想仅作设计参考
4. **严格对齐 Dream-RSI**——底层 Agent 不变，进化对象是记忆检索策略，历史轨迹构成决策树，离线回放做零成本评估

### 5.2 触发机制：回合结束时注入"元提示词"

**时机**（不每轮都注入）：
1. 主 Agent 完成一个回合、即将交回用户
2. session 进入 idle 状态

**注入内容**（不是记忆，是"可选工具菜单"）：

```
[Dream-RSI 记忆系统 · 可选动作]
当前项目 {project_name} 已有 {N} 个历史决策节点。
你现在可以选择：
  1. commit_task_trace    — 把刚才这轮工作蒸馏成一个新节点（如果这轮有值得记住的探索）
  2. search_history_experience — 搜一下历史上类似的坑/方案
  3. run_dream_optimization    — 触发离线做梦，让记忆策略自我进化
  4. 什么都不做          — 直接回应用户

建议：刚踩了坑、刚试出新方案、刚否掉一个设计时，值得 commit。
      树里攒了 20+ 节点后，可以考虑做一次 dream。
      没有明确价值就不用调。
```

### 5.3 工具集（模型自主调用）

| 工具 | 用途 | 输入 | 返回 |
|---|---|---|---|
| `commit_task_trace` | 把一轮工作蒸馏成新节点 | summary, files, outcome, score?, why? | 新 node_id |
| `search_history_experience` | 检索历史经验 | query, files?, limit? | top-k 节点摘要 |
| `inspect_node_detail` | 查看节点完整细节 | node_id | 节点完整字段 |
| `run_dream_optimization` | 触发离线做梦 | focus? | dream run_id（后台跑） |
| `dream_status` | 查看做梦进度/结果 | 无 | 最近一轮做梦详情 |
| `switch_policy` | 切换策略版本 | policy_id | 切换结果 |

**关键设计**：`commit_task_trace` 不要求模型写结构化 JSON——模型用自然语言说，插件后台派小模型蒸馏成结构化节点（子 agent，不占主 token）。

### 5.4 决策树存储（SQLite + FTS5）

```sql
-- 决策树节点
CREATE TABLE nodes (
  node_id TEXT PRIMARY KEY,
  project_id TEXT,
  parent_id TEXT,              -- 父节点；NULL 表示根
  branch_id TEXT,              -- 分支 id：分叉点兄弟节点共享 branch 组
  summary TEXT,                 -- 本次探索一句话摘要
  files TEXT,                   -- 涉及文件，逗号分隔
  outcome TEXT,                 -- success / failed / partial
  score REAL,                   -- 模型自评 0~1
  why TEXT,                     -- 结果说明（尤其失败原因）
  policy_version TEXT,          -- 当时线上用的记忆策略版本
  turn_index INTEGER,           -- 项目时间线序号（回放用）
  created_at TEXT
);
CREATE VIRTUAL TABLE nodes_fts USING fts5(summary, why, files, content='nodes');

-- 策略仓库
CREATE TABLE policies (
  policy_id TEXT PRIMARY KEY,
  code TEXT,                    -- 策略函数源码
  params TEXT,                  -- 结构化参数快照
  replay_score REAL,             -- 最近一次回放得分
  is_active INTEGER DEFAULT 0,
  parent_policy_id TEXT,         -- 从哪个策略变异来的
  dream_round INTEGER,          -- 第几轮做梦产生的
  created_at TEXT
);

-- 做梦记录
CREATE TABLE dream_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT,
  finished_at TEXT,
  candidates_json TEXT,         -- 这轮评估了哪些策略、各多少分
  chosen_policy_id TEXT,
  notes TEXT
);
```

**树结构要点**：
- `parent_id` 构成父子链（延续）
- `branch_id` 标记分叉——模型说"换了全新思路"时，新节点 parent 指向旧思路祖先，branch_id 换新
- `turn_index` 全局递增，**回放时严格按这个顺序走时间线**

---

## 六、梦境模拟器细化（重点）

### 6.1 策略是什么

策略是纯函数，签名固定：

```typescript
type PolicyInput = {
  task_summary: string;       // 当前节点的 summary
  task_files: string[];        // 当前节点涉及的文件
  visibleNodes: Node[];        // 当时决策树里已存在的节点（turn_index < 当前节点）
};

type PolicyOutput = {
  recalledNodeIds: string[];  // 排序后的召回列表（已截断到 k）
};
```

**MVP 阶段策略 = 6 个浮点数参数**（元 LLM 改参数，不改代码，安全）：

```typescript
const params = {
  fileOverlapWeight: 0.5,      // 文件路径重合度权重
  ftsScoreWeight: 0.3,          // 关键词匹配权重
  successBoost: 0.1,            // 成功节点额外加权
  failureBoost: 0.25,           // 失败节点额外加权（避坑）
  recencyHalfLife: 50,          // 时间衰减半衰期（节点数）
  maxRecall: 5,                  // 最多召回几条
  minScore: 0.05,               // 低于这个分不召回
};
```

**单节点打分函数**：

```
score(n, t) =
  fileOverlap(n.files, t.files) * fileOverlapWeight
  + ftsMatch(n, t.summary)      * ftsScoreWeight
  + (n.outcome == 'success')   * successBoost
  + (n.outcome == 'failed')    * failureBoost
  + recency(n.turn_index, t.turn_index, recencyHalfLife)
```

策略排序 = 按 score 降序 → 截断 maxRecall → 过滤 minScore。

### 6.2 回放算法（时间线遍历）

**核心原则**：严格模拟时间线——站在节点 v 发生的那一刻，当时只能看到 v 之前的节点，不能偷看未来。

```
function replay(policy, projectNodes):
  nodes = sortByTurnIndex(projectNodes)
  metrics = { fileHit: [], failureAvoid: [], precision: [], recallCount: [] }

  for i, v in enumerate(nodes):
    // 站在 v 发生的那一刻：当时只能看到 v 之前的节点
    visibleNodes = nodes[0 : i]

    // 让候选策略"穿越回"那一刻，决定当时召回什么
    recalled = policy({
      task_summary: v.summary,
      task_files: parseFiles(v.files),
      visibleNodes: visibleNodes,
    })

    // 指标 1：文件命中率
    overlap = fileOverlapBetween(recalled, v)
    metrics.fileHit.push(overlap)

    // 指标 2：失败避坑召回
    if v.outcome == 'failed':
        similarFailedRecalled = recalled.filter(
          r => r.outcome == 'failed' && similar(r, v)
        )
        metrics.failureAvoid.push(len(similarFailedRecalled) > 0 ? 1 : 0)

    // 指标 3：精确率（惩罚乱召回）
    relevant = recalled.filter(r => isRelevant(r, v))
    metrics.precision.push(len(relevant) / max(len(recalled), 1))

    // 指标 4：召回数量（越精简越好）
    metrics.recallCount.push(len(recalled))

  return {
    fileHitRate: mean(metrics.fileHit),
    failureAvoidRate: mean(metrics.failureAvoid),
    precision: mean(metrics.precision),
    avgRecallCount: mean(metrics.recallCount),
  }
```

**综合分**：

```
totalScore =
  0.35 * fileHitRate          # 文件命中最重要（代码场景）
  + 0.25 * failureAvoidRate   # 避坑
  + 0.25 * precision           # 不胡说
  + 0.15 * (1 - avgRecallCount / maxRecall)  # 召回越少越好（省 token）
```

### 6.3 模拟器性质

- **纯计算，零 LLM 调用**：毫秒级
- **离线、只读**：不改任何节点
- **异策略评估**：用历史数据评估"如果当时换了策略会怎样"
- **精度局限**：只评估"检索相关性"，不预测"检索到后任务会不会更好"（MVP 天花板，后续可加 LLM-as-judge）

### 6.4 做梦循环（后台，模型触发）

```
run_dream_optimization(focus?):
  1. 取当前 active 策略 P*
  2. 读最近一次 dream_run 的 notes（上次哪项指标最差）
  3. 元 LLM 生成 M 个参数变体：
     - failureAvoidRate 低 → 调高 failureBoost
     - precision 低 → 调高 minScore
     - fileHitRate 低 → 调高 fileOverlapWeight
     - 也可随机扰动 ±20% 做探索
  4. 对每个候选 P_i，跑 replay(P_i, 项目节点)
  5. 选 P_best = argmax totalScore
  6. 如果 score(P_best) >= score(P*) + 0.005（epsilon）：
       P_best 设为 active，P* 降级 archived，记录到 dream_runs
     否则：
       保留 P*，记录"本轮无改进"
  7. 返回摘要给主 agent
```

**不退化保证**：第 6 步的 epsilon 阈值——新策略必须明显更好才上线，否则不动。

### 6.5 做梦触发阈值

- 项目节点 < 20：返回"节点太少，回放不可靠"
- 20~100：采样最近 50 个节点回放
- \> 100：全量回放
- 距上次做梦 < 50 个新节点：跳过，提示"增量不够"

### 6.6 完整数据流

```
主 Agent 编码
    ↓
回合结束 → 注入元提示词（工具菜单，非记忆）
    ↓
模型自主选择：
    ├─ commit_task_trace ──▶ 子模型蒸馏成结构化节点 ──▶ 写 nodes 表
    ├─ search_history_experience ──▶ 用 active 策略排序历史节点 ──▶ 返回摘要
    ├─ run_dream_optimization ──▶ 后台：
    │       元 LLM 生成参数变体
    │       → 离线 replay 每个变体
    │       → 选最优，达标才上线
    └─ 继续干活
    ↓
积累更多节点 → 下次做梦素材更多 → 策略更好 → 召回更准 → 主 Agent 更省
```

---

## 七、落地路线图

### 阶段 1：节点存储 + commit_task_trace（1~2 天）
- SQLite 建表，决策树节点写入、父子关联
- 子模型蒸馏：自然语言 → 结构化节点
- 分支识别（延续 vs 分叉）
- 实现 `search_history_experience` 基础检索（文件路径 + FTS）

### 阶段 2：查询工具（1~2 天）
- `inspect_node_detail`
- `search_history_experience` 接入参数化策略

### 阶段 3：回放模拟器（2~3 天）
- `replay()` 纯函数实现
- 4 维指标计算
- 综合分聚合

### 阶段 4：做梦循环 + 策略仓库（2~3 天）
- 元 LLM 生成参数变体
- 离线打分、择优、策略版本管理
- `run_dream_optimization` 工具
- 不退化阈值保护

### 阶段 5：回合结束元提示词注入
- OpenCode hook 挂载
- 按节点数量动态调整建议内容

---

## 八、关键决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| 用向量库还是 FTS5 | **SQLite + FTS5** | 代码场景需要精确符号/路径匹配，向量模糊召回不合适 |
| 与 ACP 共存还是独立 | **完全独立** | ACP 不暴露 hook，自己重写三层压缩成本太高；ACP 管会话内，插件管跨会话 |
| 记忆自动注入还是模型主动调 | **模型主动调工具** | 不侵入主上下文，模型自主判断何时需要历史经验 |
| 何时建节点 | **回合结束注入提示词，模型决定** | 不替模型做决定，避免无价值节点 |
| 何时做梦 | **模型调 run_dream_optimization** | 后台执行，不阻塞编码；节点数不够时拒绝 |
| 策略表示 | **6 个浮点数参数（MVP）** | 安全、可对比、不会生成恶意代码；后续再放开到函数级 |
| 回放打分 | **时间线遍历 + 4 维指标加权** | 纯计算零成本，严格模拟"当时能看到什么" |
| 不退化保证 | **epsilon 阈值，新策略必须明显更好才上线** | 对齐 Dream-RSI 原文性能下限 |
| 失败轨迹处理 | **failureBoost 加权召回** | 失败路径是高价值避坑经验，不是垃圾 |

---

## 九、v3.1 完善版：对照 opencode-acp 真实机制落地细化

> 本节把 v3 方案映射到 OpenCode 插件机制与 opencode-acp v1.17.0 源码事实，修正三处与实现有偏差的设计，并补齐原方案留空的技术细节。

### 9.1 真实插件机制核对（修正）

**OpenCode 插件实际可用的 7 个挂载点**（对照本仓库 index.ts 与 lib/hooks.ts）：

| 挂载点 | ACP 中的用途 | Dream-Memory 的用途 |
|---|---|---|
| `experimental.chat.system.transform` | 注入压缩系统提示 | 注入 ≤100 token 的记忆工具说明 |
| `experimental.chat.messages.transform` | 每请求改写消息、注入 nudge | **"可选菜单"的唯一注入点（门控）** |
| `experimental.text.complete` | 主输出后处理（去幻觉） | 可选：清洗 commit 参数 |
| `command.execute.before` | `/acp` 命令 | `/memory`、`/dream` 命令 |
| `event` | 监听 `message.part.updated`（压缩计时） | 记录工具调用结束，为 commit 攒素材 |
| `tool` | 注册 5 个压缩工具 | 注册 6 个记忆工具 |
| `config` | 改 permission / 注册命令 / primary_tools | 注册命令、把检索工具放进 primary_tools |

**修正 1 — 插件感知不到"回合结束 / idle"，必须换注入时机。** 可执行的做法沿用 ACP nudge 机制：在 `messages.transform` 里，**下次用户请求被组装时**按门控条件向 `output.messages` 末尾追加一条"可选菜单"提示（同 lib/hooks.ts 的 `injectCompressNudges` 模式）。同时必须复用 ACP 的内部 agent 守卫（lib/hooks.ts `isInternalAgentRequest`）：title / summary / compaction 三类隐藏请求绝不注入，否则污染隐藏摘要请求；仅 primary 会话注入，跳过子 agent。

**修正 2 — 后台小模型怎么调。** 不需要新依赖、也没有现成编排层。本仓库验证过的 SDK 能力是 `client.session.prompt()`（lib/ui/notification.ts:317）：向当前 opencode 服务发隐藏 prompt `{ agent, model, noReply, parts:[{type:"text", text, ignored:true}] }`，再用 `client.session.messages()` 轮询取结果。蒸馏 / 元 LLM 都走这条路径，模型可在配置里指定便宜型号，彻底不占主上下文 token。

**修正 3 — 状态与素材来源。** 状态模型照抄 ACP：进程内 `SessionStateRegistry` + JSON 落盘 `$XDG_DATA_HOME/opencode/storage/plugin/acp/{sessionId}.json`（lib/state/persistence.ts:66，可用 storagePath 覆盖）。本品数据存 `{dataDir}/memory/{projectId}/nodes.db`。**commit 素材必须用 `client.session.messages()` 拉原始窗口**（同 ACP 命令处理器 lib/hooks.ts:473），不读 ACP 内部存储——这样与 ACP 能稳定共存（ACP 压缩对本品透明）。

### 9.2 插件骨架（结构对齐 opencode-acp）

```typescript
// index.ts
import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"

const server: Plugin = async (ctx) => {
  const store = new MemoryStore(ctx.directory)   // SQLite + 每会话门控状态
  const meta = new MetaLlm(ctx.client)            // 封装 client.session.prompt + 轮询

  return {
    "experimental.chat.system.transform": (_i, output) => {
      output.system.push(renderMemoryHelp())      // ≤100 token
    },
    "experimental.chat.messages.transform": (_i, output) => {
      if (isInternalAgentRequest(output.messages)) return
      if (store.shouldInjectMenu()) appendMenu(output.messages, store)   // 门控见 9.3
    },
    "command.execute.before": (input, output) => {
      if (input.command === "memory") return handleMemoryCommand(input, output)
      if (input.command === "dream") return handleDreamCommand(input, output)
    },
    event: (input) => {
      if (input.event?.type === "message.part.updated" &&
          input.event.properties?.part?.type === "tool") {
        store.recordToolUsage()                    // 攒 commit 素材（文件/结论）
      }
    },
    tool: {
      commit_task_trace: tool({
        description: "把本轮探索蒸馏成一个记忆节点（后台子模型回填）",
        args: {
          summary:  tool.schema.string().optional().describe("一句话概述，≤80字"),
          files:   tool.schema.array(tool.schema.string()).optional().describe("涉及文件路径"),
          outcome: tool.schema.enum(["success", "failed", "partial"]).optional(),
          why:     tool.schema.string().optional().describe("结果说明，失败必填根因"),
        },
        async execute(args, toolCtx) {
          const raw = await store.captureTurn(toolCtx.sessionID)  // client.session.messages 抓素材
          return store.commit(args, raw)                          // 同步入队，后台蒸馏回填
        },
      }),
      search_history_experience: tool({ /* 见 9.5 打分 */ }),
      inspect_node_detail: tool({ /* node_id → 完整字段 */ }),
      run_dream_optimization: tool({ /* focus? → 立即返回 run_id（后台排队） */ }),
      dream_status: tool({ /* 最近一轮 dreaming 详情 */ }),
      switch_policy: tool({ /* policy_id → 切换结果 */ }),
    },
    config: async (opencodeConfig) => {
      opencodeConfig.command ??= {}
      opencodeConfig.command["memory"] = { template: "", description: "记忆库：stats/export/node" }
      opencodeConfig.command["dream"]  = { template: "", description: "做梦引擎：status/run" }
      opencodeConfig.experimental = {
        ...opencodeConfig.experimental,
        primary_tools: [...(opencodeConfig.experimental?.primary_tools ?? []),
                         "search_history_experience"],   // 检索类进 primary，让模型更易触达
      }
    },
  }
}
```

### 9.3 菜单注入门控（防刷屏 / 防污染隐藏请求）

每会话维护字段：`lastMenuTurn`、`nodesSinceLastMenu`、`menuCount`。注入条件三者同时满足：
1. 距上次注入 ≥ 2 个用户回合，且距上次"实际聊天回合" ≥ 1；
2. `nodesSinceLastMenu ≥ 1`（有新增节点）或距上次注入 ≥ 5 回合（弱刷存在感）；
3. 非内部 agent、非子 agent、非 ignore-only 请求。

菜单内容（≤200 token）：
```
[记忆系统 · 可选动作] 项目 {name} 已积累 {N} 节点，当前策略 {ver}（replay train/valid 分）
可选：1. commit_task_trace   2. search_history_experience
     3. run_dream_optimization（节点≥20 且增量≥50 才有效）  4. 不操作，直接继续
```
菜单尾部固定加一句"以上均可选，本回合无相关需求就忽略本提示"，防止模型每轮都调工具。

### 9.4 完善版 SQL DDL

相对原 schema 的改动点：① nodes 增加 `id INTEGER PRIMARY KEY`（外部内容 FTS 需要 content_rowid，也是 join 键）；② FTS5 改成**自带副本的独立表**（写入时与 nodes 同事务双写，避开外部内容表触发器维护），MVP 量级冗余可接受；③ 文件列表归一化成 `node_files`，作为 fileOverlap/fileHit 的精确匹配源；④ 失败节点补 `error_message`；⑤ dream_runs 补 status + train/valid 双分。

```sql
PRAGMA journal_mode = WAL;      -- 连接级，多读者单写者
PRAGMA busy_timeout = 5000;     -- 写锁等待上限，防阻塞主循环
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,             -- hash(workspace 根路径)，win32 强制小写
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nodes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id       TEXT NOT NULL UNIQUE,      -- 对模型暴露的稳定 id（uuid）
  project_id    TEXT NOT NULL REFERENCES projects(project_id),
  session_id    TEXT,                      -- 来源会话，审计用
  agent_name    TEXT NOT NULL DEFAULT 'primary',
  parent_id     TEXT,                      -- 父节点；NULL=根
  branch_id     TEXT,                      -- 分叉标记
  summary       TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('success','failed','partial')),
  score         REAL,                      -- 模型自评 0~1；可空
  why           TEXT,
  error_message TEXT,                      -- outcome='failed' 建议必填，检索/避坑用
  policy_version TEXT,                     -- 提交时 active 策略版本
  turn_index    INTEGER NOT NULL,          -- 项目内单调递增（回放时间轴）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nodes_proj_turn ON nodes(project_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_nodes_parent    ON nodes(parent_id);

CREATE TABLE IF NOT EXISTS node_files (    -- 文件归一化：精确匹配源
  node_id   TEXT NOT NULL REFERENCES nodes(node_id),
  file_path TEXT NOT NULL,                 -- 相对 root_path、正斜杠、win32 小写
  PRIMARY KEY (node_id, file_path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(summary, why, files_text);
-- 写入：INSERT INTO nodes + node_files + nodes_fts 同事务；删除时同步清理

CREATE TABLE IF NOT EXISTS policies (
  policy_id        TEXT PRIMARY KEY,
  code             TEXT,                   -- MVP：6 参数 JSON；以后才能放开到函数
  params           TEXT,
  replay_train     REAL,                   -- train 段均分
  replay_valid     REAL,                   -- holdout 段确认分
  is_active        INTEGER NOT NULL DEFAULT 0,
  parent_policy_id TEXT,
  dream_round      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dream_runs (
  run_id          TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|failed
  started_at      TEXT,
  finished_at     TEXT,
  candidates_json TEXT,                   -- 各候选 train/valid 分，审计
  chosen_policy_id TEXT,
  notes           TEXT                    -- 本轮最差指标 + 建议 → 供下次变异
);
```

### 9.5 模糊函数与检索打分定死

- 文件路径归一化：相对 project root、`/` 分隔、win32 统一小写（大小写不敏感匹配）。
- `recency(Δ) = exp(-Δ / halfLife)`，`Δ = t.turn_index - n.turn_index`（≥0，严格时间序不偷看未来）。
- `fileOverlap = |n.files ∩ t.files| / max(min(|n.files|, |t.files|), 1)`。
- `ftsMatch`：对 t.summary 做关键词抽取（去停用词，≤16 token），在 `nodes_fts` 上 `MATCH`，用 `bm25()` rank 归一为 `1 / (1 + |rank|)`。
- `isRelevant(r, v)`（precision 用）：文件集合有交集 OR FTS 命中同类关键词。
- `similar(r, v)`（failureAvoid 用）：文件集合有交集 OR 共享 error_message 提取出的失败关键词。
- `search_history_experience` 返回格式：top-k 节点，每条 `node_id / turn_index / outcome / summary(≤200字)/ why(≤200字)`，总预算 ≤800 token，默认 limit=5。

### 9.6 元 LLM 两块提示词

**蒸馏提示（commit 后台调用）**：
```
你是 memory 蒸馏器。把下面的本轮会话素材压缩成一个"决策树节点"：
1. summary ≤ 80 字，一句话说清"这次探索做了什么/试出了什么"
2. outcome ∈ success | failed | partial；failed 时 why 必须写明失败根因
3. files 只列素材里真实出现过的文件路径（从工具调用提取）
4. 若本轮没有值得记住的探索，只输出 __SKIP__
只输出 JSON。
[素材] {captureTurn 返回的最近 N 条消息摘要}
```
规则后校验兜底：files 必须与真实工具路径匹配；outcome 非法则整节点丢弃并回报主 agent。

**策略变异提示（dream 调用）**：
```
你在优化"记忆召回策略"（7 个浮点参数）。上次 dream 报告最差指标：{notes}。
当前参数：{params}
按规则给出不超过 3 个参数变体：
- failureAvoidRate 低 → failureBoost 上调（上限 0.5）
- precision 低     → minScore 上调（上限 0.3）
- fileHitRate 低   → fileOverlapWeight 上调（上限 0.8）
- avgRecallCount 高 → maxRecall 下调（下限 2，整数）
- 每轮允许至多 1 个变体做 ±20% 随机扰动（探索）
只输出 JSON 参数数组。
```
参数 clamp 表（变异后强制夹紧）：

| 参数 | 默认 | 范围 |
|---|---|---|
| fileOverlapWeight | 0.5 | [0, 1] |
| ftsScoreWeight | 0.3 | [0, 1] |
| successBoost | 0.1 | [0, 0.4] |
| failureBoost | 0.25 | [0, 0.5] |
| recencyHalfLife | 50 | [20, 200] |
| maxRecall | 5 | [1, 10]（整数） |
| minScore | 0.05 | [0, 0.3] |

### 9.7 新增关键机制：回放防过拟合（holdout 切分）

原方案"在同一颗树上调参、又在该树打分"会**过拟合历史**。v3.1 修正为旋转 holdout：
- N ≥ 100：`train = nodes[0 : 0.8N]`、`valid = nodes[0.8N : N]`；调参只读 train，valid 只做最终确认。
- 上线条件：`valid(totalScore(P_best)) ≥ valid(totalScore(P*)) + 0.005`。
- 20 ≤ N < 100：不切分，但只允许"上轮短板方向"的保守调整，禁止大随机扰动。
- N < 20：直接拒绝（沿用 6.5）。
- `dream_runs.candidates_json` 记录每个候选的 train/valid 双分，供审计与回滚。

### 9.8 健壮性与并发

- SQLite：单写连接 + `busy_timeout=5000`；所有写入走一个串行队列。
- dream 后台执行：进程内串行队列，同一时刻至多 1 轮；进程退出任务丢失可接受，`dream_runs.status` 幂等，重进后标记 failed 并跳过。replay 本身纯计算毫秒级，**只有元 LLM 调用是异步的**。
- 所有后台 LLM 调用加超时（建议 60s），失败即降级：commit 改用主模型直接传参；dream 记 failed。
- 菜单/检索均设 token 上限（9.3 / 9.5），不拖慢主循环；工具执行响应要求 < 1s。
- 隐私：纯本地 SQLite，无遥测；日志不记录文件全文，只记路径与结论。

### 9.9 修订后的落地路线（映射真实挂载点）

| 阶段 | 内容 | 落点 |
|---|---|---|
| P1 存储 + commit | 建表 / 双写 FTS / `client.session.messages` 抓素材 / `client.session.prompt` 蒸馏 | `tool` 注册 commit + `event` 攒素材 |
| P2 查询 | search / inspect 接入参数化策略 | `tool` 注册 + `config` 入 primary_tools |
| P3 回放模拟器 | replay 纯函数 + 4 维指标 + **holdout 切分** | 纯函数模块 |
| P4 做梦循环 | 变异提示词 / 后台串行队列 / 元 LLM 调用 / epsilon + valid 确认 | 后台任务层 |
| P5 注入 + 命令 | messages.transform 门控菜单 / system.transform 说明 / `/memory` `/dream` | hooks + `config` 注册命令 |

### 9.10 明确不做（MVP 边界）

- LLM-as-judge 判定"检索到后任务是否真的变好"（超出检索相关性，后续版本）；
- 跨项目策略迁移 / 联邦做梦；
- 函数级策略自动改写代码（MVP 只改参数，杜绝生成恶意/损坏策略代码）；
- 向量检索（代码场景精确符号/路径匹配优先，与 v2 决策一致）。

### 9.11 风险与缓解

| 风险 | 缓解 |
|---|---|
| 调参过拟合历史 | 9.7 holdout 切分 + epsilon(0.005) + 增量不足时跳过 |
| 冷启动（<20 节点） | 项目首次加载时扫描 README / AGENTS.md 自动 commit 首个节点；search 始终可用 |
| 蒸馏失真（files/outcome 错） | 规则后校验：路径必须真实匹配工具调用；非法即丢弃节点并回报 |
| 菜单刷屏 / 污染隐藏请求 | 9.3 门控 + 内部 agent 守卫 + ≤200 token |
| 与 ACP 同时安装 | 素材走 `client.session.messages()` 原始窗口，不读 ACP 内部存储，互不依赖 |
| 检索噪声拖慢主流程 | search 默认 ≤5 条 / ≤800 token / minScore 过滤 |
| 主进程重启丢后台任务 | status 幂等，`/dream status` 可见 failed；可手动重跑 |

### 9.12 验收指标

- 5 个真实编码场景下，`search_history_experience` 有效召回历史 ≥ 2 次；
- 连续 3 轮 dream 上线的策略，其 `replay_valid` 单调不降；
- 菜单 + 工具描述给主上下文带来的常驻开销 < 上下文 1%；
- commit 快路径（入队 + 返回 run_id）< 5s；单节点读写 < 50ms（本地 SQLite）。

---

- Dream-RSI 论文：https://arxiv.org/abs/2609.14858
- Dream-RSI 项目页：https://www.dream-rsi.com/
- Dream-RSI 官方 repo（待补全）：https://github.com/zhengkid/Dream-RSI
- opencode-acp：https://github.com/ranxianglei/opencode-acp
- SkillRL：https://github.com/aiming-lab/SkillRL
- Codeevolve（前序工作）：arXiv:2510.14150
- HN 讨论：https://news.ycombinator.com/item?id=49726955
#（注：内容由AI生成）
