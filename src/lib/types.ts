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
    distillPending?: boolean
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
}

export interface CaptureMaterial {
    userText: string
    assistantText: string
    tools: { tool: string; error?: string }[]
}

export interface DistillResult {
    summary?: string
    why?: string
    outcome?: Outcome
    errorMessage?: string
    files?: string[]
}

export interface MemoryConfig {
    enabled: boolean
    dataDir: string
    debug: boolean
    distill: {
        enabled: boolean
        providerID?: string
        modelID?: string
        maxMaterialChars: number
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
        minNodes: number
        trainRatio: number
        epsilon: number
        candidateCount: number
    }
    replayWeights: {
        fileHitRate: number
        failureAvoidRate: number
        precision: number
        recallBudget: number
    }
    /** Auto-record a partial node when a session edits files and goes idle without commit_task_trace. */
    autoCommitOnIdle: boolean
    /** Minimum gap between an idle auto-commit and the session's last recorded node. */
    autoCommitIdleGapMs: number
}

export interface ReplayOptions {
    trainRatio: number
    weights: MemoryConfig["replayWeights"]
}