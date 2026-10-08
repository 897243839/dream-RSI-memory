import test from "node:test"
import assert from "node:assert/strict"
import { tool } from "@opencode-ai/plugin"
import { createLegacyClient, toV2Result, toV2Tool } from "../dist/lib/v2-compat.js"

function recordingHost() {
    const calls = { context: [], create: [], remove: [], prompt: [], synthetic: [] }
    const ctx = {
        location: { directory: "C:/proj" },
        session: {
            async context(args) {
                calls.context.push(args)
                return [
                    { type: "user", id: "u1", time: { created: 1760000000123 }, text: "修一下账单" },
                    {
                        type: "assistant",
                        id: "a1",
                        time: { created: 2 },
                        agent: "build",
                        model: { providerID: "p", modelID: "m" },
                        content: [
                            { type: "text", text: "改完了" },
                            { type: "tool", id: "t1", name: "bash", state: { status: "error", error: "boom" } },
                        ],
                    },
                    { type: "compaction", id: "c1" },
                ]
            },
            async create(args) {
                calls.create.push(args)
                return { id: "sess-created" }
            },
            async remove(args) {
                calls.remove.push(args)
            },
            async prompt(args) {
                calls.prompt.push(args)
                return { ok: true }
            },
            async synthetic(args) {
                calls.synthetic.push(args)
                return { ok: true }
            },
        },
    }
    return { ctx, calls }
}

test("session.context → V1 { data } with role/parts and tool error state", async () => {
    const { ctx, calls } = recordingHost()
    const client = createLegacyClient(ctx)

    const result = await client.session.messages({ path: { id: "sess-9" } })
    assert.deepEqual(calls.context, [{ sessionID: "sess-9" }], "必须按 sessionID 取上下文")

    const [user, assistant, compaction] = result.data
    assert.equal(user.role, "user")
    assert.equal(user.parts[0].type, "text")
    assert.equal(user.parts[0].text, "修一下账单")
    assert.equal(user.time.created, 1760000000123, "毫秒时间戳原样透传")

    assert.equal(assistant.role, "assistant")
    assert.deepEqual(
        assistant.parts.map((p) => p.type),
        ["text", "tool"],
        "reasoning 等 V1 不读的 part 应被丢弃",
    )
    assert.equal(assistant.parts[1].tool, "bash")
    assert.equal(assistant.parts[1].state.status, "error", "工具失败状态必须保留，否则 outcome 判定会失真")

    assert.equal(compaction.summary, true, "非 user/assistant 消息标 summary，V1 侧会跳过")
})

test("prompt with noReply routes to session.synthetic({ resume: false })", async () => {
    const { ctx, calls } = recordingHost()
    const client = createLegacyClient(ctx)

    await client.session.prompt({
        path: { id: "sess-1" },
        body: { noReply: true, parts: [{ type: "text", text: "命令输出", ignored: true }] },
    })

    assert.equal(calls.prompt.length, 0, "noReply 绝不能走 session.prompt，否则会唤醒模型")
    assert.equal(calls.synthetic.length, 1)
    assert.deepEqual(calls.synthetic[0], {
        sessionID: "sess-1",
        text: "命令输出",
        resume: false,
        metadata: undefined,
    })
})

test("prompt without noReply routes to session.prompt", async () => {
    const { ctx, calls } = recordingHost()
    const client = createLegacyClient(ctx)

    await client.session.prompt({
        path: { id: "sess-2" },
        body: { parts: [{ type: "text", text: "调优提示词" }] },
    })

    assert.equal(calls.synthetic.length, 0)
    assert.equal(calls.prompt.length, 1)
    assert.deepEqual(calls.prompt[0], { sessionID: "sess-2", text: "调优提示词", metadata: undefined })
})

test("session.create / delete map to V2 create / remove", async () => {
    const { ctx, calls } = recordingHost()
    const client = createLegacyClient(ctx)

    const created = await client.session.create({ body: { title: "dream-mutate" }, query: { directory: "C:/proj" } })
    assert.deepEqual(calls.create, [{ title: "dream-mutate", model: undefined, location: "C:/proj" }])
    assert.equal(created.data.id, "sess-created")

    await client.session.delete({ path: { id: "sess-created" } })
    assert.deepEqual(calls.remove, [{ sessionID: "sess-created" }])
})

test("V1 model {providerID, modelID} becomes V2 ModelRef {providerID, id}", async () => {
    const { ctx, calls } = recordingHost()
    const client = createLegacyClient(ctx)

    await client.session.create({
        body: { title: "dream-mutate", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
        query: { directory: "C:/proj" },
    })
    assert.deepEqual(
        calls.create[0].model,
        { providerID: "anthropic", id: "claude-sonnet-4-5" },
        "V2 的 ModelRef 字段名是 id，不是 modelID",
    )

    // 已经是 ModelRef 形状时原样透传，不重复改写
    await client.session.create({ body: { model: { providerID: "x", id: "y" } } })
    assert.deepEqual(calls.create[1].model, { providerID: "x", id: "y" })

    await client.session.create({ body: {} })
    assert.equal(calls.create[2].model, undefined)
})

test("time.created in seconds is normalised to ms (meta-llm compares against Date.now())", async () => {
    const ctx = {
        location: { directory: "C:/proj" },
        session: {
            async context() {
                return [{ type: "user", id: "u1", time: { created: 1760000000 }, text: "hi" }]
            },
        },
    }
    const client = createLegacyClient(ctx)
    const { data } = await client.session.messages({ path: { id: "s" } })
    assert.equal(data[0].time.created, 1760000000000, "秒 → 毫秒，否则 curator 每轮都等超时")
})

test("V1 ToolResult → V2 { content }", () => {
    assert.deepEqual(toV2Result("纯文本"), { content: "纯文本" })
    assert.deepEqual(toV2Result({ output: "带标题" }), { content: "带标题" })
    assert.deepEqual(toV2Result({ output: "x", metadata: { a: 1 } }), { content: "x", metadata: { a: 1 } })
    assert.equal(typeof toV2Result({ output: "x", title: "t" }).content, "string")
})

test("toV2Tool carries sessionID/agent/worktree into the legacy tool context", async () => {
    const seen = []
    const definition = {
        description: "demo",
        args: { query: tool.schema.string() },
        async execute(args, toolCtx) {
            seen.push({ args, toolCtx })
            return "done"
        },
    }

    const converted = toV2Tool("dream_memory_demo", definition, { directory: "C:/proj", rootPath: "C:/proj" })
    assert.equal(converted.name, "dream_memory_demo")
    assert.ok(converted.input, "input 必须存在")
    assert.equal(typeof converted.execute, "function")

    const result = await converted.execute(
        { query: "q" },
        { sessionID: "sess-1", agent: "build", messageID: "m1", id: "call-1" },
    )
    assert.deepEqual(result, { content: "done" }, "execute 返回字符串 → { content }")

    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].args, { query: "q" })
    assert.equal(seen[0].toolCtx.sessionID, "sess-1")
    assert.equal(seen[0].toolCtx.agent, "build")
    assert.equal(seen[0].toolCtx.worktree, "C:/proj", "V2 无 worktree，用 location.directory")
    assert.equal(seen[0].toolCtx.directory, "C:/proj")
    assert.equal(typeof seen[0].toolCtx.abort, "object")
})
