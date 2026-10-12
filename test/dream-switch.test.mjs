import test from "node:test"
import assert from "node:assert/strict"
import { runDream } from "../dist/lib/dream.js"
import { buildChildIndex, descendantsOf, scoreSubtree } from "../dist/lib/strategy.js"
import { baseConfig, commitN, fakeLogger, loadStore } from "./helpers.mjs"

/**
 * 设计方案 §10 验收 14：dream 全自动分支切换（runDream 末尾的 evaluateStrategyBranches）。
 *
 * 被测行为：
 * - 每个 strategy_set 的 alt 做 Wilson 子树打分（partial 半权，子树样本 <3 → score=null 不参与）
 * - 取前两名，margin = best - second；margin > 0.15 写 AdviceRecord
 * - 同时满足 §4.8 四条件（margin > 0.2 / best.n ≥ 5 / best ≠ 当前 chosen / 本会话确有 active alt）
 *   → 复用 pickStrategy 自动切换，旧 chosen 变 superseded，子树 outcome 一个都不改
 *
 * 数据形状约定（见 makeSet/plant）：set 下挂 2 个 alt，alt 的显式 parentId/branchId 都指向
 * 自身，经验节点再挂到 alt 上 → descendantsOf(alt) 正好就是该分支的子树。
 */

const SESSION = "sess-strategy"

/** 合法 AltCandidate（字段长度都在 §5.1 限长内）。 */
function altCandidate(name) {
    return { name, approach: `${name} 的落地路径`, tradeoffs: "快但糙", estimatedRisk: "低" }
}

/** 建 1 个 set + 2 个 alt；可选先 pick 一个，让会话有 active alt（§4.8 条件 3）。 */
function makeSet(store, { sessionId = SESSION, pickName } = {}) {
    const { setId, altIds } = store.proposeStrategySet({
        problem: "选哪个缓存方案",
        alts: [altCandidate("方案A"), altCandidate("方案B")],
        sessionId,
        agentName: "build",
    })
    if (pickName) {
        const picked = store.pickStrategy({ setId, altName: pickName, reason: "先走这条", sessionId, agentName: "build" })
        assert.ok(picked, `pick ${pickName} 应成功（前置条件）`)
    }
    return { setId, altIds }
}

/** 往指定 alt 下挂一串经验节点：显式 parentId + branchId，绕开 active alt 的自动挂靠。 */
function plant(store, altId, outcomes, sessionId = SESSION) {
    const ids = []
    for (const outcome of outcomes) {
        const node = store.commit({
            summary: `经验 ${outcome}`,
            outcome,
            files: ["src/cache.ts"],
            sessionId,
            agentName: "build",
            parentId: altId,
            branchId: altId,
        })
        ids.push(node.nodeId)
    }
    return ids
}

/** 用与 dream 内部完全相同的纯函数算某个 alt 的子树分。 */
function scoreOf(store, altId) {
    const idx = buildChildIndex(store.sortedNodes())
    return scoreSubtree(descendantsOf(idx, altId))
}

function statuses(store, altIds) {
    return altIds.map((id) => store.getNode(id)?.status)
}

function setMeta(store, setId) {
    const meta = store.listSetMetas().find((m) => m.setId === setId)
    assert.ok(meta, `set ${setId} 应在 listSetMetas 中`)
    return meta
}

function snapshotOutcomes(store) {
    return new Map(store.sortedNodes().map((n) => [n.nodeId, n.outcome]))
}

/* ------------------------------------------------------------------ 主场景 */

