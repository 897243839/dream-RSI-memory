import { test } from "node:test"
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function loadEntry() {
    const require = createRequire(import.meta.url)
    const entry = pathToFileURL(require.resolve("../dist/index.js")).href
    return import(entry)
}

const EXPECTED_TOOLS = [
    "dream_memory_commit",
    "dream_memory_search",
    "dream_memory_node",
    "dream_memory_status",
    "dream_memory_policy",
    "dream_memory_dream",
]

/**
 * 最小 V2 宿主（opencode 2.0.24 的 ctx 子集）：记录所有注册行为，
 * 让测试能在没有真实 opencode 的情况下验证接线。
 */
function fakeHost(directory) {
    const state = {
        tools: [],
        commands: [],
        toolHooks: [],
        sessionHooks: [],
        synthetic: [],
        prompts: [],
        removed: [],
        created: [],
    }
    const ctx = {
        location: { directory },
        session: {
            async context({ sessionID }) {
                state.contexts = state.contexts ?? []
                state.contexts.push(sessionID)
                return []
            },
            async prompt(args) {
                state.prompts.push(args)
                return {}
            },
            async synthetic(args) {
                state.synthetic.push(args)
                return {}
            },
            async create(args) {
                state.created.push(args)
                return { id: `tmp-${state.created.length}` }
            },
            async remove({ sessionID }) {
                state.removed.push(sessionID)
            },
            async hook(name, cb) {
                state.sessionHooks.push({ name, cb })
                return () => {}
            },
        },
        tool: {
            async transform(callback) {
                callback({
                    add: (definition) => state.tools.push(definition),
                    list: () => state.tools,
                    get: () => undefined,
                    remove: () => {},
                    update: () => {},
                    namespace: "dream-memory",
                })
                return () => {}
            },
            async hook(name, cb) {
                state.toolHooks.push({ name, cb })
                return () => {}
            },
        },
        command: {
            async transform(callback) {
                callback({
                    add: (definition) => state.commands.push(definition),
                })
                return () => {}
            },
        },
        event: {
            subscribe: () =>
                (async function* () {
                    /* 空事件流：接线测试不关心事件 */
                })(),
        },
        permission: {
            async hook() {
                return () => {}
            },
        },
    }
    return { ctx, state }
}

const toolCallCtx = (sessionID = "sess-1") => ({
    sessionID,
    agent: "build",
    messageID: "m1",
    id: "call-1",
    signal: undefined,
})

function projectWithConfig(overrides = {}) {
    const project = mkdtempSync(join(tmpdir(), "dm-entry-"))
    const data = mkdtempSync(join(tmpdir(), "dm-entry-data-"))
    mkdirSync(join(project, ".opencode"))
    writeFileSync(
        join(project, ".opencode", "dream-memory.jsonc"),
        JSON.stringify({ enabled: true, dataDir: data, distill: { enabled: false }, ...overrides }),
    )
    return { project, data, dispose: () => {
        rmSync(project, { recursive: true, force: true })
        rmSync(data, { recursive: true, force: true })
    } }
}

test("plugin entry exports a dual V1+V2 module (id + setup + server)", async () => {
    const mod = await loadEntry()

    assert.equal(typeof mod.default, "object")
    assert.equal(mod.default.id, "dream-memory")
    assert.equal(typeof mod.default.setup, "function", "V2 入口必须导出 setup")
    assert.equal(typeof mod.default.server, "function", "V1 入口必须导出 server（billion-context 同构）")
    assert.ok(!("tui" in mod.default), "should not declare a tui surface")
})

test("setup registers tools, commands and hooks under an isolated project", async () => {
    const mod = await loadEntry()
    const { project, dispose } = projectWithConfig()
    const { ctx, state } = fakeHost(project)
    try {
        const cleanup = await mod.default.setup(ctx)
        assert.equal(typeof cleanup, "function", "setup should return a cleanup")

        assert.deepEqual(
            state.tools.map((t) => t.name).sort(),
            [...EXPECTED_TOOLS].sort(),
            "六个 dream 工具都要注册",
        )
        for (const definition of state.tools) {
            assert.equal(typeof definition.execute, "function", `${definition.name}.execute`)
            assert.equal(typeof definition.description, "string", `${definition.name}.description`)
            assert.ok(definition.input, `${definition.name}.input 必须是 ValueSchema`)
        }

        assert.deepEqual(state.commands.map((c) => c.name).sort(), ["dream", "memory"])
        for (const command of state.commands) {
            assert.equal(typeof command.execute, "function", `${command.name}.execute`)
        }

        assert.ok(state.toolHooks.some((h) => h.name === "execute.before"), "tool.execute.before 必须注册")
        assert.ok(state.sessionHooks.some((h) => h.name === "context"), "session.context 必须注册")

        await cleanup()
    } finally {
        dispose()
    }
})

test("a registered tool returns V2 { content }", async () => {
    const mod = await loadEntry()
    const { project, dispose } = projectWithConfig()
    const { ctx, state } = fakeHost(project)
    try {
        const cleanup = await mod.default.setup(ctx)

        const status = state.tools.find((t) => t.name === "dream_memory_status")
        const result = await status.execute({}, toolCallCtx())
        assert.equal(typeof result.content, "string", "V2 工具结果走 { content }")
        assert.ok(result.content.includes("[dream-memory]"), "status 文本应带插件前缀")

        // commit 走一遍兼容层的 session.context → session.messages 映射
        const commit = state.tools.find((t) => t.name === "dream_memory_commit")
        const committed = await commit.execute({ summary: "验证入口", outcome: "success" }, toolCallCtx())
        assert.ok(committed.content.includes("已记录节点"), `commit 输出：${committed.content}`)

        const search = state.tools.find((t) => t.name === "dream_memory_search")
        const found = await search.execute({ query: "验证入口" }, toolCallCtx())
        assert.ok(found.content.includes("检索得 1 条"), `search 应命中刚记录的节点：${found.content}`)

        await cleanup()
    } finally {
        dispose()
    }
})

