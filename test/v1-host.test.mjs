import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

const EXPECTED_TOOLS = [
    "dream_memory_commit",
    "dream_memory_search",
    "dream_memory_node",
    "dream_memory_status",
    "dream_memory_policy",
    "dream_memory_dream",
]

function loadEntry() {
    return import(pathToFileURL(join(process.cwd(), "dist", "index.js")).href)
}

/**
 * 造一个 V1 宿主（opencode 1.x PluginInput）。client 按 @opencode-ai/sdk 的
 * `{data, request, response}` 形状造假：messages 返回 `{info, parts}` 数组，
 * 用于验证 v1-host.ts 的归一逻辑真的生效（平铺 role/parts 是 lib/ 期望的形状）。
 */
function fakeV1Host(directory) {
    const state = { messages: [], created: [], deleted: [], prompts: [] }
    const client = {
        session: {
            async messages({ path }) {
                const data = state.messages
                    .filter((m) => m.sessionID === path.id)
                    .map((m) => ({ info: { id: m.id, role: m.role }, parts: m.parts ?? [] }))
                return { data, request: null, response: null }
            },
            async create({ body }) {
                const id = `v1-${state.created.length + 1}`
                state.created.push({ id, body })
                return { data: { id, title: body?.title ?? "" }, request: null, response: null }
            },
            async delete({ path }) {
                state.deleted.push(path.id)
                return { data: null, request: null, response: null }
            },
            async prompt({ path, body }) {
                state.prompts.push({ id: path.id, body })
                return { data: null, request: null, response: null }
            },
        },
    }
    const input = {
        client,
        project: { id: directory },
        directory,
        worktree: directory,
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: () => {
            throw new Error("$ (BunShell) is not used by dream-memory")
        },
        experimental_workspace: { register() {} },
    }
    return { input, state }
}

function projectWithConfig(overrides = {}) {
    const project = mkdtempSync(join(tmpdir(), "dm-v1host-"))
    const data = mkdtempSync(join(tmpdir(), "dm-v1host-data-"))
    mkdirSync(join(project, ".opencode"))
    writeFileSync(
        join(project, ".opencode", "dream-memory.jsonc"),
        JSON.stringify({ enabled: true, dataDir: data, distill: { enabled: false }, ...overrides }),
    )
    return {
        project,
        data,
        dispose: () => {
            rmSync(project, { recursive: true, force: true })
            rmSync(data, { recursive: true, force: true })
        },
    }
}

test("V1 server registers the 6 tools and non-empty command templates", async () => {
    const mod = await loadEntry()
    const { project, dispose } = projectWithConfig()
    const { input } = fakeV1Host(project)
    try {
        const hooks = await mod.default.server(input)

        assert.equal(typeof hooks, "object")
        assert.deepEqual(
            Object.keys(hooks.tool ?? {}).sort(),
            [...EXPECTED_TOOLS].sort(),
            "V1 hooks.tool 必须是完整 6 工具",
        )
        for (const definition of Object.values(hooks.tool ?? {})) {
            assert.equal(typeof definition.execute, "function", `${definition.description}.execute`)
            assert.ok(definition.args, "args 必须是真实 zod raw shape（不能是包装层）")
        }

        // 命令经 hooks.config 注册非空模板
        assert.equal(typeof hooks.config, "function", "V1 必须提供 hooks.config")
        const config = {}
        await hooks.config(config)
        assert.ok(config.command, "hooks.config 应写入 command")
        assert.ok(config.command.dream, "缺少 dream 命令")
        assert.ok(config.command.memory, "缺少 memory 命令")
        assert.ok(config.command.dream.template.length > 0, "dream 模板不能为空")
        assert.ok(config.command.memory.template.length > 0, "memory 模板不能为空")
        assert.match(config.command.dream.template, /dream_memory_status/)
        assert.match(config.command.memory.template, /dream_memory_node/)

        // 其余 seam 都在；command.execute.before 禁用（2.1.0 的 500 根因）
        assert.equal(typeof hooks.event, "function")
        assert.equal(typeof hooks["tool.execute.before"], "function")
        assert.equal(typeof hooks["experimental.chat.system.transform"], "function")
        assert.equal(typeof hooks["experimental.chat.messages.transform"], "function")
        assert.equal(hooks["command.execute.before"], undefined)
    } finally {
        dispose()
    }
})

test("V1 client adapter flattens {info, parts} and forwards curator prompt model", async () => {
    const mod = await loadEntry()
    const { project, dispose } = projectWithConfig()
    const { input, state } = fakeV1Host(project)
    try {
        state.messages.push({
            sessionID: "s1",
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
        })

        const { createV1Client } = await import(pathToFileURL(join(process.cwd(), "dist", "lib", "v1-host.js")).href)
        const client = createV1Client(input.client)
        const read = await client.session.messages({ path: { id: "s1" } })
        assert.equal(read.data[0].role, "user", "V1 的 {info,parts} 要归一成平铺 role")
        assert.equal(read.data[0].parts[0].text, "hello")

        await client.session.create({ body: { title: "t", model: { providerID: "p", modelID: "m" } }, query: { directory: project } })
        await client.session.prompt({ path: { id: "v1-1" }, body: { parts: [{ type: "text", text: "x", ignored: true }] } })
        assert.equal(state.prompts[0].body.model.providerID, "p", "create 时给的 model 要补回 prompt")
    } finally {
        dispose()
    }
})