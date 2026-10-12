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

test("验收 13（P1-4）：同一批经验节点，库中有/无策略节点的 replay 数值必须完全一致", async () => {
    const opts = {
        trainRatio: 0.8,
        weights: { fileHitRate: 0.35, failureAvoidRate: 0.25, precision: 0.25, recallBudget: 0.15 },
    }
    const sess = "s-replay-equiv"

    const build = async (withStrategy) => {
        const store = await loadStore()
        for (let i = 0; i < 10; i++) {
            const auth = i % 2 === 1
            store.commit({
                summary: auth ? "rotate auth token payload" : "compute billing invoice total",
                outcome: i % 5 === 4 ? "failed" : "success",
                files: [auth ? "src/auth.ts" : "src/billing.ts"],
                sessionId: sess,
                agentName: "build",
            })
        }
        if (withStrategy) {
            // 策略节点追加在经验时间线**之后**：经验节点的 turnIndex 与相互先后完全不变，
            // 因此两份库的经验口径必须逐项相等（策略节点只是多出来的干扰项）。
            store.proposeStrategySet({
                problem: "同一批数据下要不要引入策略节点",
                alts: [
                    { name: "with-set", approach: "先引入再观察", tradeoffs: "有额外噪声", estimatedRisk: "低" },
                    { name: "no-set", approach: "保持现状", tradeoffs: "错过结构化收益", estimatedRisk: "低" },
                    { name: "half-set", approach: "只在选型时引入", tradeoffs: "口径复杂", estimatedRisk: "中" },
                ],
                provisionalPick: "with-set",
                sessionId: sess,
                agentName: "build",
            })
        }
        return store
    }

    const plain = await build(false)
    const enriched = await build(true)

    // 前置：两份库经验数相同，enriched 额外多出 set/alt/note 节点
    assert.equal(plain.count(), 10)
    assert.equal(enriched.count(), 10, "策略节点不得计入经验数")
    assert.ok(
        enriched.sortedNodes().length > plain.sortedNodes().length,
        "前置：带策略节点的库必须确实多出 set/alt/note 节点",
    )

    const params = { ...plain.activePolicy().params }
    const r1 = runReplay(plain, params, opts)
    const r2 = runReplay(enriched, params, opts)

    assert.equal(r2.n, r1.n, `replay 口径的节点数不得被策略节点虚增：${r1.n} vs ${r2.n}`)
    assert.equal(r2.splitIndex, r1.splitIndex, `train/valid 切分点不得被策略节点挪动：${r1.splitIndex} vs ${r2.splitIndex}`)
    assert.equal(r2.realCases, r1.realCases, "realCases 用例数必须一致")

    assert.ok(r1.valid, "前置：10 节点 / 0.8 切分下 valid 块非空")
    assert.ok(r2.valid, "前置：带策略节点的 valid 块同样非空")

    const keys = ["fileHitRate", "failureAvoidRate", "precision", "recallBudget", "totalScore"]
    for (const key of keys) {
        assert.ok(
            Math.abs(r2.train[key] - r1.train[key]) < 1e-12,
            `train.${key} 必须一致：${r1.train[key]} vs ${r2.train[key]}`,
        )
        assert.ok(
            Math.abs(r2.valid[key] - r1.valid[key]) < 1e-12,
            `valid.${key} 必须一致：${r1.valid[key]} vs ${r2.valid[key]}`,
        )
    }
})