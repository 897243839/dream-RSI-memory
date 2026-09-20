import { randomUUID } from "node:crypto"
import type { Logger } from "./logger.js"
import type { MetaLlm } from "./meta-llm.js"
import { runReplay } from "./replay.js"
import type { MemoryStore } from "./store.js"
import type { MemoryConfig, RecallParams, ReplayMetrics } from "./types.js"
import { clampParams } from "./utils.js"

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
 * with `focus` the requested aspect wins (matching the run_dream_optimization
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
    if (n < config.dream.minNodes) {
        return { runId, text: `[dream-memory] 做梦跳过：节点数 ${n} < ${config.dream.minNodes}（还需 ${config.dream.minNodes - n} 个）。` }
    }

    const replayOpts = { trainRatio: config.dream.trainRatio, weights: config.replayWeights }
    const active = store.activePolicy()
    const baseline = runReplay(store, active.params, replayOpts)
    const note = noteFor(baseline.train, config.replayWeights, deps.focus)

    const candidates: RecallParams[] = [active.params]
    candidates.push(...heuristicVariants(active.params, note, config.dream.candidateCount))
    let llmCount = 0
    if (deps.meta?.configured) {
        const fromLlm = await deps.meta.mutate(active.params, note)
        llmCount = fromLlm.length
        candidates.push(...fromLlm)
    }

    const scored: { params: RecallParams; train: number; valid: number | null }[] = []
    for (const cand of candidates) {
        const report = runReplay(store, cand, replayOpts)
        scored.push({ params: cand, train: report.train.totalScore, valid: report.valid?.totalScore ?? null })
    }
    scored.sort((a, b) => b.train - a.train)

    const best = scored[0]
    const baseInvalid = baseline.valid === null
    const validOkay = baseInvalid || (best.valid !== null && best.valid >= (baseline.valid?.totalScore ?? 0) + config.dream.epsilon)
    const better = best.train > baseline.train.totalScore + config.dream.epsilon && validOkay

    let chosen = ""
    let text: string
    if (better && best.params !== active.params) {
        const policyId = "p-" + randomUUID().slice(0, 8)
        store.patchNodePolicy(policyId, best.params, active.policyId)
        store.patchPolicyMeta(policyId, { replayAtCreation: { train: best.train, valid: best.valid } })
        chosen = policyId
        text =
            `[dream-memory] 做梦完成：基于 ${n} 个节点，策略 ${active.policyId} → ${policyId}。\n` +
            `  train ${baseline.train.totalScore.toFixed(3)} → ${best.train.toFixed(3)}` +
            (baseline.valid ? `，valid ${baseline.valid.totalScore.toFixed(3)} → ${(best.valid ?? 0).toFixed(3)}` : "") +
            `\n  新参数：${JSON.stringify(best.params)}\n  依据：${note}`
    } else {
        chosen = active.policyId
        text =
            `[dream-memory] 做梦完成：${n} 个节点下无 ≥ε(=${config.dream.epsilon}) 的稳健改进，保持策略 ${active.policyId}。\n` +
            `  train=${baseline.train.totalScore.toFixed(3)}${baseline.valid ? ` valid=${baseline.valid.totalScore.toFixed(3)}` : ""}\n` +
            `  最薄弱指标提示：${note}\n` +
            (llmCount ? `  （馆藏官提出 ${llmCount} 组候选，均未通过 valid 校验）` : "")
    }

    store.recordDream({
        runId,
        status: "done",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        candidatesJson: JSON.stringify(scored.map((s) => ({ params: s.params, train: s.train, valid: s.valid }))),
        chosenPolicyId: chosen,
        notes: note || undefined,
    })
    deps.logger.info("dream finished", { runId, better, chosen })
    return { runId, text }
}