/**
 * opencode 1.x（V1 插件宿主）适配层。
 *
 * V2 侧把 `ctx` 包成 V1 形状 client（见 v2-compat.ts）；这里反过来：V1 宿主本来
 * 就提供一个 V1 形状的 `input.client`，但有两点与 lib/ 内部期望的形状不同：
 *   1. `session.messages()` 返回 `{data: [{info, parts}]}`（info 里才是 role/time），
 *      lib/capture.ts 与 lib/meta-llm.ts 读的是平铺的 `{role, parts}`；
 *   2. V1 的 `session.create` 不接受 model，模型必须在 `session.prompt` 上带，
 *      而 meta-llm 是在 create 时给 model。
 * 这两点只在这里归一，lib/ 下的代码一行不改（与 V2 侧同一套 handler/tools/store）。
 *
 * 命令：1.x 不能用 `command.execute.before`（该 hook 抛错会让命令 HTTP 500，2.0.0
 * 的实测根因），改为经 `hooks.config` 注册**非空命令模板**，由模型按模板调工具。
 */
import type { Config, Hooks, PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import { createEventHandler, createMessagesTransformHandler, createSystemPromptHandler, createToolExecuteBeforeHandler } from "./hooks.js"
import { createRuntime } from "./runtime.js"
import type { LegacyClient } from "./v2-compat.js"

const DREAM_COMMAND_DESCRIPTION = "Dream-Memory：做梦引擎（status / run）"
const MEMORY_COMMAND_DESCRIPTION = "Dream-Memory：记忆库（stats / policy / show <nodeId>）"

/** 无参 / `status` → 状态；`run` → 做梦。`$ARGUMENTS` 由宿主替换成用户输入。 */
export const DREAM_COMMAND_TEMPLATE = `Dream-Memory 做梦引擎。用户参数（$ARGUMENTS）：

- 参数为空或为 status：先调用工具 dream_rsi_memory_status，再把返回内容整理成一段中文简报。
- 参数为 run：先调用工具 dream_rsi_memory_dream，再把返回内容整理成一段中文简报。
- 其它参数：先调用工具 dream_rsi_memory_status，并提示可用参数为 status / run。

必须先真正调用工具，再根据工具输出回答；不要凭猜测编造记忆库状态。`

/** `stats` → 状态；`policy [<id>]` → 列策略 / 切换策略；`show <nodeId>` → 节点详情。 */
export const MEMORY_COMMAND_TEMPLATE = `Dream-Memory 记忆库。用户参数（$ARGUMENTS）：

- 参数为空或为 stats：先调用工具 dream_rsi_memory_status，再整理成中文简报。
- 参数以 policy 开头：调用工具 dream_rsi_memory_policy；给出了策略 id 就带上 policy_id。
- 参数以 show 开头：取出后面的节点 id，调用工具 dream_rsi_memory_node（参数 node_id）。
- 其它参数：调用工具 dream_rsi_memory_status 并提示可用子命令 stats / policy / show。

必须先真正调用工具，再根据工具输出回答；不要凭猜测编造记忆库内容。`

/** 别名，方便测试与外部引用。 */
export const COMMAND_TEMPLATES = { dream: DREAM_COMMAND_TEMPLATE, memory: MEMORY_COMMAND_TEMPLATE } as const

interface V1MessagesResult {
    data?: Array<{
        info?: { id?: string; role?: string; summary?: unknown; time?: { created?: number } }
        parts?: unknown[]
    }>
}

/** V1 宿主 `input.client` 里被本插件用到的四个方法（形状来自 @opencode-ai/sdk gen）。 */
interface V1HostClient {
    session: {
        messages(options: unknown): Promise<V1MessagesResult>
        create(options: unknown): Promise<{ data?: { id?: string } }>
        delete(options: unknown): Promise<unknown>
        prompt(options: unknown): Promise<unknown>
    }
}

/**
 * 真 V1 client → lib/ 期望的形状。
 *
 * `models` 记录 create 时给的模型，在随后的 prompt 上补回（V1 只认 prompt 上的 model）。
 * 这样 meta-llm 的隐藏 curator 会话在 1.x 也能落到配置的模型上；未配置时留空，
 * 由宿主使用当前会话已选模型。
 */
export function createV1Client(client: V1HostClient): LegacyClient {
    const models = new Map<string, unknown>()
    return {
        session: {
            async messages(options?: unknown) {
                const id = (options as { path?: { id?: string } } | undefined)?.path?.id ?? ""
                const result = await client.session.messages({ path: { id } })
                const list = Array.isArray(result?.data) ? result.data : []
                return {
                    data: list.map((entry) => ({
                        id: entry?.info?.id,
                        role: entry?.info?.role ?? "",
                        summary: entry?.info?.summary === true ? true : undefined,
                        time: entry?.info?.time,
                        parts: Array.isArray(entry?.parts) ? entry.parts : [],
                    })),
                }
            },
            async create(options?: unknown) {
                const opts = options as { body?: { title?: string; model?: unknown }; query?: { directory?: string } } | undefined
                const result = await client.session.create({
                    body: { title: opts?.body?.title },
                    query: opts?.query,
                })
                const id = result?.data?.id
                if (id && opts?.body?.model) models.set(id, opts.body.model)
                return { data: id ? { id } : undefined }
            },
            async delete(options?: unknown) {
                const id = (options as { path?: { id?: string } } | undefined)?.path?.id ?? ""
                return client.session.delete({ path: { id } })
            },
            async prompt(options?: unknown) {
                const opts = options as {
                    path?: { id?: string }
                    sessionID?: string
                    body?: { noReply?: boolean; parts?: unknown[]; model?: unknown }
                } | undefined
                const id = opts?.path?.id ?? opts?.sessionID ?? ""
                const body = opts?.body ?? {}
                const model = body.model ?? models.get(id)
                return client.session.prompt({
                    path: { id },
                    body: {
                        parts: Array.isArray(body.parts) ? body.parts : [],
                        ...(model ? { model } : {}),
                        ...(body.noReply === true ? { noReply: true } : {}),
                    },
                })
            },
        },
    }
}

/**
 * V1 入口。返回的 hooks 尽量惰性：某个 seam 缺失时只是关掉那项能力，绝不抛错。
 */
export async function createV1Hooks(input: PluginInput): Promise<Hooks> {
    const client = createV1Client(input.client as unknown as V1HostClient)
    const directory = input.directory || input.worktree || ""
    const runtime = await createRuntime(directory, client)
    if (!runtime) return {}

    const { config, logger, store, gate, collector, rootPath, projectId, tools } = runtime

    const hooks: Hooks = {
        // V1 宿主在启动时静态读取这张表；args 直接用真实的 zod raw shape，不要再包一层。
        tool: tools as Record<string, ToolDefinition>,
        config: async (value: Config) => {
            const commands = { ...(value.command ?? {}) }
            commands.dream = { template: DREAM_COMMAND_TEMPLATE, description: DREAM_COMMAND_DESCRIPTION }
            commands.memory = { template: MEMORY_COMMAND_TEMPLATE, description: MEMORY_COMMAND_DESCRIPTION }
            value.command = commands
        },
    }

    const toolBeforeHandler = createToolExecuteBeforeHandler(collector)
    if (toolBeforeHandler) {
        hooks["tool.execute.before"] = (event, output) =>
            toolBeforeHandler({ tool: event.tool, sessionID: event.sessionID, callID: event.callID }, output)
    }

    const systemHandler = createSystemPromptHandler(config)
    if (systemHandler) {
        hooks["experimental.chat.system.transform"] = (event, output) => systemHandler(event, output)
    }

    const messagesHandler = createMessagesTransformHandler(store, gate, config, collector)
    if (messagesHandler) {
        hooks["experimental.chat.messages.transform"] = (event, output) => messagesHandler(event, output)
    }

    const eventHandler = createEventHandler(client, store, config, collector, logger)
    if (eventHandler) {
        hooks.event = (event) => eventHandler({ event: event.event })
    }

    logger.info("v1 hooks ready", {
        rootPath,
        projectId,
        tools: Object.keys(tools).length,
        commands: Object.keys(COMMAND_TEMPLATES),
    })
    return hooks
}
