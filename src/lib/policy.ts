import { DEFAULT_PARAMS, type RecallParams } from "./types.js"
import { fnv1a32, mulberry32, nowIso, perturbParams } from "./utils.js"

/**
 * 策略记录（检索参数组）。自 store.ts 抽出（L1 叶子，只依赖 types/utils）：
 * 降低全仓最胖模块 store.ts 的复杂度，见设计方案 §1.4。
 */
export interface PolicyRecord {
    policyId: string
    code: "params"
    params: RecallParams
    isActive: boolean
    parentPolicyId?: string
    dreamRound: number
    createdAt: string
    /** Replay scores measured at policy-creation time (watchdog baseline). */
    replayAtCreation?: { train: number; valid: number | null }
    /** Provenance: "default" = p-default, "seed" = 建库时的播种候选（P1）。 */
    source?: "default" | "seed"
    /** 播种时使用的 RNG 种子（可复现性记录）。 */
    seed?: number
    /** 试用期（M）切换出的策略标记，正式期（F）守擂/切换后清除。 */
    provisional?: boolean
}

/** 建库/重建时的加载选项（P0/P1/P2：三阶段阈值无关，只带播种与日志配置）。 */
export interface StoreLoadOptions {
    /** 播种候选组数（默认 5）。 */
    seedCount?: number
    /** 固定 RNG 种子（缺省 = fnv1a(projectId + createdAt)，写进 PolicyRecord.seed 可复现）。 */
    seed?: number
    /** querylog.jsonl 上限（默认 1000）。 */
    queryLogMax?: number
}

export function makePolicy(
    policyId: string,
    params: RecallParams,
    dreamRound: number,
    parent?: string,
    source?: PolicyRecord["source"],
): PolicyRecord {
    return {
        policyId,
        code: "params",
        params,
        isActive: false,
        parentPolicyId: parent,
        dreamRound,
        createdAt: nowIso(),
        source,
    }
}

/**
 * P1 播种：p-default 之外生成 seedCount 组对 DEFAULT_PARAMS 做 seeded ±20% 扰动的
 * 候选策略（isActive:false，不激活）。种子 = config.seed ?? fnv1a(projectId+createdAt)，
 * 并写进每条记录的 seed 字段保证可复现。
 */
export function seedPolicies(projectId: string, createdAt: string, opts: StoreLoadOptions): PolicyRecord[] {
    const count = Math.max(0, Math.floor(opts.seedCount ?? 5))
    if (count === 0) return []
    const usedSeed = opts.seed ?? fnv1a32(projectId + createdAt)
    const rng = mulberry32(usedSeed)
    const out: PolicyRecord[] = []
    for (let i = 1; i <= count; i++) {
        const params = perturbParams(DEFAULT_PARAMS, rng)
        const policy = makePolicy(`p-seed-${i}`, params, 0, undefined, "seed")
        policy.seed = usedSeed
        out.push(policy)
    }
    return out
}

/** 建库用的初始策略组：p-default（激活）+ 播种候选（不激活）。 */
export function initialPolicies(projectId: string, createdAt: string, opts: StoreLoadOptions): Record<string, PolicyRecord> {
    const defaultPolicy = makePolicy("p-default", DEFAULT_PARAMS, 0, undefined, "default")
    const map: Record<string, PolicyRecord> = { [defaultPolicy.policyId]: { ...defaultPolicy, isActive: true } }
    for (const seedPolicy of seedPolicies(projectId, createdAt, opts)) map[seedPolicy.policyId] = seedPolicy
    return map
}
