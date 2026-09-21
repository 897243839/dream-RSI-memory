import type { Part, UserMessage } from "@opencode-ai/sdk"
import { captureTurn, extractNodeFields, type FileCollector } from "./capture.js"
import { runDream } from "./dream.js"
import type { Logger } from "./logger.js"
import type { GateRegistry } from "./menu.js"
import type { MetaLlm } from "./meta-llm.js"
import { renderMenuText } from "./prompts.js"
import { dreamHelpText, nodeDetailText, policyListText, replayOptsOf, statusText } from "./report.js"
import type { MemoryStore } from "./store.js"
import type { MemoryConfig } from "./types.js"
import { normalizeProjectPath, truncate } from "./utils.js"

const INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"])

interface TransformMessage {
    info: { role?: string; agent?: string; summary?: unknown; sessionID?: string; id?: string }
    parts: (Partial<Part> & { type?: string })[]
}

export interface DreamDeps {
    logger: Logger
    meta?: MetaLlm
}

function isInternalAgentRequest(messages: TransformMessage[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i].info
        if (info?.role === "user" && info.agent && INTERNAL_AGENT_NAMES.has(info.agent)) return true
    }
    return false
}

function sessionIDOf(messages: TransformMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const sid = messages[i].info?.sessionID
        if (sid) return sid
    }
    return ""
}

function lastUserIndex(messages: TransformMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info?.role === "user") return i
    }
    return -1
}

function systemHelp(): string {
    return [
        "[dream-memory] 长期记忆工具（按需调用，非每回合必须）",
        "开工前若怀疑过去做过类似任务，可用 dream_memory_search 检索历史经验；回合中产生了值得复用的结论或踩坑时，用 dream_memory_commit 记录一条；当记忆节点足够多（≥20）时可 dream_memory_dream 让检索策略自我进化。所有动作都会在合适时机由列表提示，跟不跟着做均可。",
    ].join("\n")
}

export function createSystemPromptHandler(config: MemoryConfig): ((input: unknown, output: { system: string[] }) => Promise<void>) | undefined {
    if (!config.enabled || !config.menu.enabled) return undefined
    return async (_input, output) => {
        const marker = "[dream-memory]"
        if (output.system.some((s) => s.includes(marker))) return
        output.system.push(systemHelp())
    }
}

/**
 * Lightweight teaser: search the last user message against the whole store and,
 * if the top hit comes from a *different* session, emit a one-line hint so the
 * model sees the promised "命中历史" trigger and follows up with dream_memory_search.
 * Same-session nodes are skipped: reminding the model of its own recent work is noise.
 */
function teaserFor(store: MemoryStore, queryText: string, files: string[], sessionID: string): string {
    const query = queryText.trim()
    if (!query || store.count() === 0) return ""
    const hit = store
        .search(query, files, { limit: 5 })
        .find((h) => h.node.sessionId !== sessionID)
    if (!hit) return ""
    const tag = hit.node.outcome === "failed" ? "（踩坑）" : hit.node.outcome === "success" ? "（成功）" : ""
    return `${hit.node.nodeId} “${truncate(hit.node.summary || "（无摘要）", 48)}”${tag}`
}

export function createMessagesTransformHandler(
    store: MemoryStore,
    gate: GateRegistry,
    config: MemoryConfig,
    collector: FileCollector,
): ((input: {}, output: { messages: TransformMessage[] }) => Promise<void>) | undefined {
    if (!config.enabled || !config.menu.enabled) return undefined
    return async (_input, output) => {
        const messages = output.messages
        if (messages.length === 0) return
        if (isInternalAgentRequest(messages)) return
        const sessionID = sessionIDOf(messages)
        if (!sessionID) return
        const idx = lastUserIndex(messages)
        if (idx < 0) return

        gate.noteUserTurn(sessionID)

        const stats = store.menuStats(replayOptsOf(config))
        if (!gate.shouldInject(sessionID, stats.nodeCount, config.menu)) return

        const lastMessage = messages[idx]
        const queryText = (lastMessage.parts ?? [])
            .map((p) => p as { type?: string; text?: string })
            .filter((p) => p.type === "text" && !!p.text)
            .map((p) => p.text as string)
            .join("\n")
        const teaser = teaserFor(store, queryText, collector.peek(sessionID), sessionID)
        const title = renderMenuText({
            nodeCount: stats.nodeCount,
            policyId: stats.policyId,
            replayTrain: stats.replayTrain,
            minNodes: config.dream.minNodes,
            maxTokensHint: config.menu.maxTokensHint,
            teaser,
        })
        const userInfo = lastMessage.info as UserMessage
        const part: Part = {
            id: "dream-menu-" + Date.now().toString(36),
            sessionID,
            messageID: userInfo.id,
            type: "text",
            text: title,
            synthetic: true,
        }
        messages[idx].parts.push(part)
        gate.markInjected(sessionID, stats.nodeCount)
    }
}

