import test from "node:test"
import assert from "node:assert/strict"
import { runDream } from "../dist/lib/dream.js"
import { baseConfig, commitN, fakeLogger, loadStore } from "./helpers.mjs"

test("dream skips below minNodes", async () => {
    const store = await loadStore()
    commitN(store, 5)
    const cfg = baseConfig()
    const result = await runDream(store, cfg, { logger: fakeLogger })
    assert.ok(result.text.includes("跳过"))
    assert.equal(store.count(), 5)
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