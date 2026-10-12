import { randomUUID } from "node:crypto"
import type { Logger } from "./logger.js"
import type { MetaLlm } from "./meta-llm.js"
import { runReplay } from "./replay.js"
import { replayOptsOf } from "./report.js"
import { getStage } from "./stages.js"
import type { MemoryStore } from "./store.js"
import {
    ADVICE_DELTA,
    buildChildIndex,
    canAutoSwitch,
    descendantsOf,
    isStrategyAlt,
    scoreSubtree,
    type AltScore,
} from "./strategy.js"
import type { AdviceRecord, MemoryConfig, RecallParams, ReplayMetrics } from "./types.js"
import { clampParams, fnv1a32, mulberry32, perturbParams } from "./utils.js"

function weakestNote(metrics: ReplayMetrics, weights: MemoryConfig["replayWeights"]): string {
    const ranked: [string, number][] = [
        ["fileHitRate", metrics.fileHitRate],
        ["failureAvoidRate", metrics.failureAvoidRate],
        ["precision", metrics.precision],
        ["recallBudget", metrics.recallBudget],
    ]
    ranked.sort((a, b) => weights[a[0] as keyof MemoryConfig["replayWeights"]] * a[1] - weights[b[0] as keyof MemoryConfig["replayWeights"]] * b[1])
    const [weakKey, value] = ranked[0]
    const notes: Record<string, string> = {
        fileHitRate: `fileHitRate=${value.toFixed(2)} 最低 → 应提高 fileOverlapWeight，并降低 minScore`,
        failureAvoidRate: `failureAvoidRate=${value.toFixed(2)} 最低 → 应提高 failureBoost，并提高 ftsScoreWeight（errorMessage 检索权重）`,
        precision: `precision=${value.toFixed(2)} 最低 → 应提高 minScore 并提高 ftsScoreWeight`,
        recallBudget: `recallBudget=${value.toFixed(2)} 最低 → 应降低 maxRecall 并降低 ftsScoreWeight`,
    }
    return notes[weakKey] ?? ""
}

type MetricKey = keyof ReplayMetrics & ("fileHitRate" | "failureAvoidRate" | "precision" | "recallBudget")

/**
 * Note that drives the candidates. Without `focus` it's the weakest metric;
 * with `focus` the requested aspect wins (matching the dream_rsi_memory_dream
 * `focus` arg: file recall / failure avoid / precision / budget).
 */
function noteFor(metrics: ReplayMetrics, weights: MemoryConfig["replayWeights"], focus?: string): string {
    const f = focus?.trim().toLowerCase() ?? ""
    const key: MetricKey | "" =
        f.includes("file") ? "fileHitRate"
        : f.includes("fail") ? "failureAvoidRate"
        : f.includes("precis") ? "precision"
        : f.includes("budget") || f.includes("recall") ? "recallBudget"
        : ""
    if (key === "") return weakestNote(metrics, weights)
    const value = metrics[key]
    const notes: Record<MetricKey, string> = {
        fileHitRate: `fileHitRate=${value.toFixed(2)}（指定优先改善）→ 应提高 fileOverlapWeight，并降低 minScore`,
        failureAvoidRate: `failureAvoidRate=${value.toFixed(2)}（指定优先改善）→ 应提高 failureBoost，并提高 ftsScoreWeight（errorMessage 检索权重）`,
        precision: `precision=${value.toFixed(2)}（指定优先改善）→ 应提高 minScore 并提高 ftsScoreWeight`,
        recallBudget: `recallBudget=${value.toFixed(2)}（指定优先改善）→ 应降低 maxRecall 并降低 ftsScoreWeight`,
    }
    return notes[key]
}