test("主场景：分差 > 0.2 → 自动切换（chosen 换成高分分支，旧分支 superseded，子树 outcome 不变）", async () => {
    const store = await loadStore()
    // 先 pick 低分的方案B：会话有 active alt，且满足「best ≠ 当前 chosen」
    const { setId, altIds } = makeSet(store, { pickName: "方案B" })
    const [altA, altB] = altIds
    plant(store, altA, ["success", "success", "success", "success", "success"])
    plant(store, altB, ["failed", "failed", "failed", "failed", "failed"])

    // 数据形状：altA 子树 5×success → Wilson(5/5, z=1)=0.833；altB 子树 5×failed → Wilson(0/5)=0
    // → margin = 0.833 - 0 = 0.833 > 0.2，且 best.n = 5 ≥ 5
    const sA = scoreOf(store, altA)
    const sB = scoreOf(store, altB)
    assert.equal(sA.n, 5, "altA 子树应有 5 个经验样本")
    assert.equal(sB.n, 5, "altB 子树应有 5 个经验样本")
    assert.ok((sA.score ?? 0) - (sB.score ?? 0) > 0.2, `构造的分差需 > 0.2：${sA.score} - ${sB.score}`)
    assert.equal(store.resolveActiveAlt(SESSION)?.nodeId, altB, "前置条件：本会话 active alt = 方案B")

    const before = snapshotOutcomes(store)
    const result = await runDream(store, baseConfig(), { logger: fakeLogger, sessionId: SESSION })

    // 1) 变 chosen 的是 score 更高的那个
    assert.equal(store.getNode(altA).status, "chosen", "高分分支应变 chosen")
    // 2) 旧 chosen 变 superseded
    assert.equal(store.getNode(altB).status, "superseded", "旧 chosen 应让位为 superseded")
    assert.equal(setMeta(store, setId).chosenAltId, altA, "set.chosenAltId 应指向高分分支")
    assert.equal(store.resolveActiveAlt(SESSION)?.nodeId, altA, "切换后会话 active alt 变成方案A")

    // 3) 切换只改 status：所有既有节点的 outcome 一个都不能变（只多出 1 条 pick 轨迹节点）
    const after = snapshotOutcomes(store)
    assert.equal(after.size, before.size + 1, "自动切换只应新增 1 条 strategy_note 轨迹节点")
    for (const [nodeId, outcome] of before) {
        assert.equal(after.get(nodeId), outcome, `节点 ${nodeId} 的 outcome 不得被切换改动`)
    }
    assert.equal(after.get(altB), "partial", "被降级分支自身的占位 outcome 也不变")

    // 4) adviceLog 有记录且 autoSwitched === true
    const log = store.getAdviceLog()
    assert.equal(log.length, 1, "应写入 1 条 AdviceRecord")
    assert.equal(log[0].autoSwitched, true)
    assert.equal(log[0].setId, setId)
    assert.equal(log[0].recommendedAltId, altA, "推荐的应是高分分支")
    assert.equal(log[0].nBest, 5)
    assert.equal(log[0].nSecond, 5)
    assert.ok(log[0].margin > 0.2, `margin=${log[0].margin}`)
    assert.ok(result.text.includes("策略库分支评估"), result.text)
    assert.ok(result.text.includes("已自动切换"), result.text)
})

/* --------------------------------------------------------- 不切换的边界条件 */

test("边界：margin ∈ (0.15, 0.2] → 只写 advice（autoSwitched=false），status 不变", async () => {
    const store = await loadStore()
    const { setId, altIds } = makeSet(store, { pickName: "方案B" })
    const [altA, altB] = altIds
    // n=5, s=3 → Wilson(3/5)=0.3826；n=5, s=2 → Wilson(2/5)=0.2160；margin≈0.1667 ∈ (0.15, 0.2]
    plant(store, altA, ["success", "success", "success", "failed", "failed"])
    plant(store, altB, ["success", "success", "failed", "failed", "failed"])

    const margin = (scoreOf(store, altA).score ?? 0) - (scoreOf(store, altB).score ?? 0)
    assert.ok(margin > 0.15 && margin <= 0.2, `构造的 margin 需落在 (0.15, 0.2]：${margin}`)

    const result = await runDream(store, baseConfig(), { logger: fakeLogger, sessionId: SESSION })

    const log = store.getAdviceLog()
    assert.equal(log.length, 1, "margin > 0.15 → 必须写 advice")
    assert.equal(log[0].autoSwitched, false, "margin ≤ 0.2 → 不得自动切换")
    assert.equal(log[0].recommendedAltId, altA)
    assert.ok(log[0].margin > 0.15 && log[0].margin <= 0.2, `margin=${log[0].margin}`)
    assert.deepEqual(statuses(store, altIds), ["unproven", "chosen"], "status 必须原样不动")
    assert.equal(setMeta(store, setId).chosenAltId, altB)
    assert.ok(result.text.includes("策略库分支评估"), result.text)
    assert.ok(!result.text.includes("已自动切换"), result.text)
})

