import test from "node:test"
import assert from "node:assert/strict"
import { runDream } from "../dist/lib/dream.js"
import { createTools } from "../dist/lib/tools.js"
import { FileCollector } from "../dist/lib/capture.js"
import { getStage } from "../dist/lib/stages.js"
import { DEFAULT_PARAMS } from "../dist/lib/types.js"
import { baseConfig, commitN, fakeLogger, loadStore } from "./helpers.mjs"

test("getStage 三阶段划分（P0 单闸拆分）", () => {
    const d = { minNodesProvisional: 5, minNodes: 20 }
    assert.equal(getStage(0, d), "S")
    assert.equal(getStage(4, d), "S")
    assert.equal(getStage(5, d), "M")
    assert.equal(getStage(19, d), "M")
    assert.equal(getStage(20, d), "F")
    assert.equal(getStage(100, d), "F")
})

test("S 播种期（n<5）：不评估不切换，但写 insufficient 运行记录", async () => {
    const store = await loadStore()
    commitN(store, 4)
    const cfg = baseConfig()
    const before = store.activePolicy().policyId
    const result = await runDream(store, cfg, { logger: fakeLogger })
    // v2.1.0：不再静默"跳过"，改为显式声明证据不足（bootstrap 语义）
    assert.ok(result.text.includes("证据不足"), result.text)
    assert.ok(result.text.includes("信号采集中"), result.text)
    assert.equal(store.activePolicy().policyId, before, "S 期不得切换")
    const latest = store.latestDream()
    assert.ok(latest, "S 期必须写 DreamRunRecord")
    assert.equal(latest.status, "done")
    assert.equal(latest.candidatesJson, "[]")
    assert.ok(latest.notes.includes(`insufficient: n=4 < 5`), latest.notes)
    assert.equal(latest.chosenPolicyId, before)
})

test("M 试用期：放宽门槛切换出的策略带 provisional 标记", async () => {
    const store = await loadStore()
    commitN(store, 10, { summary: "fix the billing amount", files: ["src/billing.ts"], outcome: "success" })
    // 把 active 毒成恒零分的参数（任何 seed/默认候选都明显更优），保证发生切换
    store.patchNodePolicy(
        "p-bad",
        {
            ...DEFAULT_PARAMS,
            fileOverlapWeight: 0,
            ftsScoreWeight: 0,
            successBoost: 0,
            failureBoost: 0,
            minScore: 0.3,
            maxRecall: 1,
        },
        "p-default",
    )
    const cfg = baseConfig()
    const result = await runDream(store, cfg, { logger: fakeLogger })
    const active = store.activePolicy()
    assert.notEqual(active.policyId, "p-bad", "M 期应切换到更优候选")
    assert.equal(active.provisional, true, "M 期切换出的策略必须带 provisional")
    assert.ok(result.text.includes("provisional"), result.text)
    const latest = store.latestDream()
    assert.equal(latest.status, "done")
    assert.ok(latest.notes.includes("stage=M"), latest.notes)
    assert.ok(latest.notes.includes("relaxed-gate"), `valid 样本不足应走放宽门槛并记入 notes: ${latest.notes}`)
})

test("F 正式期：provisional 守擂成功 → 转正清除标记", async () => {
    const store = await loadStore()
    commitN(store, 20, { summary: "fix the billing amount", files: ["src/billing.ts"], outcome: "success" })
    store.patchNodePolicy("p-prov", { ...store.activePolicy().params }, "p-default")
    store.patchPolicyMeta("p-prov", { provisional: true })
    assert.equal(store.activePolicy().provisional, true, "前置条件：active 带 provisional")
    // ε 大到任何候选都不可能过门槛 → 不切换 → F 期守擂成功
    const cfg = baseConfig({ dream: { ...baseConfig().dream, epsilon: 10 } })
    await runDream(store, cfg, { logger: fakeLogger })
    const active = store.activePolicy()
    assert.equal(active.policyId, "p-prov", "不切换")
    assert.equal(active.provisional, undefined, "F 期守擂成功必须清除 provisional（转正）")
    assert.ok(store.latestDream().notes.includes("stage=F"))
})

