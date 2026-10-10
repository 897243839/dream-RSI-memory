import test from "node:test"
import assert from "node:assert/strict"
import { createCommandExecuteHandler, createEventHandler, createMessagesTransformHandler } from "../dist/lib/hooks.js"
import { captureTurn, FileCollector } from "../dist/lib/capture.js"
import { GateRegistry } from "../dist/lib/menu.js"
import { readQueryLog } from "../dist/lib/querylog.js"
import { baseConfig, commitN, fakeLogger, loadStore } from "./helpers.mjs"

const turn = (i, agent = "build") => ({
    messages: [{ info: { role: "user", agent, sessionID: "sess", id: "m" + i }, parts: [] }],
})

test("menu gate: cooldown, new-node trigger, dedup, internal-agent guard", async () => {
    const store = await loadStore()
    const cfg = baseConfig()
    const handler = createMessagesTransformHandler(store, new GateRegistry(), cfg, new FileCollector())

    let out = turn(1)
    await handler({}, out)
    assert.equal(out.messages[0].parts.length, 0, "cold start: no menu")

    store.commit({ summary: "x", files: ["a.ts"], sessionId: "sess", agentName: "build" })
    out = turn(2)
    await handler({}, out)
    assert.equal(out.messages[0].parts.length, 1, "cooldown met + new node → menu")
    assert.equal(out.messages[0].parts[0].synthetic, true)

    out = turn(3)
    await handler({}, out)
    assert.equal(out.messages[0].parts.length, 0, "already injected, no new node → no menu")

    const internal = { messages: [{ info: { role: "user", agent: "title", sessionID: "sess", id: "mi" }, parts: [] }] }
    await handler({}, internal)
    assert.equal(internal.messages[0].parts.length, 0, "internal agent: never injected")
})

test("session.idle auto-commit fallback", async () => {
    const store = await loadStore()
    const cfg = baseConfig({ autoCommitOnIdle: true, autoCommitIdleGapMs: 300_000 })
    const collector = new FileCollector()
    collector.add("sess", "src/a.ts")
    collector.add("sess", "src/b.ts")

    const fakeClient = {
        session: {
            messages: async () => ({
                data: [
                    { id: "u1", role: "user", parts: [{ type: "text", text: "fix the bug" }] },
                    { id: "a1", role: "assistant", parts: [{ type: "text", text: "fixed the bug now" }] },
                ],
            }),
        },
    }
    const handler = createEventHandler(fakeClient, store, cfg, collector, fakeLogger)

    await handler({ event: { type: "session.idle", properties: { sessionID: "sess" } } })
    assert.equal(store.count(), 1)
    const node = store.latestNode()
    assert.ok(node.summary.includes("auto(idle)"))
    assert.ok(node.summary.includes("fixed the bug now"))
    assert.deepEqual([...node.files].sort(), ["src/a.ts", "src/b.ts"])
    assert.equal(node.autoCreated, true)

    // second idle within gap → suppressed
    collector.add("sess", "src/c.ts")
    await handler({ event: { type: "session.idle", properties: { sessionID: "sess" } } })
    assert.equal(store.count(), 1)

    // unrelated events pass through
    await handler({ event: { type: "session.created", properties: { sessionID: "sess" } } })
    assert.equal(store.count(), 1)
})

