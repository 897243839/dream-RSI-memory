# dream-RSI-memory

[English](README.md) | 简体中文

[![Release](https://img.shields.io/github/v/release/897243839/dream-RSI-memory)](https://github.com/897243839/dream-RSI-memory/releases)
[![License](https://img.shields.io/github/license/897243839/dream-RSI-memory)](LICENSE)
[![opencode](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai)

> **让你的 AI 不再第二次掉进同一个坑。**
> dream-RSI-memory 是 [opencode](https://opencode.ai) 的自我进化长期记忆插件：记忆由模型在回合中自行总结写入（无需额外 LLM），检索策略离线回放、自我进化且**保证不变差**。
> **首创设计决策策略库** —— 技术选型也有记忆：候选分支记战绩，跑出真结果后自动择优、可回滚，被证伪的不再选。

## 快速开始

```bash
npm install
npm run install:opencode
```

跑完**重启 opencode** 生效。插件**未发布到 npm registry**，别用 `npm install` 装这个包名；离线机打包、手动 jsonc 等完整说明见[安装](#安装)。

## 效果演示

**A. 检索命中失败经验** —— 开工前一搜，上次栽过的坑直接浮上来：

```
[dream-rsi-memory] 检索得 3 条历史经验（策略 p-default）：
• n-ab12cd34 (turn 12, failed, score 0.481) [文件重合|同类失败]
  session.idle 事件在桌面版不发射的根因是 worktree=/
  教训：V1 宿主没有 event 流时要回落到 transform 钩子
  文件：src/lib/hooks.ts, src/index.ts
```

**B. 做梦后策略切换（不退化保证）** —— train 与 valid 两个评估集都变好才切换，证据直接摆在输出里：

```
[dream-rsi-memory] 做梦完成：基于 42 个节点，策略 p-default → p-3f9a2c11。
  train 0.712 → 0.744，valid 0.698 → 0.721
  新参数：{"fileOverlapWeight":0.62,...}
  依据：failureAvoidRate 最薄弱（0.55）
  ⚠ 试用期（M，放宽门槛）：新策略带 provisional 标记，正式期转正前可随时回滚。
```

**C. 策略库自动择优（本项目原创设计）** —— 技术选型跑出真结果后，自动切到更优分支：

```
[dream-rsi-memory] 策略库分支评估：
  ▸ ORM 选型：drizzle 还是 kysely
    推荐 drizzle（score=0.812, n=7） 优于 kysely（0.631, n=6），margin=0.181
  → 已自动切换到 drizzle（原分支让位为 superseded，outcome 不变）；后续 commit 挂到新分支。
```

## 特性

- **同样的错不犯第二次** —— 开工前检索历史经验（失败节点加权更靠前），跨会话 teaser 在你正要重蹈覆辙时当场拦下；所以你得到：同一类坑只踩一次。
- **只会更好，不会变笨** —— 新策略必须在 train 与 valid **两个**评估集上都赢过基线才启用，样本不足时只记录不切换；所以你得到：检索质量随时间只爬升，绝不被一次坏调优拖垮。
- **忘了说「记一下」也不会丢** —— 回合结束菜单 + 空闲自动归档 + 给模型的 WHEN/WHEN-NOT 触发规则三层兜底，不靠人盯；所以你得到：记忆自己积累，零操作成本。
- **设计决策策略库** *本项目原创设计，Dream-RSI 论文中无此机制。* —— 多选一的技术决策候选入库 → 各分支累积真实战绩 → 自动切到被证明更好的那条（可回滚、被证伪的不再选）；所以你得到：技术选型也有记忆、有裁判。
- **数据在你自己机器上** —— 纯 JSON、无数据库、按项目隔离、可 git diff、可导出 Markdown、断网照常用；所以你得到：数据完全归你掌控，可审计、可迁移。
- **记忆写入零额外 LLM** —— 记忆由宿主模型顺手写入；策略优化靠离线回放而非模型调用（可选的 curator 馆藏管理员 LLM 默认开、失败优雅降级）；所以你得到：记忆主路径与策略库通道不产生额外模型调用。

## 与「无方案 / 手写 memory.md」的对比

| | 无方案 | 手写 `memory.md` | dream-RSI-memory |
| --- | --- | --- | --- |
| 记住上次的坑 | ✗ | 靠自觉手动写 | 自动，且失败经验加权 |
| 跨项目重复踩坑拦截 | ✗ | ✗ | teaser 当场拦下 |
| 检索质量随时间 | — | 全靠人翻 | 自我进化，**不退化保证** |
| 架构/技术选型 | ✗ | ✗ | 策略库，自动择优，可回滚 |
| 额外 LLM 成本 | 0 | 你的维护时间 | **0** |
| 数据 | — | 手动管理 | 本地纯 JSON，可 git diff、可导出 |

## 工作原理

### 采集

回合结束后模型自主调用 `dream_rsi_memory_commit`（把结论 / 踩坑记成决策树节点）、
`dream_rsi_memory_search`（开工前检索历史）或 `dream_rsi_memory_dream`（做梦）；
插件只提供存储、检索与离线评估引擎。

### 检索

7 个可调参数决定候选如何排序：文件重合权重 / FTS 权重 / 成功加成 / 失败加成 /
时衰半衰期 / 召回上限 / 最低分数；失败节点因失败加成更高而天然高价值。
工具 / 命令 / teaser 三个用户面检索出口全部落盘 `querylog.jsonl`，replay 在真实用例
≥ `replayMinRealQueries` 时把它们并入 train 指标；每个策略的在线战绩（服务查询数 /
节点成败计数）在 `dream_rsi_memory_status` 末尾展示。

### 做梦

在严格时间线切分（train/valid）上重放不同候选策略，比较 4 个指标——文件命中率 /
失败规避率 / 精确率 / 召回预算——的加权总分。**不退化保证的对象是检索策略的回放指标**：
只有 train 与 valid **都** ≥ 基线 + ε 才切换，否则保持现状。样本门槛分三阶段：

| 阶段 | 样本数 | 行为 |
| --- | --- | --- |
| **S 播种期** | n < 5 | 不评估不切换，只写一条「证据不足」的运行记录 |
| **M 试用期** | 5 ≤ n < 20 | 正常评估；valid 样本 < 3 时放宽为「只过 train 且 ε 加倍」，切换出的策略带 `provisional` |
| **F 正式期** | n ≥ 20 | 双门槛不变；dream 后 provisional 策略守擂转正、被更优候选超则交接 |

### 进化

候选池 = π₀ 保底（当前策略）+ 建库播种的 `seedCount` 组参数 + 启发式变体（每次运行
叠加 seeded ±20% 微扰）+ 后台「馆藏管理员」LLM（**默认开**，失败自动降级，只损失本次
候选，dream 照常完成）。

### 策略库

与参数进化正交的另一条通道（**本项目原创设计，论文中无此机制**），处理技术选型 /
架构取舍这类**多路尝试型决策**：首次遇到且库中无该问题的候选时，模型自己开 sub-agent
并行探索 ≥20 个方向 → 筛出约 5 个可靠候选（`propose` 接受 3~10 个）→ `question` 工具
与用户确认 → `strategy_propose` 入库（全 `unproven`）→ `strategy_pick` 定为当前分支；
此后 `commit` 自动挂到该分支累积真实 outcome。下次 `dream` 对各候选子树做 **Wilson
下界打分**（`partial` 半权、样本 < 3 不参与），margin > 0.2 且样本 ≥ 5 且当前会话确有在
执行分支时**自动切换**到更优候选并通知，人可用 `pick` 回滚（幂等）。全程零后台 agent、
零额外 LLM——探索与筛选由模型自己完成，插件只提供存储与纯规则评估引擎。

## 安装

> 插件**未发布到 npm registry**（别 `npm install` 这个包名）：安装脚本把插件
> 自包含安装进本地 `~/.cache/opencode/packages/dream-rsi-memory@latest/`，再把**包目录**
> 追加进 `plugin` 数组；幂等可重跑，改完重跑刷新、**重启 opencode** 生效。
>
> ⚠️ **opencode 2.x 只接受目录条目**：写文件路径会被打 `configured plugin path must be
> a directory` 并**静默丢弃**（插件完全不加载），写裸包名则每次启动跑一次 `npm install`；
> 入口按 `<目录>/index` 解析——仓库根 `index.js` 是为此存在的 shim，不读 `package.json` 的 `main`。

### 联网机器

```bash
npm install        # 安装开发依赖（含 @opencode-ai/plugin、typescript）
npm run install:opencode
```

构建 `dist/` → 插件本体 + `@opencode-ai/plugin` 闭包装进缓存 scope（registry 不可达时
回退拷贝仓库 `node_modules`）→ 包目录追加进 `plugin` 配置 → 冒烟自检；随后**重启 opencode**。

### 内网 / 离线机器

联网机 `npm run pack:offline` 打出单文件 `tar.gz`（安装器 + npm 离线缓存闭包），拷到目标机解压执行（需 Node + npm，全程不联网）：

```bash
npm install            # 只有生成时这一台需要
npm run pack:offline   # 产出 dream-rsi-memory-offline.tar.gz（~21MB）
# 目标机解压后：
powershell -ExecutionPolicy Bypass -File install.ps1   # Windows
./install.sh                                            # Linux / macOS
```

安装器用随包 `vendor/npm-cache` 跑 `npm install --offline` 写配置并自检，结束**重启
opencode**；无 npm 可改 `npm run vendor` → `node scripts/install.mjs --offline`；运维
`--uninstall` 卸载、`--config <path>` 指定配置文件。

> 手动方式（不推荐，仍需先跑一次安装脚本把闭包放进缓存）——`plugin` 条目必须是**目录**：

```jsonc
// ~/.config/opencode/opencode.jsonc
{
    "plugin": [
        "C:/Users/<you>/.cache/opencode/packages/dream-rsi-memory@latest/node_modules/dream-rsi-memory"
    ]
}
```

也可 `npm run build` 后直接指向本地仓库目录（**是目录不是 `dist/index.js` 文件**）。

> 桌面版（opencode GUI）无项目目录启动时插件自动回退到用户主目录注册，`/dream*`、`/memory*` 与 `dream_rsi_memory_*` 始终可用。

## 工具

| 工具 | 作用 |
| --- | --- |
| `dream_rsi_memory_commit` | 把回合结论/踩坑记入决策树节点；不传 summary/outcome 时从对话素材自动提取 |
| `dream_rsi_memory_search` | 开工前按文件重合 + 报错/语义相似 + 好坏加权检索历史经验 |
| `dream_rsi_memory_node` | 查看节点详情 |
| `dream_rsi_memory_status` | 记忆库状态 + 阶段 + replay 指标 + 每策略在线战绩 |
| `dream_rsi_memory_policy` | 手动切换检索策略 |
| `dream_rsi_memory_dream` | 触发一次「做梦」优化策略（S 期返回证据不足，M 期放宽门槛试调） |
| `dream_rsi_memory_strategy_propose` | 设计决策候选入库：把 3~10 个筛后的可靠候选方案（各含 approach/tradeoffs/estimatedRisk）作为一个策略集写入记忆树；纯规则护栏，不调 LLM |
| `dream_rsi_memory_strategy_pick` | 切换当前分支：把策略集中的某个候选定为当前分支（幂等；已 rejected 拒绝再选，已 superseded 允许回滚） |

回合结束时插件在最后一条用户消息上注入**可选菜单**提示上述动作：冷却 2 回合、有新节点
或每 5 回合强制出现一次；title/summary/compaction 等内部 agent 永不注入。

## 命令

| 命令 | 作用 | 等价工具 |
| --- | --- | --- |
| `/dream status` | 记忆库 + replay 概览 | `dream_rsi_memory_status` |
| `/dream run` | 立即触发一次做梦优化 | `dream_rsi_memory_dream` |
| `/dream commit <结论摘要>` | 记一条结论（可带 `成功\|失败\|部分`，自动关联本轮触碰文件） | `dream_rsi_memory_commit` |
| `/dream search <关键词>` | 检索历史经验 | `dream_rsi_memory_search` |
| `/memory stats` | 节点统计与当前策略（同 `/dream status`） | `dream_rsi_memory_status` |
| `/memory policy` | 全部策略列表 | `dream_rsi_memory_policy` |
| `/memory show <nodeId>` | 查看某节点详情 | `dream_rsi_memory_node` |
| `/memory search <关键词>` | 同 `/dream search` | `dream_rsi_memory_search` |

## 配置

任一位置（按优先级）放置 `dream-rsi-memory.jsonc` / `dream-rsi-memory.json`：
`$OPENCODE_CONFIG_DIR/` → 项目 `.opencode/` → 项目根 → `~/.config/opencode/`。

```jsonc
{
    "debug": false,
    "autoCommitOnIdle": true,
    "autoCommitIdleGapMs": 300000, // 最短间隔（毫秒）
    "menu": {
        "enabled": true,
        "cooldownTurns": 2,      // 两次注入之间最少用户回合数
        "forceEveryTurns": 5,    // 无新节点时最多隔几回合强制出现
        "maxTokensHint": 200
    },
    "dream": {
        "enabled": true,
        "minNodesProvisional": 5, // N1：S 播种期上限（n<5 不评估不切换，只写证据不足记录）
        "minNodes": 20,          // N2：F 正式期起点（M 试用期 = 5≤n<20，放宽门槛可试调）
        "minValidNodes": 3,      // M 期 valid 样本低于此值时改走"只过 train 且 ε 加倍"
        "trainRatio": 0.8,       // holdout 切分比例
        "epsilon": 0.005,        // 不退化保证：valid 需 ≥ 基线 + ε（M 期放宽时 ε 加倍）
        "seed": null,            // 可选：播种/微扰固定种子（缺省 = fnv1a(projectId+createdAt)）
        "queryWindowTurns": 50,
        "replayMinRealQueries": 10 // 真实用例低于此数不并入 replay（回退现状）
    },
    "queryLogMax": 1000,
    "replayWeights": {
        "fileHitRate": 0.35,
        "failureAvoidRate": 0.25,
        "precision": 0.25,
        "recallBudget": 0.15
    },
    "capture": {
        "maxMaterialChars": 6000
    },
    // 后台「馆藏管理员」LLM（默认开；用于 dreaming 参数突变，失败优雅降级）
    "curator": {
        "enabled": true,
        "providerID": "opencode",
        "modelID": "mimo-v2.6-flash-free",
        "timeoutMs": 120000
    }
}
```

## 数据

每个项目（按工作区路径 sha1 哈希）一份，默认落盘在
`$XDG_DATA_HOME|~/.local/share/opencode/storage/plugin/dream-rsi-memory/<projectId>/`
纯 JSON、无数据库。目录结构：

```
<projectId>/
├─ index.json                  # 小型索引：项目元信息 + 检索策略 + 做梦记录
├─ querylog.jsonl              # 用户面检索日志（真实查询回放的数据源）
└─ sessions/<会话>.json         # 按会话拆分：每个会话一个文件，仅含该会话的记忆节点
```

写入时只重写对应会话文件与小型索引，不再每次全量重写整个项目；旧版单个 `memory.json`
在启动时自动迁移为 v2 布局（原文件改名 `memory.json.bak`）。

> **v2.0.1 改名迁移**：插件 id / 数据目录 / 工具名由 `dream-memory` 改为 `dream-rsi-memory`
> （`dream_memory_*` → `dream_rsi_memory_*`），旧数据目录启动时自动迁移、旧名配置仍可读，详见 [CHANGELOG](CHANGELOG.md)。

## 与 Dream-RSI 论文的关系

- 参考论文: [Dream-RSI: Virtual-Time History Distillation Awakens Evolving Behavior](https://arxiv.org/abs/2609.14858) (arXiv:2609.14858, 2026)
- Design doc（详细方案）: [`docs/Dream-RSI-记忆库设计方案.md`](docs/Dream-RSI-记忆库设计方案.md)
- [Changelog](CHANGELOG.md)

本仓库机制分两层，归属不同，**引用只覆盖第一层**：

**派生自 Dream-RSI 论文**（方法来源，见文末引用与 `docs/Dream-RSI-记忆库设计方案.md`）：
- 历史轨迹构成决策树，记忆节点带 `success`/`failed` 结局
- 「做梦」= 在严格时间线 holdout 上离线回放候选策略，零成本评估
- `epsilon` 不退化门槛：train 与 valid 都稳健提升才切换
- 进化对象是「策略」而非底层 agent

**本项目独立扩展**（论文无对应机制，**不引用论文作为方法来源**）：
- 策略库（设计选型）：`strategy_set` / `strategy_alt` 节点 + `superseded` 第三语义
- 分支评估：Wilson 下界 + `partial` 半权的子树打分，`adviceLog` 检索注入
- `propose` / `pick` 两个工具的纯规则护栏
- 每会话至多一个 `chosen` 分支的不变量

详见实现依据定稿 [`docs/Dream-RSI 策略库扩展 最终设计方案（opencode 端）.md`](<docs/Dream-RSI 策略库扩展 最终设计方案（opencode 端）.md>)。

**Independent implementation of the Dream-RSI technique. This project is not affiliated with Google, Google DeepMind, or the authors of the Dream-RSI paper.**

## 开发

```sh
npm install          # 仅需要 @opencode-ai/plugin、@types/node、typescript
npm run typecheck
npm run build        # 产物在 dist/
npm test             # 构建 + 测试套件（test/*.test.mjs）
```

## 致谢

- 方法来自论文 Dream-RSI（arXiv:2609.14858），本仓库为**独立实现**，与官方及作者无关。
- 插件架构组织方式参考了 [opencode-acp](https://github.com/xcodebuild/opencode-acp)
  （AGPL-3.0）对 OpenCode Plugin API 的用法，代码为独立编写。

## License

AGPL-3.0 或更高版本。见 [LICENSE](LICENSE)。
