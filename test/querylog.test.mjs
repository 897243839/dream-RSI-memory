import test from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, readFileSync } from "node:fs"
import { queryLogPath, readQueryLog } from "../dist/lib/querylog.js"
import { runReplay } from "../dist/lib/replay.js"
import { statusText } from "../dist/lib/report.js"
import { baseConfig, commitN, fakeLogger, loadStore } from "./helpers.mjs"

function line(entry) {
    return JSON.stringify({
        ts: new Date().toISOString(),
        turnIndex: null,
        query: "q",
        policyId: "p-default",
        trigger: "tool",
        results: [],
        ...entry,
    })
}

test("queryLog 落盘：三个用户面出口写入，内部评估不写", async () => {
    const store = await loadStore()
    commitN(store, 3, { files: ["src/billing.ts"], summary: "billing fix" })
    const cfg = baseConfig()

    store.search("billing fix", ["src/billing.ts"], { limit: 3, log: { trigger: "tool" } })
    let logs = readQueryLog(store.getProjectDir())
    assert.equal(logs.length, 1)
    assert.equal(logs[0].trigger, "tool")
    assert.equal(logs[0].query, "billing fix")
    assert.equal(logs[0].policyId, "p-default")
    assert.equal(typeof logs[0].turnIndex, "number", "turnIndex 可拿到时必记")
    assert.ok(logs[0].results.length > 0)
    assert.equal(logs[0].results[0].rank, 1)

    store.search("no trigger", [], { limit: 3 }) // 无 log 选项 → 不写
    runReplay(store, store.activePolicy().params, { trainRatio: 0.8, weights: cfg.replayWeights }) // 内部评估 → 不写
    const status = statusText(store, cfg)
    assert.ok(status.includes("在线战绩 p-default"), "status 输出每策略在线战绩")
    logs = readQueryLog(store.getProjectDir())
    assert.equal(logs.length, 1, "内部评估/无 log 检索不得落盘")
})

test("queryLogMax 超限裁最旧", async () => {
    const cfg = baseConfig({ queryLogMax: 3 })
    const store = await loadStore(cfg)
    commitN(store, 2, { files: ["src/billing.ts"], summary: "billing fix" })
    for (let i = 0; i < 5; i++) {
        store.search(`q${i}`, [], { limit: 3, log: { trigger: "command" } })
    }
    const lines = readFileSync(queryLogPath(store.getProjectDir()), "utf8").trim().split("\n")
    assert.equal(lines.length, 3, "上限 3 行")
    assert.equal(JSON.parse(lines[0]).query, "q2", "裁掉最旧的 q0/q1")
    assert.equal(JSON.parse(lines[2]).query, "q4", "保留最新")
})

test("replay 真实用例：不足阈值回退现状，达到阈值并入 train", async () => {
    const store = await loadStore()
    const cfg = baseConfig()
    // 交替的成功节点（billing/auth），带文件路径 → 标签集可构造
    for (let i = 0; i < 12; i++) {
        const auth = i % 2 === 1
        store.commit({
            summary: auth ? "rotate auth token payload" : "compute billing invoice total",
            outcome: "success",
            files: [auth ? "src/auth.ts" : "src/billing.ts"],
            sessionId: "s",
            agentName: "build",
        })
    }
    const params = store.activePolicy().params
    const base = runReplay(store, params, { trainRatio: 0.8, weights: cfg.replayWeights })
    const optsReal = {
        trainRatio: 0.8,
        weights: cfg.replayWeights,
        queryLog: { windowTurns: 50, minRealQueries: 10 },
    }
    const file = queryLogPath(store.getProjectDir())

    // 只有 1 条真实查询 → 低于 replayMinRealQueries=10 → 回退（与现状完全一致）
    appendFileSync(file, line({ query: "fix src/billing.ts error", turnIndex: 3 }) + "\n", "utf8")
    const few = runReplay(store, params, optsReal)
    assert.equal(few.realCases, 0, "不足阈值不加真实用例")
    assert.equal(few.train.totalScore, base.train.totalScore, "回退后 train 与现状一致")
    assert.equal(few.valid.totalScore, base.valid.totalScore)

    // 补足到 10 条（含 1 条 turnIndex 缺失 → 按 ts 映射）
    for (let i = 0; i < 9; i++) {
        appendFileSync(
            file,
            line({
                query: i % 2 === 0 ? "fix src/billing.ts error" : "rotate src/auth.ts token",
                turnIndex: i === 8 ? null : i,
            }) + "\n",
            "utf8",
        )
    }
    const many = runReplay(store, params, optsReal)
    assert.ok(many.realCases >= 10, `真实用例应并入 train，实际 ${many.realCases}`)
    assert.notEqual(many.train.totalScore, base.train.totalScore, "并入真实用例后 train 指标应变化")
    // 有效回放与旧口径不变（真实用例只并入 train，valid 仍是合成 holdout）
    assert.equal(many.valid.totalScore, base.valid.totalScore)

    // query 提不出文件路径的条目被跳过（不计入 realCases 的评估）
    appendFileSync(file, line({ query: "no path here at all", turnIndex: 6 }) + "\n", "utf8")
    const withBad = runReplay(store, params, optsReal)
    assert.ok(withBad.realCases >= 10, "坏条目被跳过但不破坏回放")
})