test("tool.execute.before feeds touched files into the next commit", async () => {
    const mod = await loadEntry()
    const { project, dispose } = projectWithConfig()
    const { ctx, state } = fakeHost(project)
    try {
        const cleanup = await mod.default.setup(ctx)

        const before = state.toolHooks.find((h) => h.name === "execute.before")
        await before.cb({ tool: "edit", sessionID: "sess-1", messageID: "m1", id: "call-1", input: { filePath: "src/touched.ts" } })
        await new Promise((resolve) => setImmediate(resolve))

        const commit = state.tools.find((t) => t.name === "dream_memory_commit")
        const result = await commit.execute({ summary: "带文件的提交", outcome: "success" }, toolCallCtx())
        assert.ok(result.content.includes("关联 1 个文件"), `collector 收集到的文件要进节点：${result.content}`)

        await cleanup()
    } finally {
        dispose()
    }
})

test("session.context hook injects system help and the menu", async () => {
    const mod = await loadEntry()
    const { project, dispose } = projectWithConfig()
    const { ctx, state } = fakeHost(project)
    try {
        const cleanup = await mod.default.setup(ctx)
        const contextHook = state.sessionHooks.find((h) => h.name === "context").cb

        const turn = (text) => ({
            sessionID: "sess-1",
            agent: "build",
            model: {},
            system: [],
            messages: [{ id: "m1", role: "user", content: [{ type: "text", text }] }],
            options: {},
            tools: {},
        })

        const first = turn("第一轮")
        await contextHook(first)
        assert.ok(
            first.system.some((part) => part.text.includes("[dream-memory] 长期记忆工具")),
            "system 帮助文案必须注入",
        )
        assert.equal(first.messages[0].content.length, 1, "冷启动不应注入菜单")

        const commit = state.tools.find((t) => t.name === "dream_memory_commit")
        await commit.execute({ summary: "第一轮的结论", outcome: "success" }, toolCallCtx())

        const second = turn("第二轮")
        await contextHook(second)
        assert.ok(second.messages[0].content.length > 1, "冷却期满 + 新节点 → 菜单必须注入最后一条 user 消息")
        const injected = second.messages[0].content.at(-1)
        assert.equal(injected.type, "text")
        assert.ok(injected.text.includes("[dream-memory]"), "注入的应该是 dream 菜单")

        await cleanup()
    } finally {
        dispose()
    }
})

test("commands deliver output through session.synthetic({ resume: false })", async () => {
    const mod = await loadEntry()
    const { project, dispose } = projectWithConfig()
    const { ctx, state } = fakeHost(project)
    try {
        const cleanup = await mod.default.setup(ctx)
        const dream = state.commands.find((c) => c.name === "dream")
        const memory = state.commands.find((c) => c.name === "memory")

        await dream.execute({ sessionID: "sess-1", prompt: "status", delivery: "steer" })
        assert.equal(state.synthetic.length, 1, "命令输出必须走 synthetic")
        assert.equal(state.synthetic[0].resume, false, "resume:false 才等价 V1 的 noReply")
        assert.equal(state.synthetic[0].sessionID, "sess-1")
        assert.ok(state.synthetic[0].text.includes("[dream-memory]"), `命令输出：${state.synthetic[0].text}`)

        await memory.execute({ sessionID: "sess-1", prompt: "search 关键词不存在", delivery: "steer" })
        assert.equal(state.synthetic.length, 2)
        assert.ok(state.synthetic[1].text.includes("无结果"), "memory search 无结果提示")
        assert.equal(state.prompts.length, 0, "命令输出不能走 session.prompt（会触发模型）")

        await cleanup()
    } finally {
        dispose()
    }
})

test("setup still registers tools when the project directory is a root (desktop GUI)", async () => {
    const mod = await loadEntry()

    const data = mkdtempSync(join(tmpdir(), "dm-entry-data-"))
    const configDir = mkdtempSync(join(tmpdir(), "dm-entry-cfg-"))
    const previous = process.env.OPENCODE_CONFIG_DIR
    writeFileSync(
        join(configDir, "dream-memory.json"),
        JSON.stringify({ enabled: true, dataDir: data, distill: { enabled: false } }),
    )
    process.env.OPENCODE_CONFIG_DIR = configDir
    try {
        const { ctx, state } = fakeHost("/")
        const cleanup = await mod.default.setup(ctx)
        assert.equal(state.tools.length, EXPECTED_TOOLS.length, "根目录要回退到 home，工具照常注册")
        await cleanup()
    } finally {
        if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previous
        rmSync(configDir, { recursive: true, force: true })
        rmSync(data, { recursive: true, force: true })
    }
})

test("disabled config makes setup a no-op", async () => {
    const mod = await loadEntry()
    const { project, dispose } = projectWithConfig({ enabled: false })
    const { ctx, state } = fakeHost(project)
    try {
        const cleanup = await mod.default.setup(ctx)
        assert.equal(cleanup, undefined, "禁用时不应注册任何东西")
        assert.equal(state.tools.length, 0)
    } finally {
        dispose()
    }
})
