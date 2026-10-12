import type { AdviceRecord, NodeRecord, StrategyAltNode, StrategySetNode } from "./types.js"
import { tokenSimilarity, tokenizeText } from "./scoring.js"

/**
 * 策略库纯函数层（设计方案 §1.1 的 L0.5）：护栏校验 / Wilson 打分 / 分支推导 /
 * 树遍历 / adviceLog 解析 / 全自动切换判定。
 *
 * 零环保证（§1.3）：本模块**不值 import** store / dream / report / config 等
 * L1 以上模块，只依赖 types 与 scoring（L0），保持可独立单测的纯函数。
 */

/* ------------------------------------------------------------------ 常量 */

/** 候选数量护栏（§5.1）：模型应先探索 ≥20 个方向，再筛到 3~10 个入库。 */
export const PROPOSE_MIN_ALTS = 3
export const PROPOSE_MAX_ALTS = 10

/** propose 字段限长（§6.2 失败面清单）。 */
export const LIMIT_PROBLEM = 80
export const LIMIT_NAME = 20
export const LIMIT_APPROACH = 300
export const LIMIT_TRADEOFFS = 200
export const LIMIT_ESTIMATED_RISK = 200

/** problem 与历史 set 判定为「同一问题」的相似度阈值（超过则复用不新建）。 */
export const SET_REUSE_SIMILARITY = 0.6

/* 分支评估门槛（§7.1） */
/** 子树样本不足此数不打分（score=null，不参与比较）。 */
export const MIN_SUBTREE_NODES = 3
/** 达到此 margin 才产出 advice。 */
export const ADVICE_DELTA = 0.15
/** 达到此 margin 且样本稳健才**自动切换**（比 adviceDelta 更保守）。 */
export const AUTO_SWITCH_DELTA = 0.2
/** 自动切换要求 best 的子树样本数下限（高于打分门槛 3）。 */
export const AUTO_SWITCH_MIN_SAMPLES = 5
/** Wilson 下界 z 值：1.0 ≈ 68% 置信，避免 n=3 时过度严苛。 */
export const WILSON_Z = 1

/** adviceLog FIFO 上限（§8，仿 querylog.ts 的上限裁剪）。 */
export const ADVICE_LOG_MAX = 50

/* ------------------------------------------------------------------ 类型 */

export interface AltCandidate {
    name: string
    approach: string
    tradeoffs: string
    estimatedRisk: string
}

export interface SetMeta {
    setId: string
    problem: string
    altIds: string[]
    /** 与 `altIds` 一一对应的候选名（工具层报「可用：…」时直接列出）。 */
    altNames: string[]
    chosenAltId?: string
}

/** 单个候选分支的子树打分结果（§7.1）。 */
export interface AltScore {
    altId: string
    name: string
    s: number
    f: number
    p: number
    n: number
    /** 子树样本不足 MIN_SUBTREE_NODES 时为 null。 */
    score: number | null
}

/** status 末尾的策略库概览（§5.3）。 */
export interface StrategyOverview {
    setCount: number
    altCount: number
    chosen: { setId: string; problem: string; altName: string } | null
    lastAdvice: AdviceRecord | null
    lastAutoSwitch: AdviceRecord | null
}

export type ProposeCheck = { ok: true } | { ok: false; reason: string; kind?: "reuse" }

/* ------------------------------------------------------------ 类型守卫 */

/** 经验节点：type 缺省（旧库磁盘上无此键）或显式 "experience"。 */
export function isExperience(node: NodeRecord): boolean {
    return !node.type || node.type === "experience"
}

export function isStrategySet(node: NodeRecord): node is StrategySetNode {
    return node.type === "strategy_set" && typeof node.problem === "string" && Array.isArray(node.altIds)
}

export function isStrategyAlt(node: NodeRecord): node is StrategyAltNode {
    return node.type === "strategy_alt" && typeof node.setId === "string" && typeof node.name === "string" && !!node.status
}

/* -------------------------------------------------------------- propose 护栏 */

/**
 * propose 的纯规则护栏（§3.3 / §5.1）。**不调 LLM、不写库**，只做规则判定：
 * 候选数、name 去重、字段限长、problem 与历史 set 相似（返回复用而非新建）。
 * 失败时 reason 已是可直接展示的中文串，工具层原样拼前缀返回。
 */
