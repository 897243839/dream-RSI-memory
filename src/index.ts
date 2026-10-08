import type { Cleanup, V2Context, V2Plugin } from "./lib/v2-types.js"
import { toCleanup } from "./lib/v2-types.js"
import { createLegacyClient, toV1Message, toV2Tool } from "./lib/v2-compat.js"
import { FileCollector } from "./lib/capture.js"
import { resolveConfig } from "./lib/config.js"
import {
    createCommandExecuteHandler,
    createEventHandler,
    createMessagesTransformHandler,
    createSystemPromptHandler,
    createToolExecuteBeforeHandler,
} from "./lib/hooks.js"
import { Logger } from "./lib/logger.js"
import { GateRegistry } from "./lib/menu.js"
import { MetaLlm } from "./lib/meta-llm.js"
import { MemoryStore } from "./lib/store.js"
import { createTools } from "./lib/tools.js"
import { isRootPath, projectIdOf } from "./lib/utils.js"
import { homedir } from "node:os"

const DREAM_COMMAND_DESCRIPTION = "Dream-RSI-Memory：做梦引擎（status / run）"
const MEMORY_COMMAND_DESCRIPTION = "Dream-RSI-Memory：记忆库（stats / policy / show <nodeId>）"

/**
 * hooks.ts 的 handler 是按 V1 宿主回调签名声明的（`TransformMessage` 是它文件内的私有
 * 类型、`Part` 来自 @opencode-ai/sdk）。兼容层产出的 `V1Part.type` 是 `string` 而非字面量，
 * 结构上不匹配但运行时是同一批数据，所以在调用点做一次显式收窄。
 */
type ContextHandler = NonNullable<ReturnType<typeof createMessagesTransformHandler>>
type CommandHandler = NonNullable<ReturnType<typeof createCommandExecuteHandler>>

/**
 * 注入标记：V2 的 TextPart 没有 V1 的 `synthetic` 字段，只能放 metadata，
 * 供以后排查时认出这段文本是插件注入的。
 */
const INJECTED_METADATA = { "dream-rsi-memory": true }

/** V2 context 事件里的消息 → V1 `{info, parts}`（hooks.ts 的 handler 只认这个形状）。 */
function toTransformMessage(
    message: Parameters<typeof toV1Message>[0],
    event: { sessionID: string; agent: string },
): { info: { role?: string; agent?: string; summary?: unknown; sessionID?: string; id?: string }; parts: NonNullable<ReturnType<typeof toV1Message>["parts"]> } {
    const mapped = toV1Message(message)
    const raw = message as { id?: string; role?: string; type?: string }
    return {
        info: {
            role: mapped.role,
            agent: event.agent,
            sessionID: event.sessionID,
            id: raw?.id ?? mapped.id,
            summary: mapped.summary,
        },
        parts: mapped.parts ?? [],
    }
}

