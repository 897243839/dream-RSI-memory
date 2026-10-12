import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import type { Logger } from "./logger.js"
import { clampParams, dedupe, fnv1a32, isRootPath, mulberry32, nowIso, normalizeProjectPath, perturbParams } from "./utils.js"
import { appendQueryLog, readQueryLog, type QueryTrigger } from "./querylog.js"
import { initialPolicies, makePolicy, type PolicyRecord, type StoreLoadOptions } from "./policy.js"
import {
    DEFAULT_PARAMS,
    type AdviceRecord,
    type CommitInput,
    type DreamRunRecord,
    type HitResult,
    type MemoryConfig,
    type NodeRecord,
    type Outcome,
    type RecallParams,
    type ReplayOptions,
    type StrategyAltNode,
} from "./types.js"
import {
    FAILURE_SIM_THRESHOLD,
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
import {
    ADVICE_LOG_MAX,
    buildChildIndex,
    descendantsOf,
    isExperience,
    isStrategyAlt,
    isStrategySet,
    isValidAdvice,
    parseAdviceLog,
    resolveActiveAlt as resolveActiveAltPure,
    strategySetHitScore,
    type AltCandidate,
    type SetMeta,
    type StrategyOverview,
} from "./strategy.js"

export type { StoreLoadOptions }

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
    adviceLog: AdviceRecord[]
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
    /** 检索建议 + 自动切换轨迹（设计方案 §8；懒补见 §2.4）。 */
    adviceLog: AdviceRecord[]
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
    try {
        await fs.rename(tmp, target)
    } catch (error) {
        // rename failed (e.g. target locked) — remove the temp file, rethrow
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw error
    }
}

/** tmp 文件存活阈值：超过此龄才认定为崩溃残留（§4.7）。 */
const STALE_TMP_MS = 60_000

/** tmp 文件名的严格形态：`<target>.tmp-<pid>-<seq>` 结尾（见 `atomicWrite`）。 */
const STALE_TMP_NAME = /\.tmp-(\d+)-\d+$/

/**
 * 清理目录里崩溃/中断留下的 `*.tmp-<pid>-<n>`。
 *
 * §4.7：原实现无差别删掉目录内**所有** `.tmp-` 文件，会删掉另一个 opencode 进程正在写的
 * 临时文件 —— 它随后 rename 时抛错，而该异常被 `writeChain` 的 catch 静默吞掉 →
 * **静默丢一次写**（它自己就是跨进程破坏源）。现在只删「pid ≠ 本进程 且 mtime 超过
 * `STALE_TMP_MS`」的文件；命名规则解析不出 pid 的保守不删。
 */
async function cleanupStaleTmp(dir: string, logger: Logger): Promise<void> {
    let names: string[] = []
    try {
        names = await fs.readdir(dir)
    } catch {
        return // directory missing — nothing to clean
    }
    await Promise.all(
        names
            // 必须**精确匹配** tmp 命名（`<target>.tmp-<pid>-<seq>` 结尾）。仅按 `.tmp-`
            // 子串判别会误伤合法 session 文件：sessionId 白名单保留了 `.` 与 `-`，
            // `abc.tmp-4242-<sha8>.json` 会解析出 pid=4242，一旦超过 60s 就被删 ——
            // 该会话全部节点静默消失（index 不存节点，rebuild 不触发，无任何报错）。
            .filter((name) => {
                const match = STALE_TMP_NAME.exec(name)
                if (!match) return false // 命名形态不符 → 保守不删
                return Number.parseInt(match[1], 10) !== process.pid
            })
            .map(async (name) => {
                const full = join(dir, name)
                try {
                    const stat = await fs.stat(full)
                    if (Date.now() - stat.mtimeMs < STALE_TMP_MS) return
                    await fs.rm(full, { force: true })
                } catch (error) {
                    logger.debug("stale tmp sweep skipped", { name, error: String(error) })
                }
            }),
    )
}

function sessionFileName(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unknown"
    return `${safe}-${createHash("sha1").update(sessionId).digest("hex").slice(0, 8)}.json`
}

function sessionKeyOf(node: NodeRecord): string {
    return node.sessionId || "unknown"
}

