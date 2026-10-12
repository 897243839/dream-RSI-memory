# dream-RSI-memory

English | [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/897243839/dream-RSI-memory)](https://github.com/897243839/dream-RSI-memory/releases)
[![License](https://img.shields.io/github/license/897243839/dream-RSI-memory)](LICENSE)
[![opencode](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai)

> **Stop your AI from making the same mistake twice.**
> dream-RSI-memory turns your opencode sessions into a memory tree it can query before every task — so the pitfall you hit last week is on screen before you walk into it again. The retrieval behind it is **self-evolving and never regresses**: a new strategy is adopted only after it beats the baseline on *both* the train and the valid split, and you can always roll back.
> It also introduces the **first strategy library for architecture decisions**: every option you considered keeps a real track record, the branch that proves better is **auto-switched in**, and you can **roll back at any time**.

## Quick start

```bash
npm install
npm run install:opencode
```

Then **restart opencode** — the plugin is loaded on launch. It is **not published to npm**: there is no registry package to install, and the script above does all the work — it builds the plugin, installs it self-contained into your local opencode package cache and appends the package directory to your `plugin` config (idempotent, safe to re-run).

## Demo

### A. Retrieval hits a past failure

```
[dream-rsi-memory] 检索得 3 条历史经验（策略 p-default）：
• n-ab12cd34 (turn 12, failed, score 0.481) [文件重合|同类失败]
  session.idle 事件在桌面版不发射的根因是 worktree=/
  教训：V1 宿主没有 event 流时要回落到 transform 钩子
  文件：src/lib/hooks.ts, src/index.ts
```

### B. A dream switches the strategy (never-regress guarantee)

```
[dream-rsi-memory] 做梦完成：基于 42 个节点，策略 p-default → p-3f9a2c11。
  train 0.712 → 0.744，valid 0.698 → 0.721
  新参数：{"fileOverlapWeight":0.62,...}
  依据：failureAvoidRate 最薄弱（0.55）
  ⚠ 试用期（M，放宽门槛）：新策略带 provisional 标记，正式期转正前可随时回滚。
```

### C. The strategy library auto-selects a winner (original design)

```
[dream-rsi-memory] 策略库分支评估：
  ▸ ORM 选型：drizzle 还是 kysely
    推荐 drizzle（score=0.812, n=7） 优于 kysely（0.631, n=6），margin=0.181
  → 已自动切换到 drizzle（原分支让位为 superseded，outcome 不变）；后续 commit 挂到新分支。
```

## Features

- **Stop making the same mistake twice** — every session starts by searching the memory tree (past failures weighted higher than successes), and a cross-session teaser intercepts you at the exact moment you are about to repeat one, so the lesson arrives before the mistake does.
- **Retrieval only gets better, never worse** — a candidate retrieval strategy must win on *both* the train and the valid evaluation set before it is enabled; when there is too little evidence it is only logged, never switched. Your memory content is never touched by this guarantee — the replayed retrieval metrics are.
- **Experiences record themselves** — an end-of-turn menu, idle auto-commit and the WHEN / WHEN-NOT trigger rules injected into the model's prompt keep the tree growing without anyone babysitting it.
- **A strategy library for architecture decisions** — *Original design; not in the Dream-RSI paper.* Multi-option technical choices enter the library as candidates, each branch accumulates real outcomes, the proven-better branch is switched in automatically, a falsified branch is never offered again, and you can roll back whenever you want.
- **Your data stays yours** — pure JSON, no database, isolated per project, `git diff`-able, exportable as Markdown (`dreamrsimem memory export <projectId>`), and fully usable offline.
- **Zero extra LLM calls for memory** — memory is written by the host model in-turn; strategy optimization runs as offline replay instead of model calls. The optional curator LLM is enabled by default and degrades gracefully on failure.

## Comparison

| | Nothing | Hand-written `memory.md` | dream-RSI-memory |
| --- | --- | --- | --- |
| Remembers past mistakes | ✗ | manual | automatic, failure-weighted |
| Blocks a repeat across sessions | ✗ | ✗ | teaser intercepts |
| Retrieval quality over time | — | you browse it | self-evolving, **never regresses** |
| Architecture decisions | ✗ | ✗ | strategy library, auto-selected, rollback-able |
| Extra LLM cost | 0 | your maintenance time | **0** |
| Data | — | manual | local JSON, git-diffable, exportable |

## How it works

### Capture

When a turn ends, the model decides what to do: `dream_rsi_memory_commit` records a conclusion or a pitfall as a decision-tree node (structured fields are extracted from the conversation when you pass nothing), `dream_rsi_memory_search` retrieves past experience before starting work, and `dream_rsi_memory_dream` runs a dream. The plugin itself only supplies storage, retrieval and the offline evaluation engine.

To keep that from depending on good intentions, the plugin injects an optional **end-of-turn menu** on the last user message (cooldown of 2 turns, forced at least every 5 turns when no new node appeared; internal agents such as `title` / `summary` / `compaction` never receive it), archives the turn automatically while idle, and ships the model a block of WHEN / WHEN-NOT trigger rules plus real examples. Recording, retrieval and dreaming stay under the model's own control.

### Retrieval

Seven tunable parameters decide how candidates rank: file-overlap weight / FTS weight / success boost / failure boost / recency half-life / recall cap / min score (two of them integers). Failed nodes score higher through the failure boost, which is exactly why the scar tissue surfaces first. All three user-facing retrieval exits — tool, command and teaser — append to `querylog.jsonl`; replay merges those real queries into the train metrics once there are at least `replayMinRealQueries` of them, and each policy's live record (queries served, node success/failure counts) is listed at the end of `dream_rsi_memory_status`.

### Dreaming

Candidate strategies are replayed on a strict-timeline train/valid split and compared by the weighted total of four metrics — file hit rate / failure avoid rate / precision / recall budget. A switch happens only when the candidate is ≥ baseline + ε on **both** splits; otherwise the current policy stays. Sample thresholds have three stages:

| Stage | Samples | Behavior |
| --- | --- | --- |
| **S** seeding | n < 5 | no evaluation, no switch — it only writes an "insufficient evidence" run record |
| **M** trial | 5 ≤ n < 20 | normal evaluation; if valid samples < 3 the bar relaxes to "wins on train alone, with ε doubled", and the switched-to policy is marked `provisional` |
| **F** formal | n ≥ 20 | both bars stay; after a dream a `provisional` policy defends its seat to graduate, or hands over when a better candidate beats it |

### Evolution

The candidate pool = π₀ (the current policy, always in the running) + `seedCount` seeded parameter sets + heuristic variants (each run adds seeded ±20% jitter) + the background **curator** LLM, which is **on by default**. If the curator fails, it degrades gracefully: that run simply loses its extra candidates and the dream completes anyway.

### Strategy library

A channel orthogonal to parameter evolution, for **multi-way technical decisions** such as stack choices and architecture trade-offs. On the first encounter with a problem that has no candidates in the library, the model spawns sub-agents to explore ≥ 20 directions in parallel, screens them down to roughly 5 (`strategy_propose` accepts 3–10 vetted alternatives, each with approach / tradeoffs / estimatedRisk), confirms the shortlist with the user through the `question` tool, stores it via `strategy_propose` (everything starts as `unproven`) and fixes one with `strategy_pick` as the current branch. From then on every `commit` attaches to that branch and accumulates real outcomes.

The next `dream` scores each candidate subtree with a **Wilson lower bound** (`partial` counts half, subtrees with n < 3 do not participate). When the margin is > 0.2 with ≥ 5 samples and the current session is genuinely executing a branch, it **auto-switches** to the better candidate and notifies you; `strategy_pick` rolls back at any time (idempotent, and a `rejected` branch is refused forever). Exploration, screening and the conversation with you are all done by the model itself — the plugin contributes storage and a pure-rule evaluation engine, **zero LLM calls and zero background agents** on this path.

## Installation

> The plugin is **not published to a npm registry** — installing it from npm is not an option. The install script places a self-contained copy in `~/.cache/opencode/packages/dream-rsi-memory@latest/` and appends the **package directory** to your `plugin` array. It is idempotent — re-run it after changes and **restart opencode**.
>
> ⚠️ **opencode 2.x only accepts directory entries.** A file path gets rejected with `configured plugin path must be a directory` and is **silently dropped** (the plugin never loads); a bare package name re-runs `npm install` on every launch. The entry point resolves as `<directory>/index` — the repo-root `index.js` exists for exactly this reason, it is a shim that ignores `package.json`'s `main`.

### Online machine

```bash
npm install        # dev dependencies (@opencode-ai/plugin, typescript, ...)
npm run install:opencode
```

Builds `dist/` → packs the plugin plus its `@opencode-ai/plugin` closure into the cache scope (falls back to copying the repo's `node_modules` when the registry is unreachable) → appends the package directory to the `plugin` config → smoke-tests it. Then **restart opencode**.

### Intranet / offline machine

On a connected machine run `npm run pack:offline` to produce a single self-extracting `tar.gz` (installer + npm offline cache closure), copy it over and unpack — Node + npm required, no network involved:

```bash
npm install            # only on the machine that builds the package
npm run pack:offline   # produces dream-rsi-memory-offline.tar.gz (~21MB)
# on the target machine, after unpacking:
powershell -ExecutionPolicy Bypass -File install.ps1   # Windows
./install.sh                                            # Linux / macOS
```

The installer runs `npm install --offline` against the bundled `vendor/npm-cache`, writes the config and self-checks; **restart opencode** when it finishes. Without npm available, run `npm run vendor` → `node scripts/install.mjs --offline`; ops flags: `--uninstall`, `--config <path>`.

> Manual setup (not recommended — you still need one run of the install script to populate the cache first). The `plugin` entry **must be a directory**:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
    "plugin": [
        "C:/Users/<you>/.cache/opencode/packages/dream-rsi-memory@latest/node_modules/dream-rsi-memory"
    ]
}
```

Alternatively, after `npm run build` point straight at the local repository directory (**a directory, not the `dist/index.js` file**).

> When the desktop (opencode GUI) starts without a project directory, the plugin falls back to registering under the user home directory, so `/dream*`, `/memory*` and `dream_rsi_memory_*` remain available.

## Tools

| Tool | What it does |
| --- | --- |
| `dream_rsi_memory_commit` | Record the current turn (or a given exploration / pitfall / conclusion) as a long-term memory tree node; with no `summary`/`outcome` passed it extracts the structured fields from the conversation itself. Chat equivalent: `/dream commit <summary>`. |
| `dream_rsi_memory_search` | Search past experience in the memory tree before starting work or when stuck: ranked by file overlap + semantic/error similarity + outcome weighting, returning the most recent relevant nodes. Chat equivalent: `/dream search <keywords>`. |
| `dream_rsi_memory_node` | Show a node's full details (summary, root cause, error message, files, parent branch). |
| `dream_rsi_memory_status` | Memory store status: node counts, current retrieval policy and its parameters, replay metrics, latest dream result. |
| `dream_rsi_memory_policy` | Switch retrieval policy (parameter set) manually. To list the candidates, search history or run `/memory policy`. |
| `dream_rsi_memory_dream` | Trigger a dream: evaluate candidate retrieval strategies on a strict-timeline holdout and switch only when there is a robust improvement on both train and valid (never-regress guarantee). `focus` picks the aspect to improve first. |
| `dream_rsi_memory_strategy_propose` | Store design-decision candidates: write 3–10 vetted alternatives (each with approach / tradeoffs / estimatedRisk) as one strategy set in the memory tree. Call it after retrieval confirms the library has no candidates for this problem; then set the current branch with `dream_rsi_memory_strategy_pick`. Pure-rule guardrails, no LLM calls. |
| `dream_rsi_memory_strategy_pick` | Make one candidate of a strategy set the current branch (cold-start pick, or a manual switch after hitting a wall). The displaced branch is recorded per `verdict` as `superseded` (stepped aside, not counted as a failure) or `rejected` (genuinely falsified, counted as a failure). Idempotent. |

## Commands

| Command | What it does | Equivalent tool |
| --- | --- | --- |
| `/dream status` | Memory store + replay overview | `dream_rsi_memory_status` |
| `/dream run` | Trigger a dream right now | `dream_rsi_memory_dream` |
| `/dream commit <summary>` | Record a conclusion (optionally `success\|failed\|partial`; touched files are linked automatically) | `dream_rsi_memory_commit` |
| `/dream search <keywords>` | Retrieve past experience | `dream_rsi_memory_search` |
| `/memory stats` | Node statistics and current policy (same as `/dream status`) | `dream_rsi_memory_status` |
| `/memory policy` | List every policy | `dream_rsi_memory_policy` |
| `/memory show <nodeId>` | Show one node's details | `dream_rsi_memory_node` |
| `/memory search <keywords>` | Same as `/dream search` | `dream_rsi_memory_search` |

## Configuration

Place `dream-rsi-memory.jsonc` / `dream-rsi-memory.json` in any of these locations (priority order):
`$OPENCODE_CONFIG_DIR/` → project `.opencode/` → project root → `~/.config/opencode/`.

```jsonc
{
    "debug": false,
    "autoCommitOnIdle": true,
    "autoCommitIdleGapMs": 300000, // minimum interval between idle commits (ms)
    "menu": {
        "enabled": true,
        "cooldownTurns": 2,      // min user turns between two menu injections
        "forceEveryTurns": 5,    // force the menu at least this often when no new node appeared
        "maxTokensHint": 200
    },
    "dream": {
        "enabled": true,
        "minNodesProvisional": 5, // N1: top of the S seeding stage (n<5 → no evaluation, no switch, only an "insufficient evidence" record)
        "minNodes": 20,          // N2: start of the F formal stage (M trial = 5≤n<20, relaxed bar allows trial switches)
        "minValidNodes": 3,      // below this many valid samples in stage M, fall back to "train-only win with ε doubled"
        "trainRatio": 0.8,       // holdout split ratio
        "epsilon": 0.005,        // never-regress guarantee: valid must be ≥ baseline + ε (doubled when stage M relaxes)
        "seed": null,            // optional fixed seed for seeding/jitter (default = fnv1a(projectId+createdAt))
        "queryWindowTurns": 50,
        "replayMinRealQueries": 10 // real queries below this count are not merged into replay (keeps the status quo)
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
    // background curator LLM (on by default; mutates dream parameters, degrades gracefully on failure)
    "curator": {
        "enabled": true,
        "providerID": "opencode",
        "modelID": "mimo-v2.6-flash-free",
        "timeoutMs": 120000
    }
}
```

## Data

One directory per project (sha1 of the workspace path), written by default under
`$XDG_DATA_HOME|~/.local/share/opencode/storage/plugin/dream-rsi-memory/<projectId>/` —
plain JSON, no database:

```
<projectId>/
├─ index.json                  # small index: project meta + retrieval policy + dream records
├─ querylog.jsonl              # user-facing retrieval log (the data source for real-query replay)
└─ sessions/<session>.json     # split per session: one file, only that session's memory nodes
```

Writes touch only the affected session file plus the small index, instead of rewriting the whole project each time; the legacy single `memory.json` is migrated to the v2 layout on startup (renamed to `memory.json.bak`).

> **v2.0.1 rename migration**: the plugin id / data directory / tool names changed from `dream-memory` to `dream-rsi-memory` (`dream_memory_*` → `dream_rsi_memory_*`). Old data directories migrate automatically at startup and old config names still resolve — see the [CHANGELOG](CHANGELOG.md).

## Relationship to the Dream-RSI paper

This repository has two layers of mechanisms with different ownership, and **the citation covers only the first layer**.

**Derived from the Dream-RSI paper** (method source; see the citation below and [`docs/Dream-RSI-记忆库设计方案.md`](docs/Dream-RSI-记忆库设计方案.md)):

- history trajectories form a decision tree; memory nodes carry `success` / `failed` outcomes
- a "dream" = offline replay of candidate policies on a strict-timeline holdout, evaluated at zero cost
- the `epsilon` never-regress threshold: switch only on robust improvement on *both* train and valid
- what evolves is the *policy*, not the underlying agent

**Independent extensions of this project** (no counterpart in the paper; **the paper is not cited as a method source for these**):

- the strategy library for design choices: `strategy_set` / `strategy_alt` nodes plus the third `superseded` semantics
- branch evaluation: Wilson lower bound + `partial` half-weight subtree scoring, `adviceLog` retrieval injection
- the pure-rule guardrails of the `propose` / `pick` tools
- the invariant of at most one `chosen` branch per session

Reference paper: [Dream-RSI: Virtual-Time History Distillation Awakens Evolving Behavior](https://arxiv.org/abs/2609.14858) (arXiv:2609.14858, 2026). Detailed design: [`docs/Dream-RSI-记忆库设计方案.md`](docs/Dream-RSI-记忆库设计方案.md). The implementation basis for the strategy library: [`docs/Dream-RSI 策略库扩展 最终设计方案（opencode 端）.md`](<docs/Dream-RSI 策略库扩展 最终设计方案（opencode 端）.md>). Release history: [CHANGELOG](CHANGELOG.md).

**Independent implementation of the Dream-RSI technique. This project is not affiliated with Google, Google DeepMind, or the authors of the Dream-RSI paper.**

## Development

```sh
npm install          # only @opencode-ai/plugin, @types/node and typescript are needed
npm run typecheck
npm run build        # output in dist/
npm test             # build + test suite (test/*.test.mjs)
```

## Acknowledgements

- The method comes from the paper Dream-RSI (arXiv:2609.14858); this repository is an **independent implementation** with no affiliation to the official project or its authors.
- The plugin's organization was informed by [opencode-acp](https://github.com/xcodebuild/opencode-acp) (AGPL-3.0) and its use of the OpenCode Plugin API; the code here is written independently.

## License

AGPL-3.0 or later. See [LICENSE](LICENSE).