async function sendIgnoredMessage(client: unknown, sessionID: string, text: string, logger: Logger): Promise<void> {
    try {
        const clientAny = client as {
            session: { prompt(options: unknown): Promise<unknown> }
        }
        await clientAny.session.prompt({
            path: { id: sessionID },
            body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
        })
    } catch (error) {
        logger.error("send command output failed", { error: String(error) })
    }
}

export function createCommandExecuteHandler(
    client: unknown,
    store: MemoryStore,
    config: MemoryConfig,
    deps: DreamDeps & { collector: FileCollector },
): ((input: { command: string; sessionID: string; arguments: string }, output: { parts: Part[] }) => Promise<void>) | undefined {
    if (!config.enabled) return undefined
    return async (input, _output) => {
        const { command, sessionID, arguments: args } = input
        if (command !== "dream" && command !== "memory") return
        const argv = (args ?? "").trim().split(/\s+/).filter(Boolean)

        let text = ""
        try {
            if (command === "dream") {
                const sub = argv[0] ?? "status"
                if (sub === "status") text = statusText(store, config)
                else if (sub === "run") text = (await runDream(store, config, deps)).text
                else text = dreamHelpText()
            } else {
                const sub = argv[0] ?? "stats"
                if (sub === "stats") text = statusText(store, config)
                else if (sub === "policy") text = policyListText(store)
                else if (sub === "show" && argv[1]) text = nodeDetailText(store, argv[1])
                else if (sub === "show") text = "[dream-memory] 用法：/memory show <nodeId>"
                else text = dreamHelpText()
            }
        } catch (error) {
            text = "[dream-memory] 命令执行失败：" + String(error)
        }
        await sendIgnoredMessage(client, sessionID, text, deps.logger)
    }
}

export function createEventHandler(
    client: unknown,
    store: MemoryStore,
    config: MemoryConfig,
    collector: FileCollector,
    logger: Logger,
): ((input: { event: unknown }) => Promise<void>) | undefined {
    return async (input) => {
        const event = input.event as { type?: string; properties?: { sessionID?: string } } | null
        if (!event?.type) return
        if (event.type !== "session.idle") {
            if (config.debug) logger.debug("event", { type: event.type })
            return
        }

        // session.idle → fallback auto-commit (learned from evomap-opencode-plugin):
        // if a session touched files but never recorded a trace, capture the tail
        // of the last turn and commit a partial node so the experience is not lost.
        if (config.enabled && config.autoCommitOnIdle !== false) {
            const sessionID = event.properties?.sessionID
            if (!sessionID || !collector.has(sessionID)) return
            const last = store.lastNodeCommittedAtMs(sessionID)
            if (last !== null && Date.now() - last < config.autoCommitIdleGapMs) return
            try {
                const material = await captureTurn(client, sessionID, config.capture.maxMaterialChars)
                const extracted = extractNodeFields(material)
                if (!extracted.summary || extracted.summary === "（无内容）") return
                const node = store.commit({
                    summary: "auto(idle) " + extracted.summary,
                    outcome: extracted.outcome,
                    why: extracted.why,
                    errorMessage: extracted.errorMessage,
                    files: collector
                        .take(sessionID)
                        .map((f) => normalizeProjectPath(store.getRootPath(), f))
                        .filter((f): f is string => !!f),
                    sessionId: sessionID,
                    agentName: "idle",
                    autoCreated: true,
                })
                logger.info("idle auto-commit", { nodeId: node.nodeId, files: node.files.length })
            } catch (error) {
                logger.error("idle auto-commit failed", { error: String(error) })
            }
        }
    }
}

export function createToolExecuteBeforeHandler(collector: FileCollector): ((input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) => Promise<void>) | undefined {
    return async (input, output) => {
        if ((input.tool === "edit" || input.tool === "write") && output.args) {
            const args = output.args as { filePath?: unknown; file?: unknown }
            const file = typeof args.filePath === "string" ? args.filePath : typeof args.file === "string" ? args.file : undefined
            if (file) collector.add(input.sessionID, file)
        }
    }
}