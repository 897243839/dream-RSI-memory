import { createHash, randomUUID } from "node:crypto"
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

/** On-disk format v2: a small per-project index + one file per session. */
const DISK_VERSION = 2
const SESSION_DIR = "sessions"

interface IndexFile {
    version: typeof DISK_VERSION
    projectId: string
    rootPath: string
    createdAt: string
    activePolicyId: string
    policies: Record<string, PolicyRecord>
    dreamRuns: Record<string, DreamRunRecord>
}

interface SessionPart {
    version: typeof DISK_VERSION
    sessionId: string
    nodes: NodeRecord[]
}

let tmpSeq = 0
/** Atomic replace: write to a unique temp name in the same dir, then rename. */
async function atomicWrite(target: string, content: string): Promise<void> {
    const tmp = `${target}.tmp-${process.pid}-${tmpSeq++}`
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, target)
}

function sessionFileName(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unknown"
    return `${safe}-${createHash("sha1").update(sessionId).digest("hex").slice(0, 8)}.json`
}

function sessionKeyOf(node: NodeRecord): string {
    return node.sessionId || "unknown"
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
     *  concurrent mutators never lose updates. Per-file tmp names keep flushes
     *  from ever trampling each other. */
    private writeChain: Promise<void> = Promise.resolve()
    private readonly sessionsDir: string
    /** Live per-session node groups (values reference the same objects as data.nodes). */
    private readonly sessionNodes = new Map<string, NodeRecord[]>()
    private readonly dirtySessions = new Set<string>()
    private indexDirty = false

    private constructor(
        private readonly data: StoreData,
        private readonly dir: string,
        private readonly indexFile: string,
        sessionsDir: string,
        private readonly logger: Logger,
    ) {
        this.sessionsDir = sessionsDir
        for (const node of Object.values(data.nodes)) this.appendToSession(node)
    }

    private appendToSession(node: NodeRecord): void {
        const key = sessionKeyOf(node)
        const list = this.sessionNodes.get(key)
        if (list) list.push(node)
        else this.sessionNodes.set(key, [node])
    }

    static async load(projectId: string, rootPath: string, dataDir: string, logger: Logger): Promise<MemoryStore> {
        const dir = join(dataDir, projectId)
        const indexFile = join(dir, "index.json")
        const sessionsDir = join(dir, SESSION_DIR)
        await fs.mkdir(dir, { recursive: true })

        let data: StoreData | null = null
        let migrated = false

        // V2: small index + per-session files.
        if (data === null) {
            try {
                const index = JSON.parse(await fs.readFile(indexFile, "utf8")) as IndexFile
                if (index.version === DISK_VERSION && index.policies && index.activePolicyId) {
                    data = {
                        version: 1,
                        projectId: index.projectId,
                        rootPath: index.rootPath,
                        createdAt: index.createdAt,
                        nextTurnIndex: 0,
                        nodes: {},
                        order: [],
                        policies: index.policies,
                        activePolicyId: index.activePolicyId,
                        dreamRuns: index.dreamRuns,
                    }
                    const files = await fs.readdir(sessionsDir).catch(() => [] as string[])
                    for (const file of files) {
                        if (!file.endsWith(".json")) continue
                        try {
                            const part = JSON.parse(await fs.readFile(join(sessionsDir, file), "utf8")) as SessionPart
                            if (part?.version !== DISK_VERSION || !Array.isArray(part.nodes)) continue
                            for (const node of part.nodes) if (node?.nodeId) data.nodes[node.nodeId] = node
                        } catch {
                            // Skip a single corrupt session part; the rest still loads.
                        }
                    }
                }
            } catch {
                data = null
            }
        }

        // V1 migration: the old single per-project memory.json.
        if (data === null) {
            const legacyFile = join(dir, "memory.json")
            try {
                const legacy = JSON.parse(await fs.readFile(legacyFile, "utf8")) as StoreData
                if (legacy.version === 1 && legacy.nodes && legacy.order && legacy.policies && legacy.activePolicyId) {
                    data = legacy
                    migrated = true
                }
            } catch {
                data = null
            }
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
        }

        if (!data.policies[data.activePolicyId]) {
            const fallback = makePolicy(data.activePolicyId, DEFAULT_PARAMS, 0)
            data.policies[data.activePolicyId] = { ...fallback, isActive: true }
        }

        // turnIndex is the single source of truth for sequencing; rebuild in memory.
        data.nextTurnIndex = Object.values(data.nodes).reduce((max, n) => Math.max(max, n.turnIndex + 1), 0)
        data.order = Object.keys(data.nodes).sort((a, b) => data!.nodes[a].turnIndex - data!.nodes[b].turnIndex)

        const store = new MemoryStore(data, dir, indexFile, sessionsDir, logger)
        if (data.order.length === 0 || migrated) {
            // Fresh install or legacy conversion: materialize the v2 layout.
            for (const key of store.sessionNodes.keys()) store.dirtySessions.add(key)
            store.indexDirty = true
            await store.persist()
            if (migrated) await fs.rename(join(dir, "memory.json"), join(dir, "memory.json.bak")).catch(() => {})
        }
        return store
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
        this.indexDirty = true
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
        this.appendToSession(node)
        this.dirtySessions.add(sessionKeyOf(node))
        this.replayCache = null
        void this.persist()
        return node
    }

    patchNode(nodeId: string, patch: Partial<NodeRecord>): NodeRecord | undefined {
        const node = this.data.nodes[nodeId]
        if (!node) return undefined
        const oldKey = sessionKeyOf(node)
        Object.assign(node, patch)
        if (sessionKeyOf(node) !== oldKey) {
            // A node moved sessions: rebuild the group index.
            this.sessionNodes.clear()
            for (const n of Object.values(this.data.nodes)) this.appendToSession(n)
            this.dirtySessions.add(oldKey)
        }
        this.dirtySessions.add(sessionKeyOf(node))
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
        this.indexDirty = true
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
        this.indexDirty = true
        void this.persist()
    }

    updateDream(runId: string, patch: Partial<DreamRunRecord>): void {
        const run = this.data.dreamRuns[runId]
        if (!run) return
        Object.assign(run, patch)
        this.indexDirty = true
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

    private buildIndex(): IndexFile {
        return {
            version: DISK_VERSION,
            projectId: this.data.projectId,
            rootPath: this.data.rootPath,
            createdAt: this.data.createdAt,
            activePolicyId: this.data.activePolicyId,
            policies: this.data.policies,
            dreamRuns: this.data.dreamRuns,
        }
    }

    private async persist(): Promise<void> {
        const sessionDirty = [...this.dirtySessions]
        const needIndex = this.indexDirty
        this.dirtySessions.clear()
        this.indexDirty = false
        if (sessionDirty.length === 0 && !needIndex) return this.writeChain

        // Snapshots are taken synchronously at call time so queued writes cannot
        // lose updates made between the snapshot and the actual flush.
        const partSnapshots = new Map<string, string>()
        for (const key of sessionDirty) {
            const nodes = (this.sessionNodes.get(key) ?? []).filter((n) => sessionKeyOf(n) === key)
            partSnapshots.set(key, JSON.stringify({ version: DISK_VERSION, sessionId: key, nodes } satisfies SessionPart))
        }
        const indexSnapshot = needIndex ? JSON.stringify(this.buildIndex()) : null

        const sessionsDir = this.sessionsDir
        const indexFile = this.indexFile
        this.writeChain = this.writeChain
            .then(async () => {
                if (partSnapshots.size > 0) {
                    await fs.mkdir(sessionsDir, { recursive: true })
                    for (const [key, content] of partSnapshots) {
                        await atomicWrite(join(sessionsDir, sessionFileName(key)), content)
                    }
                }
                if (indexSnapshot !== null) await atomicWrite(indexFile, indexSnapshot)
            })
            .catch((error) => {
                this.logger.error("persist failed", { file: indexFile, error: String(error) })
            })
        return this.writeChain
    }
}