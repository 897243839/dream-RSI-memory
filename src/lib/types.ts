export type Outcome = "success" | "failed" | "partial"

export interface RecallParams {
    fileOverlapWeight: number
    ftsScoreWeight: number
    successBoost: number
    failureBoost: number
    recencyHalfLife: number
    maxRecall: number
    minScore: number
}

export const DEFAULT_PARAMS: RecallParams = {
    fileOverlapWeight: 0.5,
    ftsScoreWeight: 0.3,
    successBoost: 0.1,
    failureBoost: 0.25,
    recencyHalfLife: 50,
    maxRecall: 5,
    minScore: 0.05,
}

export const PARAM_CLAMPS: Record<keyof RecallParams, [number, number]> = {
    fileOverlapWeight: [0, 1],
    ftsScoreWeight: [0, 1],
    successBoost: [0, 0.4],
    failureBoost: [0, 0.5],
    recencyHalfLife: [20, 200],
    maxRecall: [1, 10],
    minScore: [0, 0.3],
}

export interface NodeRecord {
    nodeId: string
    projectId: string
    sessionId: string
    agentName: string
    parentId?: string
    branchId?: string
    summary: string
    outcome: Outcome
    score?: number
    why?: string
    errorMessage?: string
    policyVersion?: string
    files: string[]
    turnIndex: number
    createdAt: string
    autoCreated?: boolean
}

export interface PolicyRecord {
    policyId: string
    code: "params"
    params: RecallParams
    replayTrain?: number
    replayValid?: number
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

export type DreamStatus = "queued" | "running" | "done" | "failed"

export interface DreamRunRecord {
    runId: string
    status: DreamStatus
    startedAt?: string
    finishedAt?: string
    candidatesJson: string
    chosenPolicyId?: string
    notes?: string
}

export interface CommitInput {
    summary?: string
    files?: string[]
    outcome?: Outcome
    why?: string
    errorMessage?: string
    score?: number
    parentId?: string
    branchId?: string
    sessionId: string
    agentName: string
    autoCreated?: boolean
}

export interface HitResult {
    node: NodeRecord
    score: number
    fileMatch: boolean
    ftsMatch: boolean
    failureSimilar: boolean
}

export interface ReplayMetrics {
    fileHitRate: number
    failureAvoidRate: number
    precision: number
    recallBudget: number
    totalScore: number
}

export interface ReplayReport {
    train: ReplayMetrics
    valid: ReplayMetrics | null
    n: number
    splitIndex: number
    /** 本次回放实际并入 train 的真实查询用例数（不足阈值时为 0）。 */
    realCases: number
}

export interface CaptureMaterial {
    userText: string
    assistantText: string
    tools: { tool: string; error?: string }[]
}

export interface MemoryConfig {
    enabled: boolean
    dataDir: string
    debug: boolean
    /** Talk-to-turn material budget for captureTurn (commit/search auto-extraction). */
    capture: {
        maxMaterialChars: number
    }
    /** Optional background LLM that proposes parameter mutations during dreaming. */
    curator: {
        enabled: boolean
        providerID?: string
        modelID?: string
        timeoutMs: number
    }
    menu: {
        enabled: boolean
        cooldownTurns: number
        forceEveryTurns: number
        maxTokensHint: number
    }
    dream: {
        enabled: boolean
        /** N1：S 播种期上限（n < 此值不评估不切换，只写证据不足记录）。 */
        minNodesProvisional: number
        /** N2：F 正式期起点（M 试用期 = [minNodesProvisional, minNodes)）。 */
        minNodes: number
        /** M 期 valid 样本数低于此值时改走「只过 train 且 ε 加倍」的放宽门槛。 */
        minValidNodes: number
        trainRatio: number
        epsilon: number
        candidateCount: number
        /** 建库时播种的候选策略组数（p-default 之外）。 */
        seedCount: number
        /** 播种/启发式微扰的固定种子（测试可复现用；缺省 = fnv1a(projectId+createdAt)）。 */
        seed?: number
        /** 真实查询回放：标签窗口（turnIndex 区间长度）。 */
        queryWindowTurns: number
        /** 真实查询回放：真实用例数低于此值时不加真实用例（等于现状）。 */
        replayMinRealQueries: number
    }
    /** querylog.jsonl 的行数上限（append 后超限裁最旧）。 */
    queryLogMax: number
    replayWeights: {
        fileHitRate: number
        failureAvoidRate: number
        precision: number
        recallBudget: number
    }
    /** Auto-record a partial node when a session edits files and goes idle without dream_rsi_memory_commit. */
    autoCommitOnIdle: boolean
    /** Minimum gap between an idle auto-commit and the session's last recorded node. */
    autoCommitIdleGapMs: number
}

export interface ReplayOptions {
    trainRatio: number
    weights: MemoryConfig["replayWeights"]
    /** 真实查询回放（P2）：缺省 = 纯合成用例（旧行为不变）。 */
    queryLog?: {
        windowTurns: number
        minRealQueries: number
    }
}