function heuristicVariants(base: RecallParams, notes: string, count: number): RecallParams[] {
    const variants: RecallParams[] = []
    const push = (patch: Partial<RecallParams>) => variants.push(clampParams({ ...base, ...patch }))

    if (notes.includes("fileHitRate") || notes.includes("precision")) {
        if (notes.includes("fileHitRate")) {
            push({ fileOverlapWeight: Math.min(base.fileOverlapWeight + 0.15, 0.9), minScore: Math.max(base.minScore - 0.02, 0) })
        } else {
            push({ minScore: Math.min(base.minScore + 0.03, 0.25), ftsScoreWeight: Math.min(base.ftsScoreWeight + 0.1, 0.9) })
        }
        push({ recencyHalfLife: Math.min(base.recencyHalfLife + 30, 200) })
    } else if (notes.includes("failureAvoidRate")) {
        const boosted = Math.min(base.failureBoost + 0.1, 0.45)
        push({ failureBoost: boosted, ftsScoreWeight: Math.min(base.ftsScoreWeight + 0.1, 0.9) })
        push({ failureBoost: boosted })
    } else if (notes.includes("recallBudget")) {
        push({ maxRecall: Math.max(base.maxRecall - 1, 2), ftsScoreWeight: Math.max(base.ftsScoreWeight - 0.05, 0) })
        push({ maxRecall: Math.max(base.maxRecall - 1, 2) })
    } else {
        push({ minScore: Math.min(base.minScore + 0.02, 0.2) })
        push({ successBoost: Math.min(base.successBoost + 0.05, 0.3) })
    }

    push({
        fileOverlapWeight: Math.max(Math.min(base.fileOverlapWeight + 0.05, 0.9), 0),
        recencyHalfLife: Math.max(Math.min(base.recencyHalfLife + 10, 200), 20),
    })

    const seen = new Map<string, RecallParams>()
    for (const variant of variants) seen.set(JSON.stringify(variant), variant)
    return [...seen.values()].slice(0, count)
}

export interface DreamRunResult {
    runId: string
    text: string
}

/**
 * 互斥门的超时阈值（§4.4 的必要补充）：`DreamStatus.running` 是**持久化**状态，
 * 若进程在 dream 中途崩溃，index.json 会留下永久的 running → dream 从此再也
 * 不会被触发。超龄的 running 视为崩溃残留并放行。
 */
const DREAM_RUNNING_STALE_MS = 10 * 60_000

/**
 * 策略库分支评估 + **全自动切换**（设计方案 §7.1 打分 / §4.8 切换）。
 *
 * 与浮点参数 replay 完全正交：不切 policy、不写经验节点，只改 `strategy_alt` 的
 * `status`（经 `pickStrategy`，`batchPatch` 单次落盘保证「每会话 ≤1 chosen」）。
 * 建议与切换轨迹写进 `index.json` 的 `adviceLog`（§8，FIFO 50）。
 */
