import type { MemoryStore } from "./store.js"
import { FAILURE_SIM_THRESHOLD, fileOverlap, tokenSimilarity, tokenizeText } from "./scoring.js"
import type { NodeRecord, RecallParams, ReplayMetrics, ReplayOptions, ReplayReport } from "./types.js"

const RELEVANCE_THRESHOLD = 0.15
const FAILURE_THRESHOLD = FAILURE_SIM_THRESHOLD

export function isRelevant(lookup: NodeRecord, target: NodeRecord): boolean {
    if (fileOverlap(lookup.files, target.files) > 0) return true
    const sim = tokenSimilarity(
        tokenizeText(lookup.summary + " " + (lookup.why ?? "")),
        tokenizeText(target.summary),
    )
    return sim > RELEVANCE_THRESHOLD
}

function sharedFailure(a: NodeRecord, b: NodeRecord): boolean {
    if (fileOverlap(a.files, b.files) > 0) return true
    return tokenSimilarity(tokenizeText(a.errorMessage ?? ""), tokenizeText(b.errorMessage ?? "")) > FAILURE_THRESHOLD
}

function metricsOf(parts: {
    fileHit: number
    fileHitDen: number
    prec: number
    precCount: number
    failAvoid: number
    failDen: number
    budget: number
    budgetCount: number
}, weights: ReplayOptions["weights"]): ReplayMetrics {
    const fileHitRate = parts.fileHitDen > 0 ? parts.fileHit / parts.fileHitDen : 0
    const precision = parts.precCount > 0 ? parts.prec / parts.precCount : 0
    const failureAvoidRate = parts.failDen > 0 ? parts.failAvoid / parts.failDen : 0
    const recallBudget = parts.budgetCount > 0 ? 1 - parts.budget / parts.budgetCount : 0
    const totalScore =
        weights.fileHitRate * fileHitRate +
        weights.failureAvoidRate * failureAvoidRate +
        weights.precision * precision +
        weights.recallBudget * recallBudget
    return { fileHitRate, failureAvoidRate, precision, recallBudget, totalScore }
}

function evalRange(store: MemoryStore, nodes: NodeRecord[], params: RecallParams, start: number, end: number, opts: ReplayOptions): ReplayMetrics {
    const parts = { fileHit: 0, fileHitDen: 0, prec: 0, precCount: 0, failAvoid: 0, failDen: 0, budget: 0, budgetCount: 0 }
    for (let i = start; i < end; i++) {
        const target = nodes[i]
        if (i === 0) continue // no history before the first node
        const query = target.summary + (target.files.length ? " " + target.files.join(" ") : "")
        const hits = store.scoreCandidates(nodes.slice(0, i), query, target.files, params, target.turnIndex)

        if (target.files.length) {
            parts.fileHitDen++
            if (hits.some((h) => fileOverlap(h.node.files, target.files) > 0)) parts.fileHit++
        }
        if (hits.length) {
            let relevant = 0
            for (const hit of hits) if (isRelevant(hit.node, target)) relevant++
            parts.prec += relevant / hits.length
            parts.precCount++
        }
        if (target.outcome === "failed") {
            parts.failDen++
            if (hits.some((h) => h.node.outcome === "failed" && sharedFailure(h.node, target))) parts.failAvoid++
        }
        parts.budget += hits.length / Math.max(params.maxRecall, 1)
        parts.budgetCount++
    }
    return metricsOf(parts, opts.weights)
}

export function splitIndex(n: number, trainRatio: number): number {
    return Math.floor(n * trainRatio)
}

/**
 * Holdout replay (design §9.7): train evaluates the earlier timeline, valid the later one.
 * Both strict time-line: candidate visible set = nodes before the target turn.
 */
export function runReplay(store: MemoryStore, params: RecallParams, opts: ReplayOptions): ReplayReport {
    const nodes = store.sortedNodes()
    const n = nodes.length
    const split = splitIndex(n, opts.trainRatio)
    const train = evalRange(store, nodes, params, 0, split, opts)
    const valid = n > split && split > 0 ? evalRange(store, nodes, params, split, n, opts) : null
    return { train, valid, n, splitIndex: split }
}