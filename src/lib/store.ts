import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import type { Logger } from "./logger.js"
import { clampParams, dedupe, nowIso, normalizeProjectPath } from "./utils.js"
import {
    DEFAULT_PARAMS,
    type CommitInput,
    type DreamRunRecord,
    type HitResult,
    type MemoryConfig,
    type NodeRecord,
    type PolicyRecord,
    type RecallParams,
} from "./types.js"
import {
    bm25Score,
    computeIdf,
    docTokenSize,
    fileOverlap,
    mergeTokenMaps,
    recencyScore,
    tokenSimilarity,
    tokenizePath,
    tokenizeText,
} from "./scoring.js"
import { runReplay } from "./replay.js"

interface StoreData {
    version: 1
    projectId: string
    rootPath: string
    createdAt: string
    nextTurnIndex: number
    nodes: Record<string, NodeRecord>
    order: string[]
    policies: Record<string, PolicyRecord>
    activePolicyId: string
    dreamRuns: Record<string, DreamRunRecord>
}

function makePolicy(policyId: string, params: RecallParams, dreamRound: number, parent?: string): PolicyRecord {
    return {
        policyId,
        code: "params",
        params,
        isActive: false,
        parentPolicyId: parent,
        dreamRound,
        createdAt: nowIso(),
    }
}

function bm25Normalized(bm25: number): number {
    return 1 / (1 + Math.abs(bm25))
}

export class MemoryStore {
    private replayCache: { at: number; train?: number; valid?: number } | null = null
    /** Serialized write queue: snapshots are taken synchronously at call time so
     *  concurrent mutators never lose updates, and the shared .tmp file is never
     *  written by two flushes at once. */
    private writeChain: Promise<void> = Promise.resolve()

    private constructor(
        private readonly data: StoreData,
        private readonly file: string,
        private readonly logger: Logger,
    ) {}

    static async load(projectId: string, rootPath: string, dataDir: string, logger: Logger): Promise<MemoryStore> {
        const dir = join(dataDir, projectId)
        const file = join(dir, "memory.json")
        await fs.mkdir(dir, { recursive: true })

        let data: StoreData | null = null
        try {
            const raw = await fs.readFile(file, "utf8")
            const parsed = JSON.parse(raw) as StoreData
            if (parsed.version === 1 && parsed.nodes && parsed.order && parsed.policies && parsed.activePolicyId) {
                data = parsed
            }
        } catch {
            data = null
        }

        if (data === null) {
            const defaultPolicy = makePolicy("p-default", DEFAULT_PARAMS, 0)
            data = {
                version: 1,
                projectId,
                rootPath,
                createdAt: nowIso(),
                nextTurnIndex: 0,
                nodes: {},
                order: [],
                policies: { [defaultPolicy.policyId]: { ...defaultPolicy, isActive: true } },
                activePolicyId: defaultPolicy.policyId,
                dreamRuns: {},
            }
            const store = new MemoryStore(data, file, logger)
            await store.persist()
            return store
        }

        if (!data.policies[data.activePolicyId]) {
            const fallback = makePolicy(data.activePolicyId, DEFAULT_PARAMS, 0)
            data.policies[data.activePolicyId] = { ...fallback, isActive: true }
        }
        data.order = [...data.order].sort((a, b) => (data!.nodes[a]?.turnIndex ?? 0) - (data!.nodes[b]?.turnIndex ?? 0))
        return new MemoryStore(data, file, logger)
    }

    getProjectId(): string {
        return this.data.projectId
    }

    getRootPath(): string {
        return this.data.rootPath
    }

    sortedNodes(): NodeRecord[] {
        return this.data.order.map((id) => this.data.nodes[id]).filter((n): n is NodeRecord => !!n)
    }

    count(): number {
        return this.data.order.length
    }

    getNode(nodeId: string): NodeRecord | undefined {
        return this.data.nodes[nodeId]
    }

    latestNode(): NodeRecord | undefined {
        const id = this.data.order[this.data.order.length - 1]
        return id ? this.data.nodes[id] : undefined
    }

    activePolicy(): PolicyRecord {
        return this.data.policies[this.data.activePolicyId] ?? { ...makePolicy("p-orphan", DEFAULT_PARAMS, 0), isActive: true }
    }

