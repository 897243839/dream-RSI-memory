import { randomUUID } from "node:crypto"
import type { Logger } from "./logger.js"
import type { MetaLlm } from "./meta-llm.js"
import { runReplay } from "./replay.js"
import { replayOptsOf } from "./report.js"
import { getStage } from "./stages.js"
import type { MemoryStore } from "./store.js"
import type { MemoryConfig, RecallParams, ReplayMetrics } from "./types.js"
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

export async function runDream(
    store: MemoryStore,
    config: MemoryConfig,
    deps: { logger: Logger; meta?: MetaLlm; focus?: string },
): Promise<DreamRunResult> {
    const runId = "r-" + randomUUID().slice(0, 8)
    const n = store.count()
    const dreamCfg = config.dream

    // P0 接通 dream.enabled：禁用时工具/命令都返回"已禁用"，不评估不记录。
    if (!dreamCfg.enabled) {
        return { runId, text: "[dream-rsi-memory] dream 已禁用（dream.enabled=false）：不评估、不切换。" }
    }

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
        return {
            runId,
            text:
                `[dream-rsi-memory] 做梦未评估：证据不足（n=${n} < ${dreamCfg.minNodesProvisional}），信号采集中。\n` +
                `  当前为播种期（S）：只积累节点与检索信号，不调参、不切换（策略保持 ${active.policyId}）。\n` +
                `  继续 dream_rsi_memory_commit / dream_rsi_memory_search；节点 ≥ ${dreamCfg.minNodesProvisional} 后进入试用期（M），dream 可试调。`,
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

    const notes = [`stage=${stage}`, note || "", relaxedM ? `relaxed-gate: valid=${validCount}<${dreamCfg.minValidNodes}` : "", curatorError]
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
    deps.logger.info("dream finished", { runId, stage, better, chosen })
    return { runId, text }
}