test("不切（条件3）：不传 sessionId 时即使 margin > 0.2 也不切换", async () => {
    const store = await loadStore()
    const { setId, altIds } = makeSet(store, { pickName: "方案B" })
    const [altA, altB] = altIds
    plant(store, altA, ["success", "success", "success", "success", "success"])
    plant(store, altB, ["failed", "failed", "failed", "failed", "failed"])

    const result = await runDream(store, baseConfig(), { logger: fakeLogger }) // ← 不传 sessionId

    const log = store.getAdviceLog()
    assert.equal(log.length, 1, "advice 照写")
    assert.equal(log[0].autoSwitched, false, "无 active alt（缺 sessionId）→ 不切换")
    assert.ok(log[0].margin > 0.2, `margin=${log[0].margin} 应已过 0.2，失败原因只能是条件3`)
    assert.deepEqual(statuses(store, altIds), ["unproven", "chosen"])
    assert.equal(setMeta(store, setId).chosenAltId, altB)
    assert.ok(result.text.includes("策略库分支评估"), result.text)
    assert.ok(!result.text.includes("已自动切换"), result.text)
})

test("不切（条件3）：传了 sessionId 但该会话从未 pick 过 → 也不切换", async () => {
    const store = await loadStore()
    const { setId, altIds } = makeSet(store, { pickName: "方案B" }) // pick 落在 SESSION
    const [altA, altB] = altIds
    plant(store, altA, ["success", "success", "success", "success", "success"])
    plant(store, altB, ["failed", "failed", "failed", "failed", "failed"])
    assert.equal(store.resolveActiveAlt("sess-never-picked"), null, "前置条件：该会话无 active alt")

    const result = await runDream(store, baseConfig(), { logger: fakeLogger, sessionId: "sess-never-picked" })

    const log = store.getAdviceLog()
    assert.equal(log.length, 1)
    assert.equal(log[0].autoSwitched, false, "会话没 pick 过 → 不切换")
    assert.deepEqual(statuses(store, altIds), ["unproven", "chosen"])
    assert.equal(setMeta(store, setId).chosenAltId, altB)
    assert.ok(!result.text.includes("已自动切换"), result.text)
})

test("不切（条件4）：best.n < 5 时即使 margin > 0.2 也不切换", async () => {
    const store = await loadStore()
    const { setId, altIds } = makeSet(store, { pickName: "方案B" })
    const [altA, altB] = altIds
    // 各 3 个样本：够打分门槛（n ≥ 3），但不够自动切换门槛（n < 5）
    plant(store, altA, ["success", "success", "success"])
    plant(store, altB, ["failed", "failed", "failed"])

    const sA = scoreOf(store, altA)
    const sB = scoreOf(store, altB)
    assert.equal(sA.n, 3)
    assert.equal(sB.n, 3)
    assert.ok((sA.score ?? 0) - (sB.score ?? 0) > 0.2, `margin 需 > 0.2：${sA.score} - ${sB.score}`)
    assert.ok(sA.n < 5, "best.n 必须 < 5，失败原因只能是样本量条件")

    const result = await runDream(store, baseConfig(), { logger: fakeLogger, sessionId: SESSION })

    const log = store.getAdviceLog()
    assert.equal(log.length, 1, "margin > 0.15 → advice 照写")
    assert.equal(log[0].autoSwitched, false, "best.n < 5 → 不得自动切换")
    assert.equal(log[0].nBest, 3)
    assert.ok(log[0].margin > 0.2, `margin=${log[0].margin}`)
    assert.deepEqual(statuses(store, altIds), ["unproven", "chosen"])
    assert.equal(setMeta(store, setId).chosenAltId, altB)
    assert.ok(result.text.includes("策略库分支评估"), result.text)
    assert.ok(!result.text.includes("已自动切换"), result.text)
})

