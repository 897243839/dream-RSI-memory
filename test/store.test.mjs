import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { commitN, loadStore, baseConfig } from "./helpers.mjs"

async function flush() {
    await new Promise((r) => setTimeout(r, 50))
}

function readJson(file) {
    return JSON.parse(readFileSync(file, "utf8"))
}

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

test("persists as index.json + one session file per session", async () => {
    const config = baseConfig()
    const store = await loadStore(config)
    commitN(store, 4, { sessionId: "sess-a" })
    commitN(store, 2, { sessionId: "sess-b" })
    await flush()

    const projectDir = join(config.dataDir, "tproj")
    const indexFile = join(projectDir, "index.json")
    const sessionsDir = join(projectDir, "sessions")
    assert.ok(existsSync(indexFile), "index.json missing")
    assert.ok(existsSync(sessionsDir), "sessions dir missing")

    const index = readJson(indexFile)
    assert.equal(index.version, 2)
    assert.equal(index.projectId, "tproj")
    assert.ok(index.policies["p-default"], "index must keep policies")
    assert.equal("nodes" in index, false, "index must not embed node data")
    assert.equal("order" in index, false, "index must not embed order")
    assert.equal("nextTurnIndex" in index, false, "turn sequence must be derived from nodes")

    const partFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))
    assert.equal(partFiles.length, 2, "one file per distinct session")
    const bySession = new Map()
    for (const f of partFiles) {
        const part = readJson(join(sessionsDir, f))
        assert.equal(part.version, 2)
        for (const node of part.nodes) {
            bySession.set(node.sessionId, (bySession.get(node.sessionId) ?? 0) + 1)
        }
    }
    assert.equal(bySession.get("sess-a"), 4)
    assert.equal(bySession.get("sess-b"), 2)
    assert.equal(store.count(), 6)
})

test("migrates a legacy v1 memory.json into the v2 layout", async () => {
    const config = baseConfig()
    const projectDir = join(config.dataDir, "tproj")
    mkdirSync(projectDir, { recursive: true })
    const node = {
        nodeId: "n-legacy1",
        projectId: "tproj",
        sessionId: "old-session",
        agentName: "build",
        summary: "legacy memory",
        outcome: "success",
        files: ["src/legacy.ts"],
        turnIndex: 0,
        createdAt: new Date().toISOString(),
    }
    writeFileSync(
        join(projectDir, "memory.json"),
        JSON.stringify({
            version: 1,
            projectId: "tproj",
            rootPath: "C:/proj",
            createdAt: new Date().toISOString(),
            nextTurnIndex: 1,
            nodes: { "n-legacy1": node },
            order: ["n-legacy1"],
            policies: { "p-default": { code: "params", params: { fileOverlapWeight: 0.5, ftsScoreWeight: 0.3, successBoost: 0.1, failureBoost: 0.25, recencyHalfLife: 50, maxRecall: 5, minScore: 0.05 }, isActive: true, dreamRound: 0, createdAt: new Date().toISOString() } },
            activePolicyId: "p-default",
            dreamRuns: {},
        }),
        "utf8",
    )

    const store = await loadStore(config)
    assert.equal(store.count(), 1)
    assert.equal(store.sortedNodes()[0].summary, "legacy memory")
    // next load reads the v2 layout, not memory.json
    const reloaded = await loadStore(config)
    assert.equal(reloaded.count(), 1)
    assert.equal(reloaded.search("legacy", []).length, 1)
})

test("rebuilds from session files when index.json is lost", async () => {
    const config = baseConfig()
    const store = await loadStore(config)
    const ids = commitN(store, 3, { sessionId: "sess-a", summary: "alpha billing fix" })
    const last = store.commit({ summary: "beta db migration", files: ["src/db.ts"], sessionId: "sess-b", agentName: "build" })
    await flush()

    const indexFile = join(config.dataDir, "tproj", "index.json")
    assert.ok(existsSync(indexFile), "precondition: index.json exists")
    rmSync(indexFile, { force: true })

    const recovered = await loadStore(config)
    assert.equal(recovered.count(), 4, "all nodes recovered from sessions/")
    const summaries = recovered.sortedNodes().map((n) => n.summary)
    assert.ok(summaries.includes("alpha billing fix"))
    assert.ok(summaries.includes("beta db migration"))
    assert.deepEqual(recovered.latestNode().files, ["src/db.ts"])
    assert.equal(recovered.latestNode().parentId, undefined, "cross-session chain must not survive recovery either")
    // recovered index must be persisted so the next load hits the V2 path
    assert.ok(existsSync(indexFile), "recovered index.json persisted on reload")
})

test("commit chains within the same session by default", async () => {
    const store = await loadStore()
    const a1 = store.commit({ summary: "one", files: ["a.ts"], sessionId: "sess-a", agentName: "build" })
    const a2 = store.commit({ summary: "two", files: ["b.ts"], sessionId: "sess-a", agentName: "build" })
    // a different session, no explicit parentId → must NOT inherit sess-a's latest
    const b1 = store.commit({ summary: "three", files: ["c.ts"], sessionId: "sess-b", agentName: "build" })
    const b2 = store.commit({ summary: "four", files: ["d.ts"], sessionId: "sess-b", agentName: "build" })
    assert.equal(a2.parentId, a1.nodeId)
    assert.equal(b1.parentId, undefined, "cross-session must not auto-chain")
    assert.equal(b2.parentId, b1.nodeId)
    assert.equal(store.latestNode().nodeId, b2.nodeId)
})

test("reload round-trips turn order across sessions", async () => {
    const config = baseConfig()
    const store = await loadStore(config)
    const ids = commitN(store, 3, { sessionId: "sess-x" }).map((n) => n.nodeId)
    store.commit({ summary: "later", files: ["y.ts"], sessionId: "sess-y", agentName: "build" })
    await flush()

    const reloaded = await loadStore(config)
    assert.equal(reloaded.count(), 4)
    assert.deepEqual(reloaded.sortedNodes().map((n) => n.nodeId), [...ids, reloaded.latestNode().nodeId])
    assert.ok(reloaded.latestNode().sessionId === "sess-y")
})