test("captureTurn isolates the last turn only", async () => {
    const client = {
        session: {
            messages: async () => ({
                data: [
                    { id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
                    { id: "a1", role: "assistant", parts: [{ type: "text", text: "first reply" }] },
                    { id: "u2", role: "user", parts: [{ type: "text", text: "second" }] },
                    {
                        id: "a2",
                        role: "assistant",
                        parts: [
                            { type: "text", text: "second reply" },
                            { type: "tool", tool: "edit", state: { status: "completed" } },
                            { type: "tool", tool: "bash", state: { status: "error" } },
                        ],
                    },
                ],
            }),
        },
    }
    const m = await captureTurn(client, "s", 2000)
    assert.equal(m.userText, "second")
    assert.ok(m.assistantText.includes("second reply"))
    assert.ok(!m.assistantText.includes("first reply"), "earlier-turn assistant text must not leak in")
    assert.ok(m.tools.some((t) => t.tool === "bash" && t.error))
    assert.ok(!m.tools.some((t) => t.tool === "edit" && t.error))
})

const turnWithText = (i, text, sessionID = "sess", agent = "build") => ({
    messages: [{ info: { role: "user", agent, sessionID, id: "m" + i }, parts: [{ type: "text", text }] }],
})

test("menu teaser surfaces a real cross-session hit", async () => {
    const store = await loadStore()
    const cfg = baseConfig()
    const handler = createMessagesTransformHandler(store, new GateRegistry(), cfg, new FileCollector())

    const warm = turnWithText(0, "hello")
    await handler({}, warm)
    assert.equal(warm.messages[0].parts.length, 1, "first turn: text part only, no menu injected")

    store.commit({
        summary: "invoice totals overflow silently on discount",
        outcome: "failed",
        files: ["src/inv.ts"],
        sessionId: "sess-other",
        agentName: "build",
    })

    const out = turnWithText(1, "fix the invoice total")
    await handler({}, out)
    assert.equal(out.messages[0].parts.length, 2, "cooldown met + new node → menu added")
    const menu = out.messages[0].parts[1].text
    assert.ok(menu.includes("命中历史"), "real cross-session hit must tease")
    assert.ok(menu.includes("invoice totals"), "teaser must carry the hit summary")

    // P2: teaser 出口落盘（trigger=teaser）
    const teaserLogs = readQueryLog(store.getProjectDir())
    assert.equal(teaserLogs.length, 1, "teaser 检索必须写 querylog")
    assert.equal(teaserLogs[0].trigger, "teaser")
    assert.equal(teaserLogs[0].query, "fix the invoice total")
})

test("menu teaser stays quiet without a cross-session hit", async () => {
    const store = await loadStore()
    const cfg = baseConfig()
    const handler = createMessagesTransformHandler(store, new GateRegistry(), cfg, new FileCollector())

    const warm = turnWithText(0, "hello")
    await handler({}, warm)
    store.commit({ summary: "my own local fix", files: ["src/inv.ts"], sessionId: "sess", agentName: "build" })

    const out = turnWithText(1, "fix the invoice total")
    await handler({}, out)
    assert.equal(out.messages[0].parts.length, 2, "menu still injected")
    assert.ok(!out.messages[0].parts[1].text.includes("命中历史"), "same-session nodes must not tease")
})

test("/dream search surfaces past nodes by keyword", async () => {
    const store = await loadStore()
    store.commit({
        summary: "invoice totals overflow silently on discount",
        outcome: "failed",
        files: ["src/inv.ts"],
        sessionId: "sess-other",
        agentName: "build",
    })

    const sent = []
    const client = { session: { prompt: async (opts) => sent.push(opts) } }
    const handler = createCommandExecuteHandler(client, store, baseConfig(), {
        logger: fakeLogger,
        collector: new FileCollector(),
    })

    await handler({ command: "dream", sessionID: "sess", arguments: "search invoice total" }, {})
    assert.equal(sent.length, 1)
    const body = sent[0].body
    assert.equal(body.noReply, true)
    assert.equal(body.parts[0].ignored, true)
    assert.ok(body.parts[0].text.includes("invoice totals overflow"), "hit summary must be surfaced")
    assert.ok(body.parts[0].text.includes("策略 p-default"), "result header must name the policy")

    await handler({ command: "memory", sessionID: "sess", arguments: "search nothing-here" }, {})
    assert.ok(sent[1].body.parts[0].text.includes("无结果"))

    // P2: 命令出口落盘（trigger=command），每次 search 一行
    const cmdLogs = readQueryLog(store.getProjectDir())
    assert.equal(cmdLogs.length, 2, "两次 /dream search 各写一行")
    assert.equal(cmdLogs[0].trigger, "command")
    assert.equal(cmdLogs[0].query, "invoice total")
    assert.equal(cmdLogs[1].query, "nothing-here")
})

test("/dream commit records a node with files from the collector", async () => {
    const store = await loadStore()
    const collector = new FileCollector()
    collector.add("sess", "src/a.ts")

    const sent = []
    const client = { session: { prompt: async (opts) => sent.push(opts) } }
    const handler = createCommandExecuteHandler(client, store, baseConfig(), {
        logger: fakeLogger,
        collector,
    })

    await handler({ command: "dream", sessionID: "sess", arguments: "commit invoice fix 成功" }, {})

    assert.equal(store.count(), 1)
    const node = store.latestNode()
    assert.equal(node.summary, "invoice fix")
    assert.equal(node.outcome, "success")
    assert.deepEqual([...node.files], ["src/a.ts"])
    assert.equal(node.agentName, "command")
    assert.ok(sent[0].body.parts[0].text.includes("已记录节点"))
})

/* ------------------------------------------------------- P0 三阶段 nudge / 菜单 */

test("dream nudge 按阶段注入：S 无 / M 试用提示 / F 进化催促 / 禁用不注入", async () => {
    const run = async (cfg, nodeCount) => {
        const store = await loadStore(cfg)
        const handler = createMessagesTransformHandler(store, new GateRegistry(), cfg, new FileCollector())
        await handler({}, turn(1)) // 冷启动：仅记回合，不注入（cooldown=2）
        commitN(store, nodeCount, { summary: "fix the billing amount", files: ["src/billing.ts"], outcome: "success" })
        const out = turn(2)
        await handler({}, out)
        return out.messages[0].parts
    }

    // S 播种期：只有菜单（文案=信号采集中），无 nudge
    let parts = await run(baseConfig(), 3)
    assert.equal(parts.length, 1, `S 期不应注入 nudge，得到 ${parts.length} 个 part`)
    assert.ok(parts[0].text.includes("信号采集中"), "S 期菜单文案")

    // M 试用期：菜单 + 试调提示
    parts = await run(baseConfig(), 8)
    assert.equal(parts.length, 2, "M 期应注入菜单+试用期提示")
    assert.ok(parts[0].text.includes("试用期"), "M 期菜单文案")
    assert.ok(parts[1].text.includes("试用期"), "M 期 nudge 文案")

    // F 正式期：菜单 + 进化催促
    parts = await run(baseConfig(), 22)
    assert.equal(parts.length, 2, "F 期应注入菜单+进化催促")
    assert.ok(parts[1].text.includes("进化策略"), "F 期 nudge 文案")

    // dream.enabled=false：菜单照常，nudge 不注入
    const off = baseConfig({ dream: { ...baseConfig().dream, enabled: false } })
    parts = await run(off, 22)
    assert.equal(parts.length, 1, "禁用时 nudge 不得注入")
    assert.ok(parts[0].text.includes("[dream-rsi-memory]"), "菜单本身不受 dream 开关影响")
})