export function checkPropose(
    input: { problem: string; alternatives: AltCandidate[]; provisionalPick?: string },
    existing: SetMeta[],
): ProposeCheck {
    const problem = (input.problem ?? "").trim()
    const alts = input.alternatives ?? []

    if (alts.length < PROPOSE_MIN_ALTS || alts.length > PROPOSE_MAX_ALTS) {
        return {
            ok: false,
            reason: `候选数需 ${PROPOSE_MIN_ALTS}~${PROPOSE_MAX_ALTS}，当前 ${alts.length} 个（应先探索 ≥20 再筛）。`,
        }
    }

    if (!problem) return { ok: false, reason: "problem 不能为空（一句话描述这个设计决策问题）。" }
    if (problem.length > LIMIT_PROBLEM) {
        return { ok: false, reason: `problem 超长（≤${LIMIT_PROBLEM} 字，当前 ${problem.length}）。` }
    }

    const seen = new Set<string>()
    const dupes: string[] = []
    for (const alt of alts) {
        const name = (alt.name ?? "").trim()
        if (!name) return { ok: false, reason: "存在空的候选 name（每个候选需有 ≤20 字的唯一名字）。" }
        if (name.length > LIMIT_NAME) {
            return { ok: false, reason: `候选 "${name}" 的 name 超长（≤${LIMIT_NAME} 字，当前 ${name.length}）。` }
        }
        if (seen.has(name)) dupes.push(name)
        seen.add(name)
    }
    if (dupes.length > 0) {
        return { ok: false, reason: `候选 name 重复：${[...new Set(dupes)].join("、")}（set 内需唯一）。` }
    }

    const longField = alts.find((alt) => (alt.approach ?? "").length > LIMIT_APPROACH)
    if (longField) {
        return { ok: false, reason: `候选 "${longField.name}" 的 approach 超长（≤${LIMIT_APPROACH} 字）。` }
    }
    const longTradeoff = alts.find((alt) => (alt.tradeoffs ?? "").length > LIMIT_TRADEOFFS)
    if (longTradeoff) {
        return { ok: false, reason: `候选 "${longTradeoff.name}" 的 tradeoffs 超长（≤${LIMIT_TRADEOFFS} 字）。` }
    }
    const longRisk = alts.find((alt) => (alt.estimatedRisk ?? "").length > LIMIT_ESTIMATED_RISK)
    if (longRisk) {
        return { ok: false, reason: `候选 "${longRisk.name}" 的 estimatedRisk 超长（≤${LIMIT_ESTIMATED_RISK} 字）。` }
    }

    if (input.provisionalPick !== undefined && !seen.has(input.provisionalPick)) {
        return { ok: false, reason: `provisionalPick "${input.provisionalPick}" 不在 alternatives 中。` }
    }

    // problem 与历史 set 高相似 → 复用（不新建），否则会把同一决策拆成两个 set。
    const problemTokens = tokenizeText(problem)
    for (const meta of existing) {
        const similarity = tokenSimilarity(problemTokens, tokenizeText(meta.problem))
        if (similarity >= SET_REUSE_SIMILARITY) {
            return {
                ok: false,
                kind: "reuse",
                reason: `与已有决策问题相似，复用 set ${meta.setId}：${meta.problem}`,
            }
        }
    }

    return { ok: true }
}

/* ---------------------------------------------------- active alt 推导（§4.1） */

/**
 * 本会话「当前在执行的分支」：取该会话**最后一个** `status === "chosen"` 的
 * strategy_alt 节点。
 *
 * 排序键说明（§4.1）：**不能按 turnIndex 取最后** —— `patchNode` 只 `Object.assign`
 * 不改 turnIndex，先 pick(turn 21) 后 pick(turn 10) 会取错。正确性靠 §4.2
 * 「每会话 ≤1 chosen」不变量保证，数组顺序（创建序）遍历取最后一个即可。
 */
export function resolveActiveAlt(nodes: NodeRecord[], sessionId: string): NodeRecord | null {
    let found: NodeRecord | null = null
    for (const node of nodes) {
        if (node.sessionId !== sessionId) continue
        if (!isStrategyAlt(node)) continue
        if (node.status !== "chosen") continue
        found = node
    }
    return found
}

/* ------------------------------------------------------------ 树遍历（§7.3） */

export interface NodeIndex {
    byId: Map<string, NodeRecord>
    children: Map<string, string[]>
}

/** 一次建索引，供 descendantsOf 反复 O(子树大小) 遍历（全仓此前无树遍历）。 */
export function buildChildIndex(nodes: NodeRecord[]): NodeIndex {
    const byId = new Map<string, NodeRecord>()
    const children = new Map<string, string[]>()
    for (const node of nodes) {
        if (!node?.nodeId) continue
        byId.set(node.nodeId, node)
        const parent = node.parentId
        if (!parent) continue
        const list = children.get(parent)
        if (list) list.push(node.nodeId)
        else children.set(parent, [node.nodeId])
    }
    return { byId, children }
}

/**
 * 子树节点（**不含起点本身**：alt 节点自身 outcome 是占位 partial，
 * 计入会让 Wilson 统计自算一次）。
 * 起点不存在 / parentId 悬空 → 返回 `[]`，不抛（§6.2）。
 */
