import test from "node:test"
import assert from "node:assert/strict"
import { extractNodeFields } from "../dist/lib/capture.js"

test("extractNodeFields: summary from assistantText, truncated to 60 chars", () => {
    const long = "A".repeat(200)
    const fields = extractNodeFields({ userText: "user question", assistantText: long, tools: [] })
    assert.equal(fields.summary.length, 60)
    assert.ok(fields.summary.startsWith("A"))
})

test("extractNodeFields: falls back to userText when assistantText empty", () => {
    const fields = extractNodeFields({ userText: "fix the billing overflow", assistantText: "", tools: [] })
    assert.ok(fields.summary.includes("billing"))
})

test("extractNodeFields: （无内容） when nothing captured", () => {
    const fields = extractNodeFields({ userText: "", assistantText: "", tools: [] })
    assert.equal(fields.summary, "（无内容）")
})

test("extractNodeFields: any tool error → failed + why/errorMessage", () => {
    const fields = extractNodeFields({
        userText: "",
        assistantText: "try npm build",
        tools: [
            { tool: "edit", error: undefined },
            { tool: "bash", error: "failed" },
        ],
    })
    assert.equal(fields.outcome, "failed")
    assert.equal(fields.errorMessage, "failed")
    assert.ok(fields.why.length > 0 && fields.why.length <= 80)
})

test("extractNodeFields: all tools OK → success, no why", () => {
    const fields = extractNodeFields({
        userText: "",
        assistantText: "all green",
        tools: [{ tool: "edit" }, { tool: "bash" }],
    })
    assert.equal(fields.outcome, "success")
    assert.equal(fields.why, undefined)
    assert.equal(fields.errorMessage, undefined)
})

test("extractNodeFields: no tools → partial", () => {
    const fields = extractNodeFields({ userText: "just asking", assistantText: "maybe", tools: [] })
    assert.equal(fields.outcome, "partial")
})