function evaluateStrategyBranches(
    store: MemoryStore,
    logger: Logger,
    sessionId?: string,
): { text: string; records: AdviceRecord[] } {
    const sets = store.listSetMetas()
    if (sets.length === 0) return { text: "", records: [] }

    // set 的 altIds 可能含脏 id（§6.2）：先建索引再逐个校验，取不到就跳过。
    const idx = buildChildIndex(store.sortedNodes())
    const activeAlt = sessionId ? store.resolveActiveAlt(sessionId) : null
    const records: AdviceRecord[] = []
    const lines: string[] = []

    for (const meta of sets) {
        const scored: AltScore[] = []
        for (const altId of meta.altIds) {
            const altNode = idx.byId.get(altId)
            if (!altNode || !isStrategyAlt(altNode)) continue
            // 已证伪（rejected）的候选不参与 best/second 评选：既不该被推荐，
            // 更不该被「自动切换」过去 —— pickStrategy 对 rejected 会返回 undefined。
            if (altNode.status === "rejected") continue
            scored.push({ altId, name: altNode.name, ...scoreSubtree(descendantsOf(idx, altId)) })
        }
        const proven = scored.filter((a) => a.score !== null)
        if (proven.length < 2) continue

        const sorted = [...proven].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        const best = sorted[0] as AltScore
        const second = sorted[1] as AltScore
        const margin = (best.score ?? 0) - (second.score ?? 0)
        if (margin <= ADVICE_DELTA) continue

        // 自动切换四条件在 canAutoSwitch 内（§4.8）：margin / ≠当前 chosen /
        // 本会话确有 active alt / best.n ≥ 5。
        let switched = canAutoSwitch({
            best,
            second,
            currentChosenAltId: meta.chosenAltId,
            hasActiveAlt: !!activeAlt,
        })
        let switchNote = ""
        if (switched) {
            try {
                const picked = store.pickStrategy({
                    setId: meta.setId,
                    altName: best.name,
                    reason: `dream 自动切换：${best.name} 显著优于当前分支（margin=${margin.toFixed(3)}）`,
                    sessionId,
                })
                if (picked) {
                    switchNote = `\n  → 已自动切换到 ${best.name}（原分支让位为 superseded，outcome 不变）；后续 commit 挂到新分支。`
                } else {
                    // pickStrategy 对「目标 rejected / 不存在」返回 undefined 且不抛：
                    // 必须按**实际**结果上报，不能把没发生的切换说成成功（§6.1）。
                    switched = false
                    switchNote = `\n  → ⚠ 自动切换未生效（候选状态不允许）。`
                    logger.warn("strategy auto switch not applied", { setId: meta.setId, altName: best.name })
                }
            } catch (error) {
                switched = false
                logger.error("strategy auto switch failed", { setId: meta.setId, error: String(error) })
                switchNote = `\n  → ⚠ 自动切换失败：${String(error)}；可手动 dream_rsi_memory_strategy_pick 切换。`
            }
        }

        const record: AdviceRecord = {
            setId: meta.setId,
            problem: meta.problem,
            recommendedAltId: best.altId,
            recommendedAltName: best.name,
            margin,
            nBest: best.n,
            nSecond: second.n,
            autoSwitched: switched,
            createdAt: new Date().toISOString(),
        }
        store.appendAdvice(record)
        records.push(record)

        lines.push(
            `  ▸ ${meta.problem}\n` +
                `    推荐 ${best.name}（score=${(best.score ?? 0).toFixed(3)}, n=${best.n}）` +
                ` 优于 ${second.name}（${(second.score ?? 0).toFixed(3)}, n=${second.n}），margin=${margin.toFixed(3)}` +
                switchNote,
        )
    }

    if (lines.length === 0) return { text: "", records: [] }
    return { text: `[dream-rsi-memory] 策略库分支评估：\n${lines.join("\n")}`, records }
}

export async function runDream(
    store: MemoryStore,
    config: MemoryConfig,
    deps: { logger: Logger; meta?: MetaLlm; focus?: string; sessionId?: string },
): Promise<DreamRunResult> {
    const runId = "r-" + randomUUID().slice(0, 8)
    const dreamCfg = config.dream

    // P0 接通 dream.enabled：禁用时工具/命令都返回"已禁用"，不评估不记录。
    if (!dreamCfg.enabled) {
        return { runId, text: "[dream-rsi-memory] dream 已禁用（dream.enabled=false）：不评估、不切换。" }
    }

    // §4.4 dream 互斥：并发 dream 会互相覆盖 patchNodePolicy，provisional 转正语义乱。
    // 用现成的 DreamStatus.running 字段（不加新键），并带超时自愈（见常量注释）。
    const latestRun = store.latestDream()
    if (latestRun?.status === "running") {
        const started = Date.parse(latestRun.startedAt ?? "")
        const stale = Number.isNaN(started) || Date.now() - started > DREAM_RUNNING_STALE_MS
        if (!stale) {
            return {
                runId,
                text: `[dream-rsi-memory] 已有一次 dream 正在运行（${latestRun.runId}），本次跳过 —— 并发 dream 会互相覆盖策略切换结果。`,
            }
        }
    }
    const startedAt = new Date().toISOString()
    store.recordDream({
        runId,
        status: "running",
        startedAt,
        candidatesJson: "[]",
        chosenPolicyId: store.activePolicy().policyId,
    })

    // §4.4 出口兜底 + §6.1「工具层从不 throw」：主体一旦抛错，把 running 收敛成
    // failed（否则 `running` 会永久残留，只能等 DREAM_RUNNING_STALE_MS 超时自愈，
    // 期间所有 dream 都被互斥门拒绝），并向调用方返回中文失败串，不 rethrow。
    try {
        return await runDreamBody(store, config, deps, runId)
    } catch (error) {
        deps.logger.error("dream failed", { runId, error: String(error) })
        store.recordDream({
            runId,
            status: "failed",
            startedAt,
            finishedAt: new Date().toISOString(),
            candidatesJson: "[]",
            chosenPolicyId: store.activePolicy().policyId,
            notes: String(error),
        })
        return { runId, text: `[dream-rsi-memory] dream 执行失败：${String(error)}` }
    }
}

