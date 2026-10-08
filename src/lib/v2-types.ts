/**
 * Hand-written type surface for the opencode **2.0.24 V2 plugin API**.
 *
 * 为什么手写：npm 上的 `@opencode-ai/plugin`（1.18.31 → 1.18.35）只类型化了 9 个域
 * （agent / aisdk / catalog / command / integration / plugin / reference / skill），
 * 而 2.0.24 运行时 `setup(ctx)` 实际注入 26 个域，`session` / `tool` / `event` /
 * `permission` 全都没有类型。按运行时用到的成员写窄接口，出处标到文件:行。
 *
 * 引用仓库：github.com/anomalyco/opencode @ tag v2.0.24
 *   - packages/plugin/src/promise/plugin.ts:26-61      Context / Plugin / Cleanup
 *   - packages/plugin/src/promise/tool.ts:11-72         ToolContext / ToolEditor / ToolDomain
 *   - packages/plugin/src/promise/command.ts:7-21       command.add / Invocation
 *   - packages/plugin/src/promise/session.ts:25-36      SessionContext（hook "context" 事件）
 *     packages/plugin/src/promise/session.ts:14-20      hook "prompt" 事件
 *     packages/plugin/src/promise/session.ts:153-172    SessionDomain 成员表
 *   - packages/plugin/src/promise/event.ts:1-3          EventDomain = Pick<EventApi, "subscribe">
 *   - packages/plugin/src/promise/permission.ts:7-24    permission.hook("evaluate")
 *   - packages/schema/src/tool.ts:14-20                 Tool.Context（sessionID/agent/messageID/id）
 *     packages/schema/src/tool.ts:44,86-90              ValueSchema / Result
 *   - packages/schema/src/location.ts:19-27             Location.Info
 *   - packages/ai/src/schema/messages.ts:18-45,236-243  Message / ContentPart / SystemPart / TextPart
 *
 * 运行时另有一个兜底：本文件的形状若有出入，`v2-compat.ts` 里的读取都是容错式
 * （`msg.type ?? msg.role` 之类），不会因为单个字段名差异直接崩。
 */

export type Cleanup = () => Promise<void> | void

/* ------------------------------------------------------------------ tool */

/** schema/tool.ts:14-20 + promise/tool.ts:11-14 —— 工具 execute 的第二参。 */
export interface V2ToolContext {
    readonly sessionID: string
    readonly agent: string
    readonly messageID: string
    readonly id: string
    readonly signal?: AbortSignal
    readonly progress?: (metadata: unknown) => Promise<void>
}

/** schema/tool.ts:86-90 —— `content` 可直接是字符串。 */
export interface V2ToolResult {
    readonly content?: string | ReadonlyArray<unknown>
    readonly output?: unknown
    readonly metadata?: unknown
}

/** schema/tool.ts:16-24 —— `add()` 的入参；`input` 收 zod 对象（StandardSchema）或 JSON Schema。 */
export interface V2ToolDefinition {
    name: string
    description: string
    input: unknown
    execute: (input: never, ctx: V2ToolContext) => Promise<V2ToolResult> | V2ToolResult
    output?: unknown
    options?: {
        namespace?: string
        permission?: unknown
        codemode?: boolean
        pinned?: boolean
    }
}

/** promise/tool.ts:26-36 —— 只有 transform 回调里能 add/update/remove。 */
export interface V2ToolEditor {
    list(): unknown[]
    get(name: string): unknown
    add(definition: V2ToolDefinition): void
    remove(name: string): void
}

/** promise/tool.ts:38-46 —— `tool` 与 `input` 可写，其余只读。 */
export interface V2ToolExecuteBeforeEvent {
    tool: string
    readonly sessionID: string
    readonly agent: string
    readonly messageID: string
    readonly id: string
    input: unknown
}

/* --------------------------------------------------------------- command */

/** promise/command.ts:7-11 —— `execute` 返回 void，输出要自己投递（见 session.synthetic）。 */
export interface V2CommandInvocation {
    readonly sessionID: string
    readonly prompt: string
    readonly delivery?: string
}

/** promise/command.ts:13-21 —— V2 没有 `template` 字段。 */
export interface V2CommandDefinition {
    name: string
    description?: string
    execute: (invocation: V2CommandInvocation) => Promise<void> | void
}

export interface V2CommandEditor {
    add(definition: V2CommandDefinition): void
}

/* --------------------------------------------------------------- session */

/**
 * ai/src/schema/messages.ts:236-243 —— hook("context") 里的消息是**平铺 LLM 消息**，
 * 不是 V1 的 `{info, parts}`。`content` 非 readonly（可 push），`system`/`options`/`tools`
 * 可写，`sessionID`/`model`/`agent` 只读（promise/session.ts:25-36）。
 */
export interface V2Message {
    role: "system" | "user" | "assistant" | "tool"
    readonly id?: string
    content: V2ContentPart[]
}

/** messages.ts:21-45 —— 只声明用到的三个，其余按索引放行。 */
export type V2ContentPart =
    | { type: "text"; text: string; cache?: unknown; metadata?: Record<string, unknown> }
    | { type: "tool"; id?: string; name: string; state: { status?: string; error?: unknown } }
    | { type: string; [key: string]: unknown }

