import type { Plugin } from "@opencode-ai/plugin"
import { createLegacyClient, toV1Message, toV2Tool } from "./lib/v2-compat.js"
import type { Cleanup, V2Context, V2Plugin } from "./lib/v2-types.js"
import { toCleanup } from "./lib/v2-types.js"
import {
    createCommandExecuteHandler,
    createEventHandler,
    createMessagesTransformHandler,
    createSystemPromptHandler,
    createToolExecuteBeforeHandler,
} from "./lib/hooks.js"
import { createRuntime } from "./lib/runtime.js"
import { createV1Hooks } from "./lib/v1-host.js"

const DREAM_COMMAND_DESCRIPTION = "Dream-Memory：做梦引擎（status / run）"
const MEMORY_COMMAND_DESCRIPTION = "Dream-Memory：记忆库（stats / policy / show <nodeId>）"

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
const INJECTED_METADATA = { "dream-memory": true }

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

/** opencode 2.x：`setup(ctx)` 拿到 V2 域，注册工具 / 命令 / context 注入 / 事件流。 */
async function setup(ctx: V2Context): Promise<Cleanup | void> {
    const directory = ctx.location?.directory ?? ""
    // V2 没有 input.client，用兼容层把 ctx 包回 V1 形状，lib/ 下的代码一行不改。
    const client = createLegacyClient(ctx)
    const runtime = await createRuntime(directory, client)
    if (!runtime) return

    const { config, logger, store, gate, collector, rootPath, projectId, tools, meta } = runtime

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
}

/**
 * 双入口：2.x 调 `setup`，1.x 调 `server`（billion-context 同构）。
 * 1.x 与 2.x 共用同一套 store / tools / hooks，数据目录也共用。
 */
const plugin = {
    id: "dream-memory",
    setup,
    server: createV1Hooks,
} satisfies V2Plugin & { server: Plugin }

export default plugin
