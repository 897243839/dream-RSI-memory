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

/**
 * 节点类型：经验节点（缺省）/ 策略集（设计决策问题）/ 策略候选分支 /
 * 策略切换轨迹（pick 写的隐式记录节点）。
 *
 * `strategy_note` 是为了让 §2.5 的切换轨迹**不稀释经验统计** —— 它不是可复用
 * 经验，计入 `count()` 会提前触发阶段切换、污染在线胜率（§3.5）。
 */
export type NodeType = "experience" | "strategy_set" | "strategy_alt" | "strategy_note"

/** 候选分支状态（4 个，不新增）：未证明 / 当前选定 / 被更优分支替代 / 真实证伪。 */
export type AltStatus = "unproven" | "chosen" | "superseded" | "rejected"

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
    /** 缺省视为 "experience"（旧库兼容：磁盘上无此键）。 */
    type?: NodeType
    /** strategy_set 专用：设计决策问题陈述。 */
    problem?: string
    /** strategy_set 专用：候选 alt 节点 id 列表。 */
    altIds?: string[]
    /** strategy_set 专用：当前 chosen 的 alt 节点 id。 */
    chosenAltId?: string
    /** strategy_alt 专用：所属 set 节点 id。 */
    setId?: string
    /** strategy_alt 专用：候选名（set 内唯一）。 */
    name?: string
    /** strategy_alt 专用：实现路径。 */
    approach?: string
    /** strategy_alt 专用：代价/取舍。 */
    tradeoffs?: string
    /** strategy_alt 专用：预估风险。 */
    estimatedRisk?: string
    /** strategy_alt 专用：候选状态。 */
    status?: AltStatus
}

/** strategy_set 节点的收窄别名（便于消费侧免逐字段判空）。 */
export type StrategySetNode = NodeRecord & { type: "strategy_set"; problem: string; altIds: string[] }

/** strategy_alt 节点的收窄别名。 */
export type StrategyAltNode = NodeRecord & { type: "strategy_alt"; setId: string; name: string; status: AltStatus }

/** dream 分支评估产出的建议记录（追加到 index.json 的 adviceLog，FIFO 上限 50）。 */
export interface AdviceRecord {
    setId: string
    problem: string
    recommendedAltId: string
    recommendedAltName: string
    margin: number
    /** best 的子树经验节点数。 */
    nBest: number
    nSecond: number
    /** 本次建议是否触发了全自动切换。 */
    autoSwitched: boolean
    createdAt: string
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
    /** 节点类型（策略库轨迹节点用 strategy_note，避免计入经验统计）。 */
    type?: NodeType
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