export function descendantsOf(idx: NodeIndex, rootId: string): NodeRecord[] {
    const root = idx.byId.get(rootId)
    if (!root) return []
    // 起点本身就是另一个 set 的根 → 没有可统计的子树
    if (root.type === "strategy_set") return []
    const out: NodeRecord[] = []
    const queue = [...(idx.children.get(rootId) ?? [])]
    const seen = new Set<string>([rootId])
    while (queue.length > 0) {
        const id = queue.shift() as string
        if (seen.has(id)) continue
        seen.add(id)
        const node = idx.byId.get(id)
        if (!node) continue
        // §7.1 隔离：**整棵切掉**另一个 strategy_set —— 连 set 自身都不入子树，而不只是
        // "不下钻"。两个设计决策的子树必须独立统计：同会话第二次 propose 时，新 set 的
        // 缺省父会落在上一个 set 的候选（或其子树内），一旦穿树，set2 连同它的候选与
        // 经验会一并算进 set1 的胜率，Wilson 双算污染 margin。
        // 判 type 而非 isStrategySet：脏 set（缺 problem/altIds）同样要挡住。
        if (node.type === "strategy_set") continue
        out.push(node)
        for (const child of idx.children.get(id) ?? []) queue.push(child)
    }
    return out
}

/* ------------------------------------------------------------ Wilson 打分（§7.1） */

/** Wilson 分数区间下界（二项比例的保守估计，小样本天然保守）。 */
export function wilsonLowerBound(wins: number, n: number, z: number = WILSON_Z): number {
    if (n <= 0) return 0
    const winsClamped = Math.min(Math.max(wins, 0), n)
    const p = winsClamped / n
    const z2 = z * z
    const denom = 1 + z2 / n
    const centre = p + z2 / (2 * n)
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
    return Math.max(0, (centre - margin) / denom)
}

/**
 * 统计一个候选分支的子树经验节点并打分。
 * - 只统计 `type === "experience"` 的节点（set/alt 不稀释胜率，§3.5）
 * - `partial` 计半权：`w = s + 0.5 * p`
 * - 样本不足 `minSamples` → `score = null`（不参与比较）
 */
export function scoreSubtree(nodes: NodeRecord[], minSamples: number = MIN_SUBTREE_NODES): Omit<AltScore, "altId" | "name"> {
    let s = 0
    let f = 0
    let p = 0
    for (const node of nodes) {
        if (!isExperience(node)) continue
        if (node.outcome === "success") s++
        else if (node.outcome === "failed") f++
        else p++
    }
    const n = s + f + p
    const score = n < minSamples ? null : wilsonLowerBound(s + 0.5 * p, n)
    return { s, f, p, n, score }
}

/* ---------------------------------------------------- 全自动切换判定（§4.8） */

export interface AutoSwitchInput {
    best: AltScore
    second: AltScore
    /** 当前会话 chosen 的 alt 节点 id；无则 undefined。 */
    currentChosenAltId: string | undefined
    /** 当前会话是否确有 active alt（§4.8 条件 3）。 */
    hasActiveAlt: boolean
}

/**
 * 全自动切换的四个条件（§4.8）：
 * 1. margin = best.score - second.score > AUTO_SWITCH_DELTA
 * 2. best ≠ 当前 chosen
 * 3. 当前会话确有 active alt（切换语义才清晰）
 * 4. best.n ≥ AUTO_SWITCH_MIN_SAMPLES（比打分门槛更稳健）
 */
export function canAutoSwitch(input: AutoSwitchInput): boolean {
    const { best, second, currentChosenAltId, hasActiveAlt } = input
    if (best.score === null || second.score === null) return false
    if (!hasActiveAlt) return false
    if (best.n < AUTO_SWITCH_MIN_SAMPLES) return false
    if (best.altId === currentChosenAltId) return false
    return best.score - second.score > AUTO_SWITCH_DELTA
}

/* ------------------------------------------------------------ adviceLog（§8） */

export function isValidAdvice(value: unknown): value is AdviceRecord {
    if (!value || typeof value !== "object") return false
    const a = value as Partial<AdviceRecord>
    return (
        typeof a.setId === "string" &&
        a.setId.length > 0 &&
        typeof a.problem === "string" &&
        typeof a.recommendedAltId === "string" &&
        a.recommendedAltId.length > 0 &&
        typeof a.recommendedAltName === "string" &&
        typeof a.margin === "number" &&
        Number.isFinite(a.margin) &&
        typeof a.nBest === "number" &&
        typeof a.nSecond === "number" &&
        typeof a.autoSwitched === "boolean" &&
        typeof a.createdAt === "string"
    )
}

/**
 * 解析 index.json 里的 adviceLog：非数组 → `[]`；脏条目逐条丢弃；
 * 超上限 FIFO 裁最旧（§6.3）。**绝不抛**，也绝不因此触发 rebuild。
 */
export function parseAdviceLog(raw: unknown): AdviceRecord[] {
    if (!Array.isArray(raw)) return []
    const valid = raw.filter(isValidAdvice)
    return valid.length > ADVICE_LOG_MAX ? valid.slice(valid.length - ADVICE_LOG_MAX) : valid
}

/* ------------------------------------------------------ 检索加权（§5.3） */

/** strategy_set 作为「决策入口」的命中分（query 与 problem 的语义相似度，0~1）。 */
export function strategySetHitScore(node: NodeRecord, queryTokens: Map<string, number>): number {
    if (!isStrategySet(node)) return 0
    if (queryTokens.size === 0) return 0
    return tokenSimilarity(queryTokens, tokenizeText(node.problem))
}