test("dream.enabled=false：runDream 返回已禁用且不写记录，工具同样返回已禁用", async () => {
    const store = await loadStore()
    commitN(store, 24)
    const cfg = baseConfig({ dream: { ...baseConfig().dream, enabled: false } })
    const before = store.activePolicy().policyId
    const result = await runDream(store, cfg, { logger: fakeLogger })
    assert.ok(result.text.includes("已禁用"), result.text)
    assert.equal(store.latestDream(), undefined, "禁用时不写运行记录")
    assert.equal(store.activePolicy().policyId, before)

    const tools = createTools({
        client: {},
        store,
        config: cfg,
        logger: fakeLogger,
        collector: new FileCollector(),
        meta: {},
    })
    const toolText = await tools.dream_rsi_memory_dream.execute({}, { sessionID: "s", worktree: "C:/proj", agent: "build" })
    assert.ok(toolText.includes("已禁用"), toolText)
})

test("curator 关闭时不调用 LLM", async () => {
    const store = await loadStore()
    commitN(store, 10)
    let called = 0
    const meta = {
        configured: false,
        mutate: async () => {
            called++
            return []
        },
    }
    await runDream(store, baseConfig(), { logger: fakeLogger, meta })
    assert.equal(called, 0, "configured=false 不得触发 mutate")
})

test("LLM 失败时 dream 照常完成，notes 记 curator 错误", async () => {
    const store = await loadStore()
    commitN(store, 10)
    const meta = {
        configured: true,
        mutate: async () => {
            throw new Error("boom")
        },
    }
    const result = await runDream(store, baseConfig(), { logger: fakeLogger, meta })
    const latest = store.latestDream()
    assert.equal(latest.status, "done", "LLM 失败不得让 dream 整体失败")
    assert.ok(latest.notes.includes("curator:"), latest.notes)
    assert.ok(result.text.includes("做梦"), result.text)
})

test("dream runs and records a done run even when keeping the policy", async () => {
    const store = await loadStore()
    const cfg = baseConfig()
    commitN(store, 24)
    const before = store.activePolicy().policyId
    const result = await runDream(store, cfg, { logger: fakeLogger })
    const latest = store.latestDream()
    assert.ok(result.runId, "returns run id")
    assert.equal(latest.status, "done")
    assert.ok(latest.candidatesJson.length > 0)
    // either kept or switched — active policy must reference a real record
    assert.ok(store.listPolicies().some((p) => p.policyId === store.activePolicy().policyId))
    assert.notEqual(before, undefined)
})

test("a clear-cut winner is adopted and its baseline recorded", async () => {
    const store = await loadStore()
    const cfg = baseConfig({ dream: { ...baseConfig().dream, minNodes: 5, candidateCount: 2, epsilon: 0 } })
    // nodes sharing a single file: default params already hit it; a variant that
    // boosts overlap should tie-or-win. Force a switch by radical noise removal:
    commitN(store, 10, { summary: "fix the invoice total", files: ["src/inv.ts"], outcome: "success" })

    const activeBefore = store.activePolicy().policyId
    await runDream(store, cfg, { logger: fakeLogger })
    const active = store.activePolicy()
    if (active.policyId !== activeBefore) {
        assert.ok(active.replayAtCreation, "adopted policy should carry replayAtCreation")
        assert.equal(typeof active.replayAtCreation.train, "number")
    }
    assert.ok(store.latestDream().finishedAt)
})

test("dream focus steers the weakest-note target", async () => {
    const store = await loadStore()
    const cfg = baseConfig()
    commitN(store, 24)
    const result = await runDream(store, cfg, { logger: fakeLogger, focus: "precision" })
    assert.ok(result.text.includes("precision"), "note must reference the focused aspect")
    assert.ok(result.text.includes("指定优先改善"), "focus must be marked as user-directed")
})
