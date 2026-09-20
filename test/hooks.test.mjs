import test from "node:test"
import assert from "node:assert/strict"
import { createEventHandler, createMessagesTransformHandler } from "../dist/lib/hooks.js"
import { captureTurn, FileCollector } from "../dist/lib/capture.js"
import { GateRegistry } from "../dist/lib/menu.js"
import { baseConfig, fakeLogger, loadStore } from "./helpers.mjs"

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