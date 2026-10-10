import { readQueryLog, type QueryLogEntry } from "./querylog.js"
import { FAILURE_SIM_THRESHOLD, extractPathsFromText, fileOverlap, tokenSimilarity, tokenizeText } from "./scoring.js"
import type { MemoryStore } from "./store.js"
import type { NodeRecord, RecallParams, ReplayMetrics, ReplayOptions, ReplayReport } from "./types.js"
import { normalizeProjectPath } from "./utils.js"

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

/** 指标累加器（合成用例与真实用例同口径，最后统一折算成 ReplayMetrics）。 */
interface MetricParts {
    fileHit: number
    fileHitDen: number
    prec: number
    precCount: number
    failAvoid: number
    failDen: number
    budget: number
    budgetCount: number
}

function emptyParts(): MetricParts {
    return { fileHit: 0, fileHitDen: 0, prec: 0, precCount: 0, failAvoid: 0, failDen: 0, budget: 0, budgetCount: 0 }
}

function addParts(a: MetricParts, b: MetricParts): MetricParts {
    return {
        fileHit: a.fileHit + b.fileHit,
        fileHitDen: a.fileHitDen + b.fileHitDen,
        prec: a.prec + b.prec,
        precCount: a.precCount + b.precCount,
        failAvoid: a.failAvoid + b.failAvoid,
        failDen: a.failDen + b.failDen,
        budget: a.budget + b.budget,
        budgetCount: a.budgetCount + b.budgetCount,
    }
}

function metricsOf(parts: MetricParts, weights: ReplayOptions["weights"]): ReplayMetrics {
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

function evalRange(store: MemoryStore, nodes: NodeRecord[], params: RecallParams, start: number, end: number): MetricParts {
    const parts = emptyParts()
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
    return parts
}

/** 从查询原文提取文件路径并归一化为项目相对 posix 路径（供标签交集与检索文件参数）。 */
function queryFiles(store: MemoryStore, query: string): string[] {
    const root = store.getRootPath()
    const out: string[] = []
    for (const raw of extractPathsFromText(query)) {
        const norm = normalizeProjectPath(root, raw) ?? raw
        if (norm && !out.includes(norm)) out.push(norm)
    }
    return out
}

/** 把 querylog 条目解析成可见集起点 turnIndex；映射不上返回 null（该条丢弃）。 */
function resolveTurn(entry: QueryLogEntry, nodes: NodeRecord[]): number | null {
    if (typeof entry.turnIndex === "number" && Number.isFinite(entry.turnIndex)) return entry.turnIndex
    // turnIndex 缺失 → 按 ts 与节点时间序映射：最后一个 createdAt <= ts 的节点
    const t = Date.parse(entry.ts)
    if (Number.isNaN(t)) return null
    let mapped: number | null = null
    for (const node of nodes) {
        const created = Date.parse(node.createdAt)
        if (!Number.isNaN(created) && created <= t) mapped = node.turnIndex
    }
    return mapped
}

/**
 * 真实查询用例（P2）：对每条 querylog——
 * - 可见集 = turnIndex ≤ 该查询时刻的节点；
 * - 检索 = log.query 原文 + 从 query 文本提取的文件路径；
 * - 标签集 = turnIndex ∈ (t, t+windowTurns]、outcome=success、且 files 与查询提取
 *   文件有交集的节点。**标签只来自节点自身，与被评估策略无关**（防自我确认）。
 * 指标口径与合成用例一致：fileHitRate / precision 计到标签集上；
 * 标签仅 success 节点，failureAvoid 分母不增加（对既有指标无副作用）。
 */
function evalRealCases(store: MemoryStore, logs: QueryLogEntry[], params: RecallParams, windowTurns: number): MetricParts {
    const parts = emptyParts()
    const nodes = store.sortedNodes()
    if (nodes.length === 0) return parts
    for (const entry of logs) {
        const t = resolveTurn(entry, nodes)
        if (t === null) continue
        const files = queryFiles(store, entry.query)
        if (files.length === 0) continue // query 提不出文件路径 → 该用例跳过
        const visible = nodes.filter((n) => n.turnIndex <= t)
        if (visible.length === 0) continue
        const labelIds = new Set(
            nodes
                .filter(
                    (n) =>
                        n.turnIndex > t &&
                        n.turnIndex <= t + windowTurns &&
                        n.outcome === "success" &&
                        fileOverlap(n.files, files) > 0,
                )
                .map((n) => n.nodeId),
        )
        const hits = store.scoreCandidates(visible, entry.query, files, params, t)

        if (files.length) {
            parts.fileHitDen++
            if (hits.some((h) => fileOverlap(h.node.files, files) > 0)) parts.fileHit++
        }
        if (hits.length) {
            let relevant = 0
            for (const hit of hits) if (labelIds.has(hit.node.nodeId)) relevant++
            parts.prec += relevant / hits.length
            parts.precCount++
        }
        parts.budget += hits.length / Math.max(params.maxRecall, 1)
        parts.budgetCount++
    }
    return parts
}

export function splitIndex(n: number, trainRatio: number): number {
    return Math.floor(n * trainRatio)
}

/**
 * Holdout replay (design §9.7): train evaluates the earlier timeline, valid the later one.
 * Both strict time-line: candidate visible set = nodes before the target turn.
 * P2：queryLog 配置存在且真实用例数 ≥ minRealQueries 时，把真实查询用例并入 train
 * （∪ 合成用例）；否则与旧行为完全一致（realCases=0）。
 */
export function runReplay(store: MemoryStore, params: RecallParams, opts: ReplayOptions): ReplayReport {
    const nodes = store.sortedNodes()
    const n = nodes.length
    const split = splitIndex(n, opts.trainRatio)
    let trainParts = evalRange(store, nodes, params, 0, split)
    let realCases = 0
    if (opts.queryLog && Number.isFinite(opts.queryLog.minRealQueries) && opts.queryLog.minRealQueries > 0) {
        const logs = readQueryLog(store.getProjectDir())
        if (logs.length >= opts.queryLog.minRealQueries) {
            const realParts = evalRealCases(store, logs, params, opts.queryLog.windowTurns)
            // evalRealCases 可能因映射不上/无文件路径丢弃部分条目；realCases 计实际并入的用例数
            realCases = realParts.budgetCount
            trainParts = addParts(trainParts, realParts)
        }
    }
    const train = metricsOf(trainParts, opts.weights)
    const valid = n > split && split > 0 ? metricsOf(evalRange(store, nodes, params, split, n), opts.weights) : null
    return { train, valid, n, splitIndex: split, realCases }
}