function bm25Normalized(bm25: number): number {
    if (bm25 <= 0) return 0
    return 1 / (1 + bm25)
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
        private readonly queryLogMax: number = 1000,
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

    /**
     * Rebuild StoreData from session files when index.json is lost/corrupted.
     * Scans sessions/*.json, collects all nodes, rebuilds with default policies.
     */
    private static async rebuildFromSessions(
        sessionsDir: string,
        projectId: string,
        rootPath: string,
        logger: Logger,
        opts: StoreLoadOptions,
    ): Promise<StoreData | null> {
        try {
            const files = await fs.readdir(sessionsDir).catch(() => [] as string[])
            const allNodes: NodeRecord[] = []
            for (const file of files) {
                if (!file.endsWith(".json")) continue
                try {
                    const part = JSON.parse(await fs.readFile(join(sessionsDir, file), "utf8")) as SessionPart
                    if (part?.version === DISK_VERSION && Array.isArray(part.nodes)) {
                        allNodes.push(...part.nodes.filter((n) => n?.nodeId))
                    }
                } catch {
                    // Skip corrupt session file
                }
            }
            if (allNodes.length === 0) return null

            const createdAt = nowIso()
            const data: StoreData = {
                version: 1,
                projectId,
                rootPath,
                createdAt,
                nextTurnIndex: 0,
                nodes: {},
                order: [],
                policies: initialPolicies(projectId, createdAt, opts),
                activePolicyId: "p-default",
                dreamRuns: {},
                adviceLog: [],
            }
            for (const node of allNodes) {
                data.nodes[node.nodeId] = node
            }
            data.nextTurnIndex = Object.values(data.nodes).reduce((max, n) => Math.max(max, n.turnIndex + 1), 0)
            data.order = Object.keys(data.nodes).sort((a, b) => data.nodes[a].turnIndex - data.nodes[b].turnIndex)

            logger.warn("rebuilt index from session files", { nodesRecovered: allNodes.length })
            return data
        } catch (error) {
            logger.error("rebuildFromSessions failed", { error: String(error) })
            return null
        }
    }

    static async load(
        projectId: string,
        rootPath: string,
        dataDir: string,
        logger: Logger,
        opts: StoreLoadOptions = {},
    ): Promise<MemoryStore> {
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
                        adviceLog: parseAdviceLog(index.adviceLog),
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

        // Rebuild from session files if index.json is lost/corrupted.
        if (data === null) {
            data = await MemoryStore.rebuildFromSessions(sessionsDir, projectId, rootPath, logger, opts)
            if (data) migrated = true // trigger persist to write a correct index.json
        }

        if (data === null) {
            const createdAt = nowIso()
            data = {
                version: 1,
                projectId,
                rootPath,
                createdAt,
                nextTurnIndex: 0,
                nodes: {},
                order: [],
                policies: initialPolicies(projectId, createdAt, opts),
                activePolicyId: "p-default",
                dreamRuns: {},
                adviceLog: [],
            }
        }

        // adviceLog 懒补 + 脏数据过滤（设计方案 §2.4 / §6.3）：统一在 4 个构造分支汇合后执行。
        // 幂等（parseAdviceLog 自身容错），覆盖 legacy V1 迁移与 V2 读盘两条路径；
        // **绝不**把 adviceLog 塞进 index 门条件——一条脏数据触发 rebuild 会丢掉 policies/dreamRuns。
        data.adviceLog = parseAdviceLog(data.adviceLog)

        if (!data.policies[data.activePolicyId]) {
            const fallback = makePolicy(data.activePolicyId, DEFAULT_PARAMS, 0)
            data.policies[data.activePolicyId] = { ...fallback, isActive: true }
        }

        // turnIndex is the single source of truth for sequencing; rebuild in memory.
        data.nextTurnIndex = Object.values(data.nodes).reduce((max, n) => Math.max(max, n.turnIndex + 1), 0)
        data.order = Object.keys(data.nodes).sort((a, b) => data!.nodes[a].turnIndex - data!.nodes[b].turnIndex)

        // Repair a persisted garbage rootPath (e.g. "/" stored by a bad startup):
        // the live cwd is authoritative, overwrite and mark index dirty so the
        // corrected value is flushed back to disk.
        if (!data.rootPath || isRootPath(data.rootPath)) {
            data.rootPath = rootPath
            migrated = true
        }

        const store = new MemoryStore(data, dir, indexFile, sessionsDir, logger, opts.queryLogMax ?? 1000)
        if (data.order.length === 0 || migrated) {
            // Fresh install or legacy conversion: materialize the v2 layout.
            for (const key of store.sessionNodes.keys()) store.dirtySessions.add(key)
            store.indexDirty = true
            await store.persist()
            if (migrated) await fs.rename(join(dir, "memory.json"), join(dir, "memory.json.bak")).catch(() => {})
        }
        return store
    }

    getRootPath(): string {
        return this.data.rootPath
    }

    sortedNodes(): NodeRecord[] {
        return this.data.order.map((id) => this.data.nodes[id]).filter((n): n is NodeRecord => !!n)
    }

    count(): number {
        // §3.5：只数经验节点——strategy_set/strategy_alt 混入会让节点数虚增，
        // 提前触发 S→M→F 阶段切换（report.getStage 消费这里）。
        let n = 0
        for (const id of this.data.order) {
            const node = this.data.nodes[id]
            if (node && isExperience(node)) n++
        }
        return n
    }

    getNode(nodeId: string): NodeRecord | undefined {
        return this.data.nodes[nodeId]
    }

    latestNode(): NodeRecord | undefined {
        const id = this.data.order[this.data.order.length - 1]
        return id ? this.data.nodes[id] : undefined
    }

    /** Latest node belonging to a specific session (for same-session parent chain). */
    latestNodeForSession(sessionId: string): NodeRecord | undefined {
        for (let i = this.data.order.length - 1; i >= 0; i--) {
            const node = this.data.nodes[this.data.order[i]]
            if (node.sessionId === sessionId) return node
        }
        return undefined
    }

    /**
     * 本会话最近的**经验节点**（跳过 strategy_set/alt/note）。
     * 供 `proposeStrategySet` 定 set 的缺省父：新决策的根不应挂在另一个决策的候选下。
     */
    private lastExperienceForSession(sessionId: string): NodeRecord | undefined {
        const list = this.sessionNodes.get(sessionId) ?? []
        for (let i = list.length - 1; i >= 0; i--) {
            if (isExperience(list[i])) return list[i]
        }
        return undefined
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
        // §4.1 挂靠优先级：显式 parentId > 本会话 active alt > 最近节点（现状不变）。
        // 未传 parentId 且本会话已 pick 过分支时自动挂到该分支，使真实 outcome 累积到
        // 候选子树上（Wilson 打分的数据来源）；branchId 一并继承 active alt，
        // 否则 §2.5 的 descendantsOf 会漏掉该子树。
        const activeAlt = input.parentId ? null : this.resolveActiveAlt(input.sessionId)
        const parentId = input.parentId ?? activeAlt?.nodeId ?? this.latestNodeForSession(input.sessionId)?.nodeId
        const parent = parentId ? this.data.nodes[parentId] : undefined
        const branchId =
            input.branchId ??
            (activeAlt ? (activeAlt.branchId ?? activeAlt.nodeId) : parent ? (parent.branchId ?? parentId) : nodeId)
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
        }
        if (input.score !== undefined) node.score = input.score
        if (input.autoCreated) node.autoCreated = true
        if (input.type) node.type = input.type

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

    /** 本会话「当前在执行的分支」（§4.1）：从节点推导，零新增持久化。 */
    resolveActiveAlt(sessionId: string): NodeRecord | null {
        if (!sessionId) return null
        return resolveActiveAltPure(this.sessionNodes.get(sessionId) ?? [], sessionId)
    }

    /**
     * 批量补丁（§4.5）：`pickStrategy` 一次要改 3~N 个节点，必须同步 apply 全部
     * 后**单次** `persist()` —— 若各改各的（各自 `void persist()`），中断会留下
     * 0 个或 2 个 `chosen`，而代码里没有唯一性校验兜底。
     */
    batchPatch(patches: Array<[string, Partial<NodeRecord>]>): void {
        for (const [nodeId, patch] of patches) {
            const node = this.data.nodes[nodeId]
            if (!node) continue
            const oldKey = sessionKeyOf(node)
            Object.assign(node, patch)
            if (sessionKeyOf(node) !== oldKey) {
                this.sessionNodes.clear()
                for (const n of Object.values(this.data.nodes)) this.appendToSession(n)
                this.dirtySessions.add(oldKey)
            }
            this.dirtySessions.add(sessionKeyOf(node))
        }
        this.replayCache = null
        void this.persist()
    }

    /**
     * 派生的策略集元数据（§2.3「推导而非存储」）：**不落 index.json**，每次现算。
     *
     * 为什么不缓存：`patchNode` 不置 `indexDirty`（状态更新会静默丢），且
     * `rebuildFromSessions` 会丢弃 index 键 → 双源分叉。现算成本是 O(节点数)，
     * 与一次 search 同量级，而缓存需要在 `commit`/`patchNode` 两处挂失效钩子。
     */
    listSetMetas(): SetMeta[] {
        const metas: SetMeta[] = []
        for (const id of this.data.order) {
            const node = this.data.nodes[id]
            if (!node || !isStrategySet(node)) continue
            metas.push({
                setId: node.nodeId,
                problem: node.problem,
                altIds: node.altIds,
                altNames: node.altIds.map((altId) => this.data.nodes[altId]?.name ?? "").filter((n) => !!n),
                chosenAltId: node.chosenAltId,
            })
        }
        return metas
    }

    getAdviceLog(): AdviceRecord[] {
        return this.data.adviceLog
    }

    /** 追加一条建议/自动切换记录（§8）：FIFO 裁最旧，超上限不进工具返回。 */
    appendAdvice(record: AdviceRecord): void {
        this.data.adviceLog.push(record)
        if (this.data.adviceLog.length > ADVICE_LOG_MAX) {
            this.data.adviceLog.splice(0, this.data.adviceLog.length - ADVICE_LOG_MAX)
        }
        this.indexDirty = true
        void this.persist()
    }

    /**
     * status 末尾的策略库概览（§5.3）。
     * `chosen` 取全局最近一个 `chosen`（§4.2 每会话 ≤1，故不同会话可能各有 1 个）。
     */
    strategyOverview(): StrategyOverview {
        const sets = this.listSetMetas()
        let altCount = 0
        let chosen: StrategyOverview["chosen"] = null
        for (const id of this.data.order) {
            const node = this.data.nodes[id]
            if (!node || !isStrategyAlt(node)) continue
            altCount++
            if (node.status !== "chosen") continue
            const setNode = this.data.nodes[node.setId]
            chosen = {
                setId: node.setId,
                problem: (setNode && isStrategySet(setNode) ? setNode.problem : node.setId) as string,
                altName: node.name,
            }
        }
        const log = this.data.adviceLog
        const lastAdvice = log.length > 0 ? log[log.length - 1] : null
        let lastAutoSwitch: AdviceRecord | null = null
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].autoSwitched) {
                lastAutoSwitch = log[i]
                break
            }
        }
        return { setCount: sets.length, altCount, chosen, lastAdvice, lastAutoSwitch }
    }

    /** 新节点入内存（不落盘）：供多节点原子写入复用，调用方负责最终 persist。 */
    private addNode(node: NodeRecord): void {
        this.data.nodes[node.nodeId] = node
        this.data.order.push(node.nodeId)
        this.appendToSession(node)
        this.dirtySessions.add(sessionKeyOf(node))
    }

    /**
     * 入库一组候选（§5.1）：1 个 strategy_set + N 个 strategy_alt（全部 `unproven`）。
     *
     * 显式写 parentId/branchId 是**防劫持**（§5.1）：
     * - alt 的 `parentId` 固定为 `setId`，否则 `provisionalPick` 让某 alt 变 chosen 后
     *   创建的 alt#2 会挂到 alt#1 下 → `descendantsOf(alt1)` 吞掉 alt#2 子树 → Wilson 双算；
     * - alt 的 `branchId` = **自身 id**，否则 `commit` 的 `parent.branchId ?? parentId`
     *   会让同 set 的所有 alt 共享一个 branchId。
     */
    proposeStrategySet(input: {
        problem: string
        alts: AltCandidate[]
        provisionalPick?: string
        parentId?: string
        sessionId: string
        agentName?: string
    }): { setId: string; altIds: string[] } {
        const agentName = input.agentName ?? "unknown"
        const setId = "n-" + randomUUID().slice(0, 8)
        // set 的缺省父取本会话最近的**经验节点**（决策发生的上下文），跳过策略库节点 ——
        // 挂在另一个 set 的候选下会让两棵决策树形成父子从属，而两者语义上毫无关系。
        // 即便该经验节点位于某 alt 子树内，descendantsOf 已切断穿树（strategy.ts），双保险。
        const setParent = input.parentId ?? this.lastExperienceForSession(input.sessionId)?.nodeId
        const createdAt = nowIso()

        const setNode: NodeRecord = {
            nodeId: setId,
            projectId: this.data.projectId,
            sessionId: input.sessionId,
            agentName,
            parentId: setParent,
            branchId: setId,
            summary: input.problem.slice(0, 60),
            outcome: "partial",
            policyVersion: this.data.activePolicyId,
            files: [],
            turnIndex: this.data.nextTurnIndex++,
            createdAt,
            type: "strategy_set",
            problem: input.problem,
            altIds: [],
        }
        this.addNode(setNode)

        const altIds: string[] = []
        for (const alt of input.alts) {
            const altId = "n-" + randomUUID().slice(0, 8)
            const altNode: NodeRecord = {
                nodeId: altId,
                projectId: this.data.projectId,
                sessionId: input.sessionId,
                agentName,
                parentId: setId,
                branchId: altId,
                summary: `${alt.name}：${alt.approach}`.slice(0, 60),
                outcome: "partial",
                policyVersion: this.data.activePolicyId,
                files: [],
                turnIndex: this.data.nextTurnIndex++,
                createdAt,
                type: "strategy_alt",
                setId,
                name: alt.name,
                approach: alt.approach,
                tradeoffs: alt.tradeoffs,
                estimatedRisk: alt.estimatedRisk,
                status: "unproven",
            }
            this.addNode(altNode)
            altIds.push(altId)
        }
        setNode.altIds = altIds

        // 单次 persist：set 与全部 alt 一起落盘，不留半截候选组。
        this.replayCache = null
        void this.persist()

        if (input.provisionalPick) {
            this.pickStrategy({
                setId,
                altName: input.provisionalPick,
                reason: "propose 时选定的初始分支",
                sessionId: input.sessionId,
                agentName: input.agentName,
            })
        }
        return { setId, altIds }
    }

    /**
     * 切换当前分支（§3.4 / §4.2）：同时服务冷启动选型与手动换路，
     * dream 的全自动切换也复用这里（不变量自动保持）。
     *
     * 返回 `undefined` 的三种情况（工具层分别翻译中文）：
     * set 不存在 / altName 不属于该 set / 目标已 `rejected`（真实证伪）。
     *
     * 注意 `superseded` **允许**重新选中 —— 它只表示「让位给更优分支」而非证伪，
     * 子树 outcome 未变，重新启用不污染 §5.2 胜率；而 §4.8 的回滚路径正依赖这一点。
     */
    pickStrategy(input: {
        setId: string
        altName: string
        reason?: string
        verdict?: "superseded" | "rejected"
        /** 宿主会话 id；缺省时退化为「只让位同 set 内的 chosen」，且不写轨迹节点。 */
        sessionId?: string
        agentName?: string
    }): { previousAlt: string | null; currentAlt: string; note?: string } | undefined {
        const setNode = this.data.nodes[input.setId]
        if (!setNode || !isStrategySet(setNode)) return undefined

        const target = setNode.altIds
            .map((id) => this.data.nodes[id])
            .find((node): node is StrategyAltNode => !!node && isStrategyAlt(node) && node.name === input.altName)
        if (!target) return undefined

        // 幂等（对齐 setActivePolicy）：已在该分支直接成功，不重复写轨迹。
        if (target.status === "chosen") {
            return { previousAlt: null, currentAlt: target.name, note: "已在该分支" }
        }
        if (target.status === "rejected") return undefined

        // §4.2 不变量：先把**本会话**所有 chosen 让位（跨 set 也一并让位），
        // 使「每会话 ≤1 chosen」恒成立 → §4.1 的「最后一个 chosen」才无歧义。
        //
        // 让位范围 = **target 归属会话** ∪ **调用方会话**（并集）。只按 input.sessionId 过滤
        // 会漏掉 target 所属会话的旧 chosen：跨会话 pick（B 会话挑 A 会话 propose 的候选）时
        // A 的旧 chosen 不让位，A 就会同时落盘 2 个 chosen 且事后无人清理 —— 随后
        // resolveActiveAlt 按数组序取最后一个，可能把 commit 挂到用户并未确认的分支。
        const scope = new Set<string>()
        if (target.sessionId) scope.add(target.sessionId)
        if (input.sessionId) scope.add(input.sessionId)

        const patches: Array<[string, Partial<NodeRecord>]> = []
        let previousAlt: string | null = null
        for (const id of this.data.order) {
            const alt = this.data.nodes[id]
            if (!alt || !isStrategyAlt(alt)) continue
            if (alt.status !== "chosen" || alt.nodeId === target.nodeId) continue
            // scope 为空（节点缺 sessionId）→ 退化为只让位同 set 的 chosen，至少保住 set 内唯一
            const shouldYield = scope.size > 0 ? scope.has(alt.sessionId) : alt.setId === setNode.nodeId
            if (!shouldYield) continue
            previousAlt = alt.name
            patches.push([alt.nodeId, { status: input.verdict ?? "superseded" }])
        }
        patches.push([target.nodeId, { status: "chosen" }])
        patches.push([setNode.nodeId, { chosenAltId: target.nodeId }])
        this.batchPatch(patches)

        // §2.5 隐式轨迹节点：type=strategy_note，不进经验统计（§3.5）也不进 Wilson 子树。
        if (input.sessionId) {
            this.commit({
                sessionId: input.sessionId,
                agentName: input.agentName ?? "unknown",
                summary: `pick ${target.name}${input.reason ? `：${input.reason}` : ""}`.slice(0, 60),
                outcome: "partial",
                type: "strategy_note",
                parentId: setNode.nodeId,
                branchId: setNode.nodeId,
            })
        }
        return { previousAlt, currentAlt: target.name, note: input.reason ? `切换理由：${input.reason}` : undefined }
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

    patchPolicyMeta(
        policyId: string,
        meta: { replayAtCreation?: { train: number; valid: number | null }; provisional?: boolean },
    ): void {
        const policy = this.data.policies[policyId]
        if (!policy) return
        if (meta.replayAtCreation) policy.replayAtCreation = meta.replayAtCreation
        if (meta.provisional === true) policy.provisional = true
        if (meta.provisional === false) delete policy.provisional
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
                (parent ? `建议回滚：dream_rsi_memory_policy ${parent}` : "建议回滚到默认参数。")
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
    menuStats(opts: ReplayOptions): {
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
        opts: { minScore?: number; limit?: number; includeStrategySets?: boolean } = {},
    ): HitResult[] {
        if (visible.length === 0) return []
        // §3.5：策略库节点不套经验节点的打分公式——bm25/recency/successBoost 会把
        // set/alt 当成可复用经验，稀释浮点 replay 与检索候选。
        // set 的「决策入口」打分（§5.3）只在 search 需要；replay 必须整体排除 set ——
        // 一旦 set 进语料，computeIdf/avgLen 就会偏移，同一批经验在「库里有无策略节点」
        // 两种情况下的浮点 replay 数值不再相等（验收第 13 条），调参判断被非检索信号驱动。
        const strategySets = new Set<string>()
        const includeStrategySets = opts.includeStrategySets ?? false
        visible = visible.filter((node) => {
            if (isExperience(node)) return true
            if (includeStrategySets && isStrategySet(node)) {
                strategySets.add(node.nodeId)
                return true
            }
            return false
        })
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
            // §5.3：set 作为「决策入口」只按 problem 与 query 的语义相似度命中，
            // 不套经验节点的 bm25 / recency / successBoost 公式。
            if (strategySets.has(node.nodeId)) {
                const setScore = strategySetHitScore(node, queryTokens)
                if (setScore >= (opts.minScore ?? p.minScore)) {
                    results.push({ node, score: setScore, fileMatch: false, failureSimilar: false })
                }
                continue
            }
            const doc = docs[i]
            const bm25 = bm25Score(queryTokens, doc, idf, docTokenSize(doc), avgLen)
            const fts = bm25Normalized(bm25)
            const ov = fileOverlap(node.files, qFiles)
            const failureSimilar =
                node.outcome === "failed" &&
                (ov > 0 || tokenSimilarity(qErrorTokens, tokenizeText(node.errorMessage ?? "")) > FAILURE_SIM_THRESHOLD)
            const rec = recencyScore(nowTurn - node.turnIndex, p.recencyHalfLife)
            const score =
                rec * (p.fileOverlapWeight * ov + p.ftsScoreWeight * fts) +
                (node.outcome === "success" ? p.successBoost : 0) +
                (node.outcome === "failed" && failureSimilar ? p.failureBoost : 0)

            if (score < (opts.minScore ?? p.minScore)) continue
            results.push({ node, score, fileMatch: ov > 0, failureSimilar })
        }
        results.sort((a, b) => b.score - a.score)
        return results.slice(0, limit)
    }

    search(
        query: string,
        files: string[],
        opts: { limit?: number; minScore?: number; params?: RecallParams; log?: { trigger: QueryTrigger; turnIndex?: number | null } } = {},
    ): HitResult[] {
        const nodes = this.sortedNodes()
        const nowTurn = this.data.nextTurnIndex - 1
        const params = opts.params ?? this.activePolicy().params
        const results =
            nodes.length === 0
                ? []
                : this.scoreCandidates(nodes, query, files, params, nowTurn, {
                      limit: opts.limit,
                      minScore: opts.minScore,
                      includeStrategySets: true, // §5.3：检索时 set 作为决策入口可命中
                  })
        // P2：只有显式传 log 的用户面出口（tool/command/teaser）落盘；
        // status/menuStats 的 replay 打分与 dream 候选评估走 scoreCandidates，不经过这里。
        if (opts.log) {
            const ok = appendQueryLog(
                this.dir,
                {
                    ts: nowIso(),
                    turnIndex: opts.log.turnIndex ?? this.currentTurnIndex(),
                    query,
                    policyId: this.data.activePolicyId,
                    trigger: opts.log.trigger,
                    results: results.map((h, i) => ({ nodeId: h.node.nodeId, rank: i + 1, score: h.score })),
                },
                this.queryLogMax,
            )
            if (!ok) this.logger.debug("querylog append failed", { dir: this.dir })
        }
        return results
    }

    /** 最后一个已 commit 节点的 turnIndex；空库记 null。 */
    currentTurnIndex(): number | null {
        return this.data.order.length === 0 ? null : this.data.nextTurnIndex - 1
    }

    /** 项目数据目录（index.json 所在目录），querylog.jsonl 也在这里。 */
    getProjectDir(): string {
        return this.dir
    }

    /**
     * 在线战绩聚合（P2，仅供 status 展示与二期 P3a 消费；本版不做任何自动调参）：
     * - served：queryLog 中该策略服务过的查询数（按 policyId 聚合）；
     * - success/failed/partial：sessions 节点中 `policyVersion === policyId`
     *   （commit 时服务它的策略）的 outcome 计数。
     */
    onlineStats(policyId: string): { served: number; success: number; failed: number; partial: number } {
        let served = 0
        for (const entry of readQueryLog(this.dir)) {
            if (entry.policyId === policyId) served++
        }
        const counts = { success: 0, failed: 0, partial: 0 }
        for (const id of this.data.order) {
            const node = this.data.nodes[id]
            if (!node || !isExperience(node)) continue
            if (node.policyVersion !== policyId) continue
            if (node.outcome in counts) counts[node.outcome as keyof typeof counts]++
        }
        return { served, ...counts }
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
            adviceLog: this.data.adviceLog,
        }
    }

    /**
     * 等待所有已排队的持久化完成。
     * 测试同步点：`persist()` 走 `writeChain` 异步队列，测试若用固定 `setTimeout` 盲等，
     * 并行跑多文件时磁盘争用会让等待不足 → 读到未落盘的旧内容（flaky 根因）。
     */
    async flush(): Promise<void> {
        await this.writeChain
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
                    await cleanupStaleTmp(sessionsDir, this.logger)
                    await cleanupStaleTmp(dirname(indexFile), this.logger)
                    for (const [key, content] of partSnapshots) {
                        await atomicWrite(join(sessionsDir, sessionFileName(key)), content)
                    }
                }
                if (indexSnapshot !== null) {
                    await cleanupStaleTmp(dirname(indexFile), this.logger)
                    await atomicWrite(indexFile, indexSnapshot)
                }
            })
            .catch((error) => {
                this.logger.error("persist failed", { file: indexFile, error: String(error) })
            })
        return this.writeChain
    }
}