    listPolicies(): PolicyRecord[] {
        return Object.values(this.data.policies).sort((a, b) => a.dreamRound - b.dreamRound)
    }

    setActivePolicy(policyId: string): PolicyRecord | undefined {
        const next = this.data.policies[policyId]
        if (!next) return undefined
        for (const p of Object.values(this.data.policies)) p.isActive = p.policyId === policyId
        this.data.activePolicyId = policyId
        void this.persist()
        return next
    }

    patchNodePolicy(policyId: string, params: RecallParams, parentPolicyId?: string): PolicyRecord {
        const policy = makePolicy(policyId, params, Object.keys(this.data.policies).length, parentPolicyId)
        this.data.policies[policyId] = policy
        this.setActivePolicy(policyId)
        return policy
    }

    commit(input: CommitInput): NodeRecord {
        const nodeId = "n-" + randomUUID().slice(0, 8)
        const parentId = input.parentId ?? this.latestNode()?.nodeId
        const parent = parentId ? this.data.nodes[parentId] : undefined
        const branchId = input.branchId ?? (parent ? (parent.branchId ?? parentId) : nodeId)
        const turnIndex = this.data.nextTurnIndex++

        const node: NodeRecord = {
            nodeId,
            projectId: this.data.projectId,
            sessionId: input.sessionId,
            agentName: input.agentName,
            parentId,
            branchId,
            summary: input.summary ?? "",
            outcome: input.outcome ?? "partial",
            why: input.why,
            errorMessage: input.errorMessage,
            policyVersion: this.data.activePolicyId,
            files: dedupe(input.files ?? []),
            turnIndex,
            createdAt: nowIso(),
            distillPending: false,
        }
        if (input.score !== undefined) node.score = input.score
        if (input.autoCreated) node.autoCreated = true

        this.data.nodes[nodeId] = node
        this.data.order.push(nodeId)
        this.replayCache = null
        void this.persist()
        return node
    }

    patchNode(nodeId: string, patch: Partial<NodeRecord>): NodeRecord | undefined {
        const node = this.data.nodes[nodeId]
        if (!node) return undefined
        Object.assign(node, patch)
        this.replayCache = null
        void this.persist()
        return node
    }

    /** Latest commit time (in ms) for a session, or null if the session never committed. */
    lastNodeCommittedAtMs(sessionId: string): number | null {
        let latest: number | null = null
        for (const id of this.data.order) {
            const node = this.data.nodes[id]
            if (node.sessionId !== sessionId) continue
            const t = Date.parse(node.createdAt)
            if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t
        }
        return latest
    }

    patchPolicyMeta(policyId: string, meta: { replayAtCreation?: { train: number; valid: number | null } }): void {
        const policy = this.data.policies[policyId]
        if (!policy) return
        if (meta.replayAtCreation) policy.replayAtCreation = meta.replayAtCreation
        void this.persist()
    }

    /** Watchdog: warn when the active policy currently underperforms what it promised at creation time. */
    watchdogNotice(policyId: string, currentTrain: number, gate: number): string {
        const policy = this.data.policies[policyId]
        if (!policy?.replayAtCreation) return ""
        if (currentTrain < policy.replayAtCreation.train - gate) {
            const parent = policy.parentPolicyId
            return (
                `在线评估退化：${policyId} 当选时 train=${policy.replayAtCreation.train.toFixed(3)}，` +
                `当前 ${currentTrain.toFixed(3)}（差值超 ${gate.toFixed(3)}）。` +
                (parent ? `建议回滚：switch_policy ${parent}` : "建议回滚到默认参数。")
            )
        }
        return ""
    }

    recordDream(run: DreamRunRecord): void {
        this.data.dreamRuns[run.runId] = run
        void this.persist()
    }

    updateDream(runId: string, patch: Partial<DreamRunRecord>): void {
        const run = this.data.dreamRuns[runId]
        if (!run) return
        Object.assign(run, patch)
        void this.persist()
    }

    latestDream(): DreamRunRecord | undefined {
        const runs = Object.values(this.data.dreamRuns)
        if (runs.length === 0) return undefined
        runs.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
        return runs[runs.length - 1]
    }

