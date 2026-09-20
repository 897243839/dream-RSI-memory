import test from "node:test"
import assert from "node:assert/strict"
import { clampParams, normalizeProjectPath, stripJsonc } from "../dist/lib/utils.js"
import { fileOverlap, tokenizeText } from "../dist/lib/scoring.js"

test("clampParams clamps and rounds", () => {
    const p = clampParams({
        fileOverlapWeight: 2,
        ftsScoreWeight: -1,
        successBoost: 1,
        failureBoost: 1,
        recencyHalfLife: 1,
        maxRecall: 50,
        minScore: -3,
    })
    assert.equal(p.fileOverlapWeight, 1)
    assert.equal(p.ftsScoreWeight, 0)
    assert.equal(p.failureBoost, 0.5)
    assert.equal(p.maxRecall, 10)
    assert.equal(p.minScore, 0)
})

test("normalizeProjectPath: relative, win32 lowercase, traversal rejected", () => {
    assert.equal(normalizeProjectPath("C:/proj", "C:\\proj\\src\\A.TS"), "src/a.ts")
    assert.equal(normalizeProjectPath("C:/proj", "../../etc/passwd"), null)
    assert.equal(normalizeProjectPath("C:/proj", "C:/proj"), null)
})

test("tokenizeText produces CJK bigrams", () => {
    const tokens = tokenizeText("解析数据库")
    assert.ok(tokens.has("解析"))
    assert.ok(tokens.has("数据"))
})

test("fileOverlap symmetric share", () => {
    assert.equal(fileOverlap(["a.ts", "b.ts"], ["b.ts", "c.ts"]), 0.5)
    assert.equal(fileOverlap([], ["a.ts"]), 0)
})

test("stripJsonc removes comments and trailing commas", () => {
    const parsed = JSON.parse(stripJsonc('{ "a": 1, // plain\n "b": 2, }'))
    assert.deepEqual(parsed, { a: 1, b: 2 })
})