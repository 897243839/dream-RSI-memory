import test from "node:test"
import assert from "node:assert/strict"
import { commitN, loadStore } from "./helpers.mjs"

test("commit chains parent/branch and keeps turn order", async () => {
    const store = await loadStore()
    const c1 = store.commit({ summary: "one", files: ["a.ts"], sessionId: "s", agentName: "build" })
    const c2 = store.commit({ summary: "two", files: ["b.ts"], sessionId: "s", agentName: "build" })
    const c3 = store.commit({ summary: "three", files: ["c.ts"], sessionId: "s", agentName: "build", branchId: "br1" })
    assert.equal(c1.parentId, undefined)
    assert.equal(c2.parentId, c1.nodeId)
    assert.equal(c3.parentId, c2.nodeId)
    assert.equal(c3.branchId, "br1")
    assert.equal(store.count(), 3)
    assert.deepEqual(store.sortedNodes().map((n) => n.nodeId), [c1.nodeId, c2.nodeId, c3.nodeId])
})

test("search prefers file-overlap hits", async () => {
    const store = await loadStore()
    commitN(store, 3, { summary: "migrate db", files: ["src/db.ts"] })
    // newer node with matched topic but different file
    store.commit({ summary: "migrate db again", files: ["src/other.ts"], sessionId: "s2", agentName: "build" })
    const hits = store.search("migrate db", ["src/db.ts"], { limit: 5 })
    assert.ok(hits.length > 0)
    assert.equal(hits[0].node.files[0], "src/db.ts")
})

test("search respects minScore and limit", async () => {
    const store = await loadStore()
    commitN(store, 12, { summary: "alpha beta gamma delta" })
    const hits = store.search("billing", [], { limit: 2 })
    assert.ok(hits.length <= 2)
    // an unrelated query matches nothing textually, so only boosted recent successes
    // may float over the default gate — never all nodes, and none textually related
    const none = store.search("zzznosuchtermzz", [])
    assert.ok(none.length < 12)
    assert.ok(none.every((h) => !h.node.summary.includes("zzz")))
    // a strict gate filters everything (unrelated query: only 0.05 boosts exist)
    assert.equal(store.search("zzznosuchtermzz", [], { minScore: 0.9 }).length, 0)
})

test("works across policy switch: new params take effect", async () => {
    const store = await loadStore()
    commitN(store, 6, { summary: "schema migration" })
    const cap = store.activePolicy().params.maxRecall
    const wide = { ...store.activePolicy().params, maxRecall: 10 }
    store.patchNodePolicy("p-wide", wide, store.activePolicy().policyId)
    assert.equal(store.activePolicy().policyId, "p-wide")
    const hits = store.search("schema migration", [], { limit: 10 })
    assert.ok(hits.length > cap, `expected more hits with maxRecall=10 (got ${hits.length}, old cap ${cap})`)
})

test("lastNodeCommittedAtMs + watchdogNotice", async () => {
    const store = await loadStore()
    const node = store.commit({ summary: "x", files: ["a.ts"], sessionId: "sess", agentName: "build" })
    const t = store.lastNodeCommittedAtMs("sess")
    assert.ok(t !== null && t <= Date.now())
    assert.equal(store.lastNodeCommittedAtMs("other"), null)

    store.patchPolicyMeta("p-default", { replayAtCreation: { train: 0.9, valid: null } })
    assert.ok(store.watchdogNotice("p-default", 0.5, 0.02).includes("退化"))
    assert.equal(store.watchdogNotice("p-default", 0.95, 0.02), "")
    assert.equal(store.watchdogNotice("nope", 0.5, 0.02), "")
})