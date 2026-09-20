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

test("search_history_experience defaults limit to policy maxRecall, not 1", async () => {
    const store = await loadStore()
    commitN(store, 7, { summary: "fix the billing amount overflow", files: ["src/billing.ts"] })
    const text = await tools(store).search_history_experience.execute({ query: "billing" }, ctx())
    const bullets = (text.match(/•/g) ?? []).length
    assert.ok(bullets >= 2, `default limit should pull several hits, got ${bullets}`)
    assert.ok(!/检索得 1 条/.test(text), "default must not collapse to a single hit")
})

test("search_history_experience clamps explicit limits to 1..10", async () => {
    const store = await loadStore()
    commitN(store, 12, { summary: "schema migration", files: ["src/db.ts"] })
    const text = await tools(store).search_history_experience.execute({ query: "migration", limit: 0 }, ctx())
    assert.ok(/检索得 1 条/.test(text), "limit 0 should clamp to 1")
})