/* ------------------------------------------------------------ 幂等 / 无 set */

test("库内没有任何 strategy_set：runDream 与改造前一致（不报错、无分支评估文案、不写 advice）", async () => {
    // S 播种期路径（evaluateStrategyBranches 也在 early-return 前跑）
    const sStore = await loadStore()
    commitN(sStore, 4)
    const sResult = await runDream(sStore, baseConfig(), { logger: fakeLogger, sessionId: SESSION })
    assert.ok(sResult.text.includes("证据不足"), sResult.text)
    assert.ok(!sResult.text.includes("策略库分支评估"), `无 set 不得出现分支评估文案：${sResult.text}`)
    assert.equal(sStore.getAdviceLog().length, 0)
    assert.equal(sStore.latestDream().status, "done")

    // M 试用期路径
    const mStore = await loadStore()
    commitN(mStore, 10)
    const mResult = await runDream(mStore, baseConfig(), { logger: fakeLogger, sessionId: SESSION })
    assert.ok(mResult.text.includes("做梦完成"), mResult.text)
    assert.ok(!mResult.text.includes("策略库分支评估"), `无 set 不得出现分支评估文案：${mResult.text}`)
    assert.equal(mStore.getAdviceLog().length, 0)
    assert.equal(mStore.latestDream().status, "done")
    assert.equal(mStore.listSetMetas().length, 0, "前置条件：库里确实没有 strategy_set")
})

/* ---------------------------------------------------------- P1-5 rejected 分支 */

test("P1-5：best 恰是 rejected 候选 → 不写 autoSwitched:true，文案无「已自动切换」", async () => {
    const store = await loadStore()
    const { setId, altIds } = makeSet(store, { pickName: "方案A" })
    const [altA, altB] = altIds
    plant(store, altA, ["success", "success", "success", "success", "success"])
    plant(store, altB, ["failed", "failed", "failed", "failed", "failed"])

    // 前置：把当前 chosen 的方案A 真实证伪（pick 方案B + verdict=rejected → 让位者记 rejected）
    const re = store.pickStrategy({ setId, altName: "方案B", sessionId: SESSION, agentName: "build", verdict: "rejected" })
    assert.equal(re?.currentAlt, "方案B")
    assert.equal(store.getNode(altA).status, "rejected", "前置：高分分支已被真实证伪")
    assert.equal(store.getNode(altB).status, "chosen", "前置：当前分支是低分的方案B")
    assert.equal(store.resolveActiveAlt(SESSION)?.nodeId, altB, "前置：本会话 active alt = 方案B")

    // 分数形状：方案A 子树 5×success → 0.833，方案B 5×failed → 0 → best 恰好是被证伪的方案A
    const sA = scoreOf(store, altA)
    const sB = scoreOf(store, altB)
    assert.equal(sA.n, 5)
    assert.ok((sA.score ?? 0) - (sB.score ?? 0) > 0.2, `构造的分差需 > 0.2：${sA.score} - ${sB.score}`)

    const result = await runDream(store, baseConfig(), { logger: fakeLogger, sessionId: SESSION })

    // 断言（修复后行为）：pickStrategy 对 rejected 返回 undefined → 绝不能对外报告切换成功
    const log = store.getAdviceLog()
    assert.ok(
        log.every((r) => r.autoSwitched !== true),
        `rejected 候选不得被写成 autoSwitched:true：${JSON.stringify(log)}`,
    )
    assert.ok(
        !result.text.includes("已自动切换"),
        `best 为 rejected 时文案不得出现「已自动切换」：${result.text}`,
    )

    // 状态一个都不许动：rejected 不被复活，当前分支与 set 元数据原样
    assert.equal(store.getNode(altA).status, "rejected", "rejected 不得被 dream 复活")
    assert.equal(store.getNode(altB).status, "chosen", "当前分支必须保持 chosen")
    assert.equal(setMeta(store, setId).chosenAltId, altB, "set.chosenAltId 不得指向被证伪分支")
    assert.equal(store.resolveActiveAlt(SESSION)?.nodeId, altB, "会话 active alt 不得改变")
})
