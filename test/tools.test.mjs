import test from "node:test"
import assert from "node:assert/strict"
import { createTools } from "../dist/lib/tools.js"
import { FileCollector } from "../dist/lib/capture.js"
import { baseConfig, commitN, fakeLogger, loadStore } from "./helpers.mjs"

const ctx = () => ({ sessionID: "s", worktree: "C:/proj", agent: "build" })

function tools(store) {
    return createTools({
        client: {},
        store,
        config: baseConfig(),
        logger: fakeLogger,
        collector: new FileCollector(),
        meta: {},
    })
}

test("dream_rsi_memory_search defaults limit to policy maxRecall, not 1", async () => {
    const store = await loadStore()
    commitN(store, 7, { summary: "fix the billing amount overflow", files: ["src/billing.ts"] })
    const text = await tools(store).dream_rsi_memory_search.execute({ query: "billing" }, ctx())
    const bullets = (text.match(/•/g) ?? []).length
    assert.ok(bullets >= 2, `default limit should pull several hits, got ${bullets}`)
    assert.ok(!/检索得 1 条/.test(text), "default must not collapse to a single hit")
})

test("dream_rsi_memory_search clamps explicit limits to 1..10", async () => {
    const store = await loadStore()
    commitN(store, 12, { summary: "schema migration", files: ["src/db.ts"] })
    const text = await tools(store).dream_rsi_memory_search.execute({ query: "migration", limit: 0 }, ctx())
    assert.ok(/检索得 1 条/.test(text), "limit 0 should clamp to 1")
})

test("P0-1 端到端：dream 工具从 ctx.sessionID 透传 sessionId → 自动切换真的发生", async () => {
    const store = await loadStore()
    const session = "sess-dream-tool"
    const candidate = (name) => ({ name, approach: `${name} 的落地路径`, tradeoffs: "快但糙", estimatedRisk: "低" })

    // 与 dream-switch 主场景同构：方案B 先被 pick（会话有 active alt），方案A 子树全成功
    const { setId, altIds } = store.proposeStrategySet({
        problem: "选哪个缓存方案",
        alts: [candidate("方案A"), candidate("方案B")],
        provisionalPick: "方案B",
        sessionId: session,
        agentName: "build",
    })
    const [altA, altB] = altIds
    for (let i = 0; i < 5; i++) {
        store.commit({ summary: "方案A 成功经验", outcome: "success", files: ["src/cache.ts"], sessionId: session, agentName: "build", parentId: altA, branchId: altA })
        store.commit({ summary: "方案B 踩坑记录", outcome: "failed", files: ["src/cache.ts"], sessionId: session, agentName: "build", parentId: altB, branchId: altB })
    }
    assert.equal(store.resolveActiveAlt(session)?.nodeId, altB, "前置：会话 active alt = 方案B")
    assert.equal(store.count(), 10, "前置：M 期节点数")

    // 真实工具入口：sessionId 只能来自 ctx.sessionID（直调 runDream 的旧测法盖不住这条断线）
    const text = await tools(store).dream_rsi_memory_dream.execute({}, {
        sessionID: session,
        worktree: "C:/proj",
        agent: "build",
    })

    // 断言（修复后行为）：确实发生了切换 —— sessionId 没透传时 canAutoSwitch 条件3 恒 false，永不切换
    const log = store.getAdviceLog()
    assert.equal(log.length, 1, `应写入 1 条 advice，实际 ${log.length}`)
    assert.equal(log[0].autoSwitched, true, "工具入口端到端必须真的自动切换")
    assert.equal(log[0].setId, setId)
    assert.equal(log[0].recommendedAltId, altA, "推荐的应是高分分支方案A")
    assert.equal(store.getNode(altA).status, "chosen", "高分分支应变 chosen")
    assert.equal(store.getNode(altB).status, "superseded", "旧 chosen 应让位为 superseded")
    assert.equal(store.resolveActiveAlt(session)?.nodeId, altA, "切换后会话 active alt = 方案A")
    assert.ok(text.includes("策略库分支评估"), text)
    assert.ok(text.includes("已自动切换"), text)
})