export interface V2SystemPart {
    type: "text"
    text: string
    cache?: unknown
    metadata?: Record<string, unknown>
}

/** promise/session.ts:25-36。 */
export interface V2ContextEvent {
    readonly sessionID: string
    readonly model: unknown
    readonly agent: string
    system: V2SystemPart[]
    messages: V2Message[]
    options: Record<string, unknown>
    tools: Record<string, unknown>
}

/** promise/session.ts:14-20 —— `prompt`/`metadata`/`delivery` 可写。 */
export interface V2PromptEvent {
    readonly sessionID: string
    readonly messageID: string
    prompt: string
    metadata?: Record<string, unknown>
    delivery?: "steer" | "queue"
}

export interface V2SessionDomain {
    /** 唯一能取全量消息的入口（v2.0.24 无 `session.messages`）：types.ts:4544-4546。 */
    context(args: { sessionID: string }): Promise<unknown[]>
    prompt(args: { sessionID: string; text: string; metadata?: Record<string, unknown>; delivery?: "steer" | "queue" }): Promise<unknown>
    /** core/session/session.ts:273-313 —— `resume: false` 时不唤醒模型，等价 V1 `noReply`。 */
    synthetic(args: { sessionID: string; text: string; description?: string; resume?: boolean; metadata?: Record<string, unknown> }): Promise<unknown>
    create(args: { title?: string; model?: unknown; location?: string; metadata?: Record<string, unknown> }): Promise<unknown>
    remove(args: { sessionID: string }): Promise<unknown>
    hook(name: "context", cb: (event: V2ContextEvent) => void | Promise<void>): Promise<unknown>
    hook(name: "prompt", cb: (event: V2PromptEvent) => void | Promise<void>): Promise<unknown>
    hook(name: string, cb: (event: never) => void | Promise<void>): Promise<unknown>
}

/* ----------------------------------------------------------------- event */

/** client/generated/client.ts:1690 + types.ts:6199 —— 元素是 `{type, data}`。 */
export interface V2Event {
    readonly type: string
    readonly data?: Record<string, unknown>
    readonly [key: string]: unknown
}

export interface V2EventDomain {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>
}

/* ------------------------------------------------------------ permission */

/** promise/permission.ts:7-16 —— `effect` 与 `message` 可写。 */
export interface V2PermissionEvent {
    readonly sessionID: string
    readonly agent?: string
    readonly action: string
    readonly resources?: readonly string[]
    readonly metadata?: Record<string, unknown>
    readonly source?: string
    effect: "allow" | "deny" | "ask"
    message?: string
}

export interface V2PermissionDomain {
    hook(name: "evaluate", cb: (event: V2PermissionEvent) => void | Promise<void>): Promise<unknown>
}

/* ------------------------------------------------------------------ tool */

export interface V2ToolDomain {
    transform(cb: (editor: V2ToolEditor) => void): Promise<unknown>
    hook(name: "execute.before", cb: (event: V2ToolExecuteBeforeEvent) => void | Promise<void>): Promise<unknown>
    hook(name: string, cb: (event: never) => void | Promise<void>): Promise<unknown>
}

export interface V2CommandDomain {
    transform(cb: (editor: V2CommandEditor) => void): Promise<unknown>
}

/* --------------------------------------------------------------- context */

/** schema/location.ts:19-27 —— V2 没有 `worktree` 字段，项目目录取这里。 */
export interface V2Location {
    readonly directory: string
    readonly workspaceID?: string
    readonly project?: { readonly id: string; readonly directory: string; readonly canonical: string }
}

/**
 * promise/plugin.ts:26-54 —— 运行时 26 个域，这里只声明本插件用到的 7 个；
 * 其余（agent/aisdk/catalog/experimental/generate/mcp/model/provider/reference/rpc/
 * skill/storage/vcs/websearch/worktree/shell/app/options/plugin）按需再补。
 */
export interface V2Context {
    readonly location: V2Location
    readonly session: V2SessionDomain
    readonly tool: V2ToolDomain
    readonly command: V2CommandDomain
    readonly event: V2EventDomain
    readonly permission: V2PermissionDomain
    readonly options?: Record<string, unknown>
    readonly app?: { readonly name?: string; readonly version?: string }
}

/** promise/plugin.ts:56-61 —— `setup` 可返回 cleanup。 */
export interface V2Plugin {
    id: string
    setup(ctx: V2Context): Promise<Cleanup | void> | Cleanup | void
}

/**
 * 注册类 API（transform / hook）在 2.0.24 返回 `Registration`。
 * 形状未在源码中逐字确认，这里按三种可能都兼容：函数 / `{unregister}` / undefined。
 */
export function toCleanup(registration: unknown): Cleanup | undefined {
    if (typeof registration === "function") return registration as Cleanup
    const candidate = registration as { unregister?: unknown } | null | undefined
    if (candidate && typeof candidate.unregister === "function") {
        const unregister = candidate.unregister as () => unknown
        return () => {
            void unregister()
        }
    }
    return undefined
}
