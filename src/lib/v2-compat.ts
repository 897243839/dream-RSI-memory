/**
 * V1 ⇄ V2 兼容层（opencode 2.0.24）。
 *
 * 目的：`src/lib/{capture,meta-llm,hooks,tools}.ts` 里所有交互都走 V1 的
 * `input.client` 形状（`session.messages({path})` → `{data}`、`session.prompt({path, body})`
 * 等）。这些代码有 10 个单测在守，重写它们的收益低于风险，所以把差异全部收敛到
 * 这一个文件：V2 `ctx` 在这里被包成一个 V1 形状的 client，工具定义也在这里转成 V2 形状。
 *
 * V1 → V2 的语义映射（出处见 v2-types.ts 头部注释）：
 *   session.messages({path:{id}})   → session.context({sessionID})   （V2 无 messages）
 *   session.create({body, query})   → session.create({title, location})
 *   session.delete({path:{id}})     → session.remove({sessionID})
 *   session.prompt({noReply:true})  → session.synthetic({resume:false})  ← V1 noReply 等价
 *   session.prompt({body:{parts}})  → session.prompt({sessionID, text})
 *   工具 execute 返回 string        → { content: string }
 */
import { tool } from "@opencode-ai/plugin"
import type { V2ContentPart, V2Context, V2Message, V2ToolContext, V2ToolDefinition, V2ToolResult } from "./v2-types.js"

/** V1 client 里被真实用到的四个方法（capture.ts / meta-llm.ts / hooks.ts）。 */
export interface LegacyClient {
    session: {
        messages(options?: unknown): Promise<{ data?: unknown[] }>
        create(options?: unknown): Promise<{ data?: { id: string } }>
        delete(options?: unknown): Promise<unknown>
        prompt(options?: unknown): Promise<unknown>
    }
}

interface V1Part {
    type: string
    text?: string
    tool?: string
    state?: { status?: string }
}

interface V1Message {
    id?: string
    role: string
    summary?: boolean
    time?: { created?: number }
    parts?: V1Part[]
}

function textOfParts(parts: unknown): string {
    if (!Array.isArray(parts)) return ""
    return parts
        .map((part) => (part as { text?: unknown })?.text)
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join("\n")
}

/** V2 ContentPart → V1 Part。reasoning/file 等 V1 侧本来就不读，直接丢弃。 */
function toV1Part(part: unknown): V1Part | null {
    const p = part as { type?: string; text?: string; name?: string; tool?: string; state?: { status?: string } } | null
    if (!p || typeof p.type !== "string") return null
    if (p.type === "text") return { type: "text", text: typeof p.text === "string" ? p.text : "" }
    if (p.type === "tool") {
        const name = typeof p.name === "string" ? p.name : typeof p.tool === "string" ? p.tool : ""
        if (!name) return null
        return { type: "tool", tool: name, state: { status: p.state?.status } }
    }
    return null
}

/**
 * V2 平铺消息（`type` + `text`/`content`）→ V1 消息（`role` + `parts`）。
 *
 * - user：`{type:"user", text}`（types.ts:1756-1765）
 * - assistant：`{type:"assistant", content:[{type:"text"|"tool"|...}]}`（:2275-2291）
 * - 其它（compaction 等）：标 `summary:true`，V1 的 capture/meta 会跳过
 *
 * 工具失败检测靠 `content` 里的 `{type:"tool", state:{status:"error"}}`（:1790-1796），
 * 这里映射成 V1 的 `part.state.status`，`extractNodeFields` 的判定逻辑无需改动。
 */
export function toV1Message(message: unknown): V1Message {
    const m = message as {
        id?: string
        type?: string
        role?: string
        time?: { created?: number }
        text?: string
        content?: unknown[]
    } | null
    const type = m?.type ?? m?.role ?? ""
    const base: V1Message = { id: m?.id, role: type === "user" || type === "assistant" ? type : "system", time: normalizeTime(m?.time) }

    if (type === "user") {
        const parts = Array.isArray(m?.content)
            ? m.content.map(toV1Part).filter((part): part is V1Part => part !== null)
            : [{ type: "text", text: typeof m?.text === "string" ? m.text : "" }]
        return { ...base, role: "user", parts }
    }
    if (type === "assistant") {
        const parts = Array.isArray(m?.content)
            ? m.content.map(toV1Part).filter((part): part is V1Part => part !== null)
            : []
        return { ...base, role: "assistant", parts }
    }
    return { ...base, summary: true, parts: [] }
}

