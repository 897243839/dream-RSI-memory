import test from "node:test"
import assert from "node:assert/strict"
import { runReplay, splitIndex } from "../dist/lib/replay.js"
import { commitN, loadStore } from "./helpers.mjs"

test("splitIndex", () => {
    assert.equal(splitIndex(10, 0.8), 8)
    assert.equal(splitIndex(3, 0.8), 2)
    assert.equal(splitIndex(0, 0.8), 0)
})

test("runReplay strict-timeline shape", async () => {
    const store = await loadStore()
    for (let i = 0; i < 6; i++) {
        store.commit({
            summary: "debug auth middleware for user payload",
            outcome: i === 2 ? "failed" : "partial",
            files: ["src/auth.ts"],
            sessionId: "s",
            agentName: "build",
        })
    }
    const opts = { trainRatio: 0.8, weights: { fileHitRate: 0.35, failureAvoidRate: 0.25, precision: 0.25, recallBudget: 0.15 } }
    const params = { ...store.activePolicy().params }
    const report = runReplay(store, params, opts)
    assert.equal(report.n, 6)
    assert.equal(report.splitIndex, 4)
    assert.ok(report.train.totalScore >= 0)
    assert.ok(report.valid, "valid chunk expected when n>split")
    // identical histories of a shared file should yield a positive fileHitRate
    assert.ok(report.train.fileHitRate > 0)
})

test("runReplay returns valid=null when the chunk is degenerate", async () => {
    const store = await loadStore()
    commitN(store, 3)
    const opts = { trainRatio: 1, weights: { fileHitRate: 0.35, failureAvoidRate: 0.25, precision: 0.25, recallBudget: 0.15 } }
    const report = runReplay(store, { ...store.activePolicy().params }, opts)
    assert.equal(report.valid, null)
})