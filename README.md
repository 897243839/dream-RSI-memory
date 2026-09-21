# dream-RSI-memory

> 让 opencode 拥有会自我进化的长期记忆
> A self-evolving long-term memory plugin for [opencode](https://opencode.ai).

**Independent implementation of the Dream-RSI technique. This project is not
affiliated with Google, Google DeepMind, or the authors of the Dream-RSI paper.**

Dream-RSI 记忆库的初版实现：把历史会话蒸馏成决策树节点，检索策略以浮点参数表示；
「做梦」时在严格时间线 holdout 上离线回放不同候选策略，只接受在 train 与 valid
都稳健提升者 —— 因此策略**只会更好、不会退化**，且无需重新训练任何模型。

- 参考论文: [Dream-RSI: Virtual-Time History Distillation Awakens Evolving Behavior](https://arxiv.org/abs/2609.14858) (arXiv:2609.14858, 2026)
- Design doc（详细方案）: [`docs/Dream-RSI-记忆库设计方案.md`](docs/Dream-RSI-记忆库设计方案.md)

## 机制

1. **采集**：回合结束后注入可选菜单，模型自主决定是否 `dream_memory_commit`
   （把结论/踩坑记成决策树节点）、`dream_memory_search`（开工前检索历史）、
   或 `dream_memory_dream`（做梦）。
2. **检索**：7 个浮点参数（文件重合权重 / FTS 权重 / 成功加成 / 失败加成 /
   时衰半衰期 / 召回上限 / 最低分数）决定候选如何排序；失败节点天然高价值。
3. **做梦**：在严格时间线切分（train/valid）上重放不同候选策略，比较 4 个指标
   （文件命中率 / 失败规避率 / 精确率 / 召回预算）的加权总分，只有稳健提升
   （训练集与验证集都 ≥ 基线 + ε）才切换策略，否则保持现状。
4. **进化**：后台「馆藏管理员」LLM（可选）作为策略变异的启发式来源。

## 安装

```jsonc
// ~/.config/opencode/opencode.jsonc
{
    "plugin": [
        "dream-rsi-memory"          // npm 包名
    ]
}
```

或加载本地构建产物（先 `npm run build`）：

```jsonc
{
    "plugin": [
        "D:/path/to/dream-rsi-memory/dist/index.js"
    ]
}
```

## 数据

每个项目（按工作区路径哈希）一份，默认落盘在：
`$XDG_DATA_HOME|~/.local/share/opencode/storage/plugin/dream-memory/<projectId>/`
纯 JSON、无数据库。目录结构：

```
<projectId>/
├─ index.json                  # 小型索引：项目元信息 + 检索策略 + 做梦记录
└─ sessions/<会话>.json         # 按会话拆分：每个会话一个文件，仅含该会话的记忆节点
```

写入时只重写对应会话文件与小型索引，不再每次全量重写整个项目；旧版单个 `memory.json`
在启动时自动迁移为 v2 布局（原文件改名 `memory.json.bak`）。

## 工具（模型按需调用）

| 工具 | 作用 |
| --- | --- |
| `dream_memory_commit` | 把回合结论/踩坑记入决策树节点；不传 summary/outcome 时从对话素材自动提取 |
| `dream_memory_search` | 开工前按文件重合 + 报错/语义相似 + 好坏加权检索历史经验 |
| `dream_memory_node` | 查看节点详情 |
| `dream_memory_status` | 记忆库状态 + replay 指标 |
| `dream_memory_policy` | 手动切换检索策略 |
| `dream_memory_dream` | 触发一次「做梦」优化策略 |

回合结束时插件会在最后一条用户消息上注入**可选菜单**提示上述动作
（冷却 = 2 回合 / 有新节点或每 5 回合强制出现一次；内部 agent 如 title/summary/compaction
的请求永远不会被注入）。

## 命令

- `/dream status`、`/dream run`
- `/memory stats`、`/memory policy`、`/memory show <nodeId>`

## 配置（可选）

任一位置（按优先级）放置 `dream-memory.jsonc` / `dream-memory.json`：
`$OPENCODE_CONFIG_DIR/` → 项目 `.opencode/` → 项目根 → `~/.config/opencode/`。

```jsonc
{
    "debug": false,
    "autoCommitOnIdle": true,     // 会话空闲时自动把本回合素材归档为记忆节点
    "autoCommitIdleGapMs": 300000, // 相邻两次自动归档的最短间隔（毫秒）
    "menu": {
        "enabled": true,
        "cooldownTurns": 2,      // 两次注入之间最少用户回合数
        "forceEveryTurns": 5,    // 无新节点时最多隔几回合强制出现
        "maxTokensHint": 200
    },
    "dream": {
        "enabled": true,
        "minNodes": 20,          // 节点数不足时拒绝做梦
        "trainRatio": 0.8,       // holdout 切分比例
        "epsilon": 0.005,        // 不退化保证：valid 需 ≥ 基线 + ε
        "candidateCount": 3
    },
    "replayWeights": {
        "fileHitRate": 0.35,
        "failureAvoidRate": 0.25,
        "precision": 0.25,
        "recallBudget": 0.15
    },
    // 素材采集预算（commit/search 抓取对话的最大字符数）
    "capture": {
        "maxMaterialChars": 6000
    },
    // 后台「馆藏管理员」LLM（可选，默认关闭；用于 dreaming 参数突变）
    "curator": {
        "enabled": false,
        "providerID": "anthropic",
        "modelID": "claude-sonnet-4-20250514",
        "timeoutMs": 120000
    }
}
```

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