export function toV1Messages(messages: unknown): V1Message[] {
    if (!Array.isArray(messages)) return []
    return messages.map(toV1Message)
}

/** V2 的 session 实现不保证返回 `{id}`，这里做一次容错读取。 */
function idOfSession(created: unknown): string | undefined {
    if (typeof created === "string") return created
    const s = created as { id?: unknown; sessionID?: unknown } | null
    if (s && typeof s.id === "string") return s.id
    if (s && typeof s.sessionID === "string") return s.sessionID
    return undefined
}

/**
 * V1 用 `prompt({body:{model:{providerID, modelID}}})` 逐条指定模型；V2 `session.prompt`
 * 已经没有 model 字段，只能在 `session.create` 上给，而且类型是 `ModelRef`
 * `{providerID, id, variant?}`（client generated types.ts:19、:3003）—— 字段名从
 * `modelID` 换成了 `id`。不转换会把 `modelID` 当未知字段丢掉，隐藏会话就跑不到
 * 指定模型上（meta-llm 的 curator 需要它）。
 */
function normalizeModel(model: unknown): unknown {
    if (!model || typeof model !== "object") return model
    const m = model as { providerID?: unknown; modelID?: unknown; id?: unknown; variant?: unknown }
    if (typeof m.providerID === "string" && typeof m.modelID === "string") {
        const ref: { providerID: string; id: string; variant?: string } = {
            providerID: m.providerID,
            id: m.modelID,
        }
        if (typeof m.variant === "string") ref.variant = m.variant
        return ref
    }
    return model
}

/**
 * `time.created` 单位容错：V1 是毫秒，V2 若改用秒，meta-llm 的
 * `created >= sentAt`（`Date.now()` 是毫秒）会永远为假、每轮都等到超时。
 * 毫秒时间戳约 1.7e12、秒约 1.7e9，1e12 是安全分界。
 */
function normalizeTime(time: unknown): { created?: number } | undefined {
    const t = time as { created?: unknown } | null | undefined
    if (!t || typeof t.created !== "number" || t.created >= 1e12) {
        return time as { created?: number } | undefined
    }
    return { ...t, created: Math.round(t.created * 1000) } as { created?: number }
}

/** 把 V1 `body` 压成一段纯文本（V2 prompt/synthetic 只收 `text`）。 */
function textOfPromptBody(body: unknown): string {
    const b = body as { parts?: unknown; text?: unknown } | null | undefined
    if (Array.isArray(b?.parts)) return textOfParts(b.parts)
    return typeof b?.text === "string" ? b.text : ""
}

/**
 * 用 V2 `ctx` 造一个 V1 形状的 client。
 *
 * 注意 `prompt`：
 * - V1 的 `noReply:true`（命令输出）在 V2 对应 `synthetic({resume:false})` —— 只落一条
 *   可见消息、不唤醒模型（core/session/session.ts:273-313：`if (input.resume !== false) wake()`）。
 * - V1 `body.model` 这里**直接丢弃**：V2 `session.prompt` 没有 model 字段，模型在
 *   `session.create` 时确定（见 `normalizeModel`），meta-llm 的临时会话在创建时指定。
 * - V2 `session.prompt` 发完即返回（不等生成，core/session/session.ts:145-175），
 *   所以 meta-llm 现有的 `context()` 轮询逻辑原样可用。
 */