/**
 * `runDream` 的主体：`recordDream({status:"running"})` **之后**的全部逻辑。
 * 正常路径行为与改造前逐字一致；异常交由外壳收敛为 `status:"failed"`。
 */
async function runDreamBody(
    store: MemoryStore,
    config: MemoryConfig,
    deps: { logger: Logger; meta?: MetaLlm; focus?: string; sessionId?: string },
    runId: string,
): Promise<DreamRunResult> {
    const n = store.count()
    const dreamCfg = config.dream
    const stage = getStage(n, dreamCfg)

    // S 播种期：不评估不切换，但必须写 DreamRunRecord（不再静默跳过）——
    // 论文附录 B.2 的 bootstrap 语义：显式声明"证据不足、信号采集中"。
    if (stage === "S") {
        const active = store.activePolicy()
        const notes = `insufficient: n=${n} < ${dreamCfg.minNodesProvisional}`
        store.recordDream({
            runId,
            status: "done",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            candidatesJson: "[]",
            chosenPolicyId: active.policyId,
            notes,
        })
        deps.logger.info("dream deferred: seed stage", { runId, n })
        // 播种期节点少，浮点 replay 不评估；但策略库分支评估仍要跑 ——
        // 否则「S 期」会成为自动切换的永久死角（set/alt 子树样本可以独立于 replay 增长）。
        const seedBranch = evaluateStrategyBranches(store, deps.logger, deps.sessionId)
        return {
            runId,
            text:
                `[dream-rsi-memory] 做梦未评估：证据不足（n=${n} < ${dreamCfg.minNodesProvisional}），信号采集中。\n` +
                `  当前为播种期（S）：只积累节点与检索信号，不调参、不切换（策略保持 ${active.policyId}）。\n` +
                `  继续 dream_rsi_memory_commit / dream_rsi_memory_search；节点 ≥ ${dreamCfg.minNodesProvisional} 后进入试用期（M），dream 可试调。` +
                (seedBranch.text ? `\n${seedBranch.text}` : ""),
        }
    }

    const replayOpts = replayOptsOf(config)
    const active = store.activePolicy()
    const baseline = runReplay(store, active.params, replayOpts)
    const note = noteFor(baseline.train, config.replayWeights, deps.focus)

    // 候选装配（P1）：π₀ 保底（active 永远第一位）+ 池中全部 seed 策略 +
    // 启发式变体（每次运行 seeded ±20% 微扰）+ LLM curator ≤2 组。
    const candidates: RecallParams[] = [active.params]
    const seen = new Set<string>([JSON.stringify(active.params)])
    const pushUnique = (params: RecallParams): void => {
        const key = JSON.stringify(params)
        if (seen.has(key)) return
        seen.add(key)
        candidates.push(params)
    }
    for (const policy of store.listPolicies()) {
        if (policy.source === "seed") pushUnique(policy.params)
    }
    const heuristicRng = mulberry32(dreamCfg.seed ?? fnv1a32(runId))
    for (const variant of heuristicVariants(active.params, note, dreamCfg.candidateCount)) {
        pushUnique(perturbParams(variant, heuristicRng))
    }

    let llmCount = 0
    let curatorError = ""
    if (deps.meta?.configured) {
        try {
            const fromLlm = await deps.meta.mutate(active.params, note)
            llmCount = fromLlm.length
            for (const cand of fromLlm) pushUnique(cand)
        } catch (error) {
            // P1 硬性要求：LLM 失败只损失本次候选，dream 照常完成。
            curatorError = `curator: ${String(error)}`
            deps.logger.warn("curator mutate failed; continuing without LLM candidates", { error: String(error) })
        }
    }

    const scored: { params: RecallParams; train: number; valid: number | null }[] = []
    for (const cand of candidates) {
        const report = runReplay(store, cand, replayOpts)
        scored.push({ params: cand, train: report.train.totalScore, valid: report.valid?.totalScore ?? null })
    }
    scored.sort((a, b) => b.train - a.train)

    const best = scored[0]
    // 门槛（P0 三阶段）：M 期 valid 样本数 < minValidNodes → 只过 train 且 ε 加倍；
    // 否则维持双门槛（train > baseline+ε 且 valid ≥ baseline.valid+ε）；F 期现状不变。
    const validCount = baseline.n - baseline.splitIndex
    const relaxedM = stage === "M" && validCount < dreamCfg.minValidNodes
    const baseInvalid = baseline.valid === null
    const validOkay = baseInvalid || (best.valid !== null && best.valid >= (baseline.valid?.totalScore ?? 0) + dreamCfg.epsilon)
    const trainOkay = best.train > baseline.train.totalScore + (relaxedM ? 2 * dreamCfg.epsilon : dreamCfg.epsilon)
    const better = relaxedM ? trainOkay : trainOkay && validOkay

    let chosen = ""
    let text: string
    if (better && best.params !== active.params) {
        const policyId = "p-" + randomUUID().slice(0, 8)
        store.patchNodePolicy(policyId, best.params, active.policyId)
        store.patchPolicyMeta(policyId, { replayAtCreation: { train: best.train, valid: best.valid } })
        // M 试用期切换出的策略带 provisional 标记；F 期新策略无标记。
        if (stage === "M") store.patchPolicyMeta(policyId, { provisional: true })
        chosen = policyId
        text =
            `[dream-rsi-memory] 做梦完成：基于 ${n} 个节点，策略 ${active.policyId} → ${policyId}。\n` +
            `  train ${baseline.train.totalScore.toFixed(3)} → ${best.train.toFixed(3)}` +
            (baseline.valid ? `，valid ${baseline.valid.totalScore.toFixed(3)} → ${(best.valid ?? 0).toFixed(3)}` : "") +
            `\n  新参数：${JSON.stringify(best.params)}\n  依据：${note}` +
            (stage === "M" ? `\n  ⚠ 试用期（M，${relaxedM ? "放宽门槛" : "双门槛"}）：新策略带 provisional 标记，正式期转正前可随时回滚。` : "")
    } else {
        chosen = active.policyId
        let promoted = ""
        // F 正式期：provisional 守擂成功（未切换）→ 视为转正，清除标记。
        if (stage === "F" && active.provisional) {
            store.patchPolicyMeta(active.policyId, { provisional: false })
            promoted = `\n  ✓ 正式期守擂成功：active 策略的 provisional 标记已清除（转正）。`
        }
        text =
            `[dream-rsi-memory] 做梦完成：${n} 个节点下无 ≥${relaxedM ? "2ε" : "ε"}(=${dreamCfg.epsilon}) 的稳健改进，保持策略 ${active.policyId}。\n` +
            `  train=${baseline.train.totalScore.toFixed(3)}${baseline.valid ? ` valid=${baseline.valid.totalScore.toFixed(3)}` : ""}\n` +
            `  最薄弱指标提示：${note}\n` +
            (llmCount ? `  （馆藏管理员提出 ${llmCount} 组候选，均未通过门槛）` : "") +
            promoted
    }

    // 分支评估 + 全自动切换（§7.1 打分 / §4.8 切换）：与浮点 replay 正交 —— 不切浮点
    // policy、不写经验节点，只改 strategy_alt.status。必须在 recordDream **之前**跑，
    // 否则 `strategy-advice=N` 只留在内存里的 notes，永远进不了持久化的 DreamRunRecord。
    const branch = evaluateStrategyBranches(store, deps.logger, deps.sessionId)
    if (branch.text) text += `\n${branch.text}`

    const notes = [
        `stage=${stage}`,
        note || "",
        relaxedM ? `relaxed-gate: valid=${validCount}<${dreamCfg.minValidNodes}` : "",
        curatorError,
        branch.records.length ? `strategy-advice=${branch.records.length}` : "",
    ]
        .filter(Boolean)
        .join(" · ")
    store.recordDream({
        runId,
        status: "done",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        candidatesJson: JSON.stringify(scored.map((s) => ({ params: s.params, train: s.train, valid: s.valid }))),
        chosenPolicyId: chosen,
        notes: notes || undefined,
    })

    deps.logger.info("dream finished", { runId, stage, better, chosen, strategyAdvice: branch.records.length })
    return { runId, text }
}