    /** Lightweight stats for the menu injection, with a 60s replay cache. */
    menuStats(opts: { trainRatio: number; weights: MemoryConfig["replayWeights"] }): {
        nodeCount: number
        policyId: string
        replayTrain?: number
        replayValid?: number
    } {
        const nodeCount = this.count()
        const policyId = this.activePolicy().policyId
        if (nodeCount === 0) return { nodeCount, policyId }
        const now = Date.now()
        if (this.replayCache && now - this.replayCache.at < 60_000) {
            return { nodeCount, policyId, replayTrain: this.replayCache.train, replayValid: this.replayCache.valid }
        }
        const report = runReplay(this, this.activePolicy().params, opts)
        this.replayCache = { at: now, train: report.train.totalScore, valid: report.valid?.totalScore }
        return {
            nodeCount,
            policyId,
            replayTrain: report.train.totalScore,
            replayValid: report.valid?.totalScore,
        }
    }

    /**
     * Score candidate nodes against a query, strictly within a visible prefix.
     * Shared by search() (visible = all nodes) and replay (visible = history prefix).
     */
    scoreCandidates(
        visible: NodeRecord[],
        query: string,
        files: string[],
        params: RecallParams,
        nowTurn: number,
        opts: { minScore?: number; limit?: number } = {},
    ): HitResult[] {
        if (visible.length === 0) return []
        const p = clampParams(params)
        const limit = Math.round(Math.min(p.maxRecall, opts.limit ?? p.maxRecall))

        const queryTokens = mergeTokenMaps(tokenizeText(query), ...files.map((f) => tokenizePath(f)))
        const docs = visible.map((n) =>
            mergeTokenMaps(
                tokenizeText(n.summary),
                tokenizeText(n.why ?? ""),
                tokenizeText(n.errorMessage ?? ""),
                ...n.files.map((f) => tokenizePath(f)),
            ),
        )
        const idf = computeIdf(docs, docs.length)
        const avgLen = docs.reduce((sum, d) => sum + docTokenSize(d), 0) / Math.max(docs.length, 1)

        const qFiles = files.map((f) => normalizeProjectPath(this.data.rootPath, f) ?? f)
        const qErrorTokens = tokenizeText(query)

        const results: HitResult[] = []
        for (let i = 0; i < visible.length; i++) {
            const node = visible[i]
            const doc = docs[i]
            const bm25 = bm25Score(queryTokens, doc, idf, docTokenSize(doc), avgLen)
            const fts = bm25Normalized(bm25)
            const ov = fileOverlap(node.files, qFiles)
            const failureSimilar =
                node.outcome === "failed" &&
                (ov > 0 || tokenSimilarity(qErrorTokens, tokenizeText(node.errorMessage ?? "")) > 0.15)
            const rec = recencyScore(nowTurn - node.turnIndex, p.recencyHalfLife)
            const score =
                rec * (p.fileOverlapWeight * ov + p.ftsScoreWeight * fts) +
                (node.outcome === "success" ? p.successBoost : 0) +
                (node.outcome === "failed" && failureSimilar ? p.failureBoost : 0)

            if (score < (opts.minScore ?? p.minScore)) continue
            results.push({ node, score, fileMatch: ov > 0, ftsMatch: fts > 0, failureSimilar })
        }
        results.sort((a, b) => b.score - a.score)
        return results.slice(0, limit)
    }

    search(query: string, files: string[], opts: { limit?: number; minScore?: number; params?: RecallParams } = {}): HitResult[] {
        const nodes = this.sortedNodes()
        if (nodes.length === 0) return []
        const nowTurn = this.data.nextTurnIndex - 1
        const params = opts.params ?? this.activePolicy().params
        return this.scoreCandidates(nodes, query, files, params, nowTurn, { limit: opts.limit, minScore: opts.minScore })
    }

    private async persist(): Promise<void> {
        const snapshot = JSON.stringify(this.data)
        this.writeChain = this.writeChain
            .then(async () => {
                const tmp = this.file + ".tmp"
                await fs.writeFile(tmp, snapshot, "utf8")
                await fs.rename(tmp, this.file)
            })
            .catch((error) => {
                this.logger.error("persist failed", { file: this.file, error: String(error) })
            })
        return this.writeChain
    }
}