export function createLegacyClient(ctx: V2Context): LegacyClient {
    return {
        session: {
            async messages(options?: unknown) {
                const sessionID = (options as { path?: { id?: string } } | undefined)?.path?.id ?? ""
                const raw = await ctx.session.context({ sessionID })
                return { data: toV1Messages(raw) }
            },
            async create(options?: unknown) {
                const opts = options as { body?: { title?: string; model?: unknown }; query?: { directory?: string } } | undefined
                const created = await ctx.session.create({
                    title: opts?.body?.title,
                    model: normalizeModel(opts?.body?.model),
                    location: opts?.query?.directory,
                })
                const id = idOfSession(created)
                return { data: id ? { id } : undefined }
            },
            async delete(options?: unknown) {
                const sessionID = (options as { path?: { id?: string } } | undefined)?.path?.id ?? ""
                return ctx.session.remove({ sessionID })
            },
            async prompt(options?: unknown) {
                const opts = options as { path?: { id?: string }; sessionID?: string; body?: unknown } | undefined
                const sessionID = opts?.path?.id ?? opts?.sessionID ?? ""
                const body = (opts?.body ?? {}) as { noReply?: boolean; metadata?: Record<string, unknown> }
                const text = textOfPromptBody(opts?.body)
                if (body.noReply === true) {
                    return ctx.session.synthetic({ sessionID, text, resume: false, metadata: body.metadata })
                }
                return ctx.session.prompt({ sessionID, text, metadata: body.metadata })
            },
        },
    }
}

/** V1 `ToolResult`（string 或 `{output}`）→ V2 `{content}`（schema/tool.ts:86-90）。 */
export function toV2Result(result: unknown): V2ToolResult {
    if (typeof result === "string") return { content: result }
    if (result && typeof result === "object") {
        const r = result as { output?: unknown; metadata?: unknown }
        if (typeof r.output === "string") {
            return r.metadata ? { content: r.output, metadata: r.metadata } : { content: r.output }
        }
        return { content: JSON.stringify(r) }
    }
    return { content: String(result) }
}

/**
 * V1 工具定义（`{description, args, execute}`）→ V2 `add()` 入参。
 *
 * - `input`：V1 的 zod raw shape 包成 `z.object`（V2 `ValueSchema` 收 StandardSchema）
 * - `execute` 第二参：V2 给的是 `{sessionID, agent, messageID, id, signal, progress}`，
 *   V1 需要 `{sessionID, messageID, agent, directory, worktree, abort, metadata, ask}`
 *   （见 @opencode-ai/plugin dist/tool.d.ts:2-24），这里补齐。
 * - `worktree`：V2 没有 worktree 概念，用 `ctx.location.directory`（scout 结论）。
 */
export function toV2Tool(
    name: string,
    definition: { description: string; args: Record<string, unknown>; execute: (args: never, context: never) => Promise<unknown> },
    project: { directory: string; rootPath: string },
): V2ToolDefinition {
    return {
        name,
        description: definition.description,
        input: tool.schema.object(definition.args),
        execute: async (input, ctx: V2ToolContext) => {
            const legacyContext = {
                sessionID: ctx?.sessionID ?? "",
                messageID: ctx?.messageID ?? "",
                agent: ctx?.agent ?? "",
                directory: project.directory,
                worktree: project.rootPath,
                abort: ctx?.signal ?? new AbortController().signal,
                metadata: () => undefined,
                ask: async () => {
                    throw new Error(`[dream-memory] ${name}: ask() 在 opencode 2.x 插件里不可用`)
                },
            }
            const result = await (
                definition.execute as (args: unknown, context: unknown) => Promise<unknown>
            )(input, legacyContext)
            return toV2Result(result)
        },
    }
}

/** 供 index.ts 复用：V2 context event 的消息 → V1 `{info, parts}` 需要的 role 列表。 */
export function rolesOf(messages: readonly V2Message[]): string[] {
    return messages.map((message) => message?.role ?? "")
}

/** 取某个 V2 消息的纯文本（菜单注入时定位最后一条 user 消息用）。 */
export function textOfMessage(message: V2Message): string {
    return (message?.content ?? [])
        .map((part: V2ContentPart) => (part?.type === "text" ? String(part.text ?? "") : ""))
        .filter(Boolean)
        .join("\n")
}