const plugin: V2Plugin = {
    id: "dream-rsi-memory",
    async setup(ctx: V2Context): Promise<Cleanup | void> {
        const directory = ctx.location?.directory ?? ""
        const config = resolveConfig({ directory })
        if (!config.enabled) return

        const logger = new Logger(config.debug)
        let rootPath = directory
        if (!rootPath || isRootPath(rootPath)) {
            // Desktop opencode (GUI) can start without a real project cwd, passing
            // "/" or similar as the worktree. That is not a usable project root,
            // but skipping registration silently leaves the GUI with no tools.
            // Fall back to the user's home directory so the plugin still works.
            const home = homedir()
            logger.warn("invalid rootPath; falling back to home", { rootPath, home })
            rootPath = home
        }
        const projectId = projectIdOf(rootPath)
        const store = await MemoryStore.load(projectId, rootPath, config.dataDir, logger, {
            seedCount: config.dream.seedCount,
            seed: config.dream.seed,
            queryLogMax: config.queryLogMax,
        })
        logger.info("loaded", { projectId, nodes: store.count(), policy: store.activePolicy().policyId })

        const gate = new GateRegistry()
        const collector = new FileCollector()
        // V2 没有 input.client，用兼容层把 ctx 包回 V1 形状，lib/ 下的代码一行不改。
        const client = createLegacyClient(ctx)
        const meta = new MetaLlm(client, config, logger, directory)

        const tools = createTools({ client, store, config, logger, collector, meta })
        const eventHandler = createEventHandler(client, store, config, collector, logger)
        const commandHandler = createCommandExecuteHandler(client, store, config, { logger, meta, collector })
        const contextHandler = createMessagesTransformHandler(store, gate, config, collector)
        const systemHandler = createSystemPromptHandler(config)
        const toolBeforeHandler = createToolExecuteBeforeHandler(collector)

        const cleanups: Cleanup[] = []
        const keep = (registration: unknown): void => {
            const cleanup = toCleanup(registration)
            if (cleanup) cleanups.push(cleanup)
        }

        /* ---------------------------------------------------------------- tools */
        keep(
            await ctx.tool.transform((editor) => {
                for (const [name, definition] of Object.entries(tools)) {
                    editor.add(toV2Tool(name, definition, { directory, rootPath }))
                }
            }),
        )
        logger.info("tools registered", { count: Object.keys(tools).length })

        // V1 `tool.execute.before`：记下 edit/write 触碰的文件，供 commit/search 关联。
        if (toolBeforeHandler) {
            keep(
                await ctx.tool.hook("execute.before", (event) => {
                    void toolBeforeHandler(
                        { tool: event.tool, sessionID: event.sessionID, callID: event.id },
                        { args: event.input },
                    )
                }),
            )
        }

        /* ------------------------------------------------------------- commands */
        if (commandHandler) {
            keep(
                await ctx.command.transform((editor) => {
                    for (const [name, description] of [
                        ["dream", DREAM_COMMAND_DESCRIPTION],
                        ["memory", MEMORY_COMMAND_DESCRIPTION],
                    ] as const) {
                        editor.add({
                            name,
                            description,
                            // V2 的 command.execute 返回 void（promise/command.ts:13-21），
                            // 结果由 handler 自己经 session.synthetic({resume:false}) 投递。
                            execute: async ({ sessionID, prompt }) => {
                                await commandHandler(
                                    { command: name, sessionID, arguments: prompt },
                                    { parts: [] },
                                )
                            },
                        })
                    }
                }),
            )
        }

        /* ---------------------------------------------------- context (menu + system) */
        if (contextHandler || systemHandler) {
            keep(
                await ctx.session.hook("context", async (event) => {
                    const agent = typeof event.agent === "string" ? event.agent : String((event.agent as { name?: string })?.name ?? "")

                    if (systemHandler) {
                        const texts = (event.system ?? []).map((part) => part.text)
                        const before = texts.length
                        await systemHandler({}, { system: texts })
                        for (const text of texts.slice(before)) {
                            event.system.push({ type: "text", text })
                        }
                    }

                    if (!contextHandler || !event.messages?.length) return

                    const originalCounts = event.messages.map((message) => (message.content ?? []).length)
                    const wrapped = event.messages.map((message) => toTransformMessage(message, { sessionID: event.sessionID, agent }))
                    const messages = wrapped as unknown as Parameters<ContextHandler>[1]["messages"]
                    await contextHandler({}, { messages })

                    // handler 只会往 parts 里 push，把新增的部分映射回 V2 content。
                    for (let i = 0; i < event.messages.length; i++) {
                        const added = (wrapped[i].parts ?? []).slice(originalCounts[i])
                        for (const part of added) {
                            if (part.type === "text" && part.text) {
                                event.messages[i].content.push({ type: "text", text: part.text, metadata: INJECTED_METADATA })
                            }
                        }
                    }
                }),
            )
        }

        /* --------------------------------------------------------------- events */
        // V1 是宿主逐个回调 `event` hook；V2 要自己拉流。
        const abort = new AbortController()
        let streaming = true
        void (async () => {
            if (!eventHandler) return
            try {
                for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
                    if (!streaming) break
                    const type = typeof event.type === "string" ? event.type : ""
                    if (!type) continue
                    await eventHandler({
                        event: { type, properties: (event.data ?? {}) as { sessionID?: string } },
                    })
                }
            } catch (error) {
                if (streaming) logger.error("event stream failed", { error: String(error) })
            }
        })()
        cleanups.push(() => {
            streaming = false
            abort.abort()
        })

        logger.info("ready", { rootPath, projectId })
        return async () => {
            for (const cleanup of cleanups.splice(0).reverse()) {
                try {
                    await cleanup()
                } catch (error) {
                    logger.error("cleanup failed", { error: String(error) })
                }
            }
        }
    },
}

export default plugin
