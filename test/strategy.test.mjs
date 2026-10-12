import test from "node:test"
import assert from "node:assert/strict"
import {
    ADVICE_LOG_MAX,
    AUTO_SWITCH_DELTA,
    AUTO_SWITCH_MIN_SAMPLES,
    LIMIT_APPROACH,
    LIMIT_ESTIMATED_RISK,
    LIMIT_NAME,
    LIMIT_PROBLEM,
    LIMIT_TRADEOFFS,
    MIN_SUBTREE_NODES,
    PROPOSE_MAX_ALTS,
    PROPOSE_MIN_ALTS,
    buildChildIndex,
    canAutoSwitch,
    checkPropose,
    descendantsOf,
    isExperience,
    isStrategyAlt,
    isStrategySet,
    isValidAdvice,
    parseAdviceLog,
    resolveActiveAlt,
    scoreSubtree,
    wilsonLowerBound,
} from "../dist/lib/strategy.js"
import { loadStore } from "./helpers.mjs"

/* ------------------------------------------------------------------ helper */

let seq = 0

/** 构造字段齐全的 NodeRecord（必填字段全给，测试差异用 overrides 覆盖）。 */
function makeNode(overrides = {}) {
    seq += 1
    return {
        nodeId: `node-${seq}`,
        projectId: "proj-1",
        sessionId: "sess-1",
        agentName: "build",
        summary: `节点 ${seq}`,
        outcome: "success",
        files: ["src/a.ts"],
        turnIndex: seq,
        createdAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    }
}

/** 单个候选分支（字段限长护栏的被测对象）。 */
function altOf(overrides = {}) {
    return { name: "alt-a", approach: "先做 A", tradeoffs: "较慢", estimatedRisk: "低", ...overrides }
}

/** 连续 n 个合法候选（name 互不相同且 ≤ LIMIT_NAME）。 */
function alts(n) {
    return Array.from({ length: n }, (_, i) => altOf({ name: `alt-${i}` }))
}

/** 合法的 adviceLog 条目，用 recommendedAltName 当序号标记。 */
function adviceOf(i) {
    return {
        setId: "set-1",
        problem: "选哪个索引方案",
        recommendedAltId: `alt-${i}`,
        recommendedAltName: `name-${i}`,
        margin: 0.2,
        nBest: 6,
        nSecond: 5,
        autoSwitched: false,
        createdAt: "2026-01-01T00:00:00.000Z",
    }
}

/** canAutoSwitch 的 AltScore 简写。 */
function scoreOf(altId, score, n) {
    return { altId, name: altId, s: n, f: 0, p: 0, n, score }
}

/* ------------------------------------------- 【1】isExperience（旧库兼容） */

test("【1】isExperience：type 缺省/显式 experience → true，三种 strategy type → false", () => {
    assert.equal(isExperience(makeNode()), true, "type 缺省（旧库磁盘上无此键）必须视为 experience")
    assert.equal(isExperience(makeNode({ type: "experience" })), true)
    assert.equal(isExperience(makeNode({ type: "strategy_set" })), false)
    assert.equal(isExperience(makeNode({ type: "strategy_alt" })), false)
    assert.equal(isExperience(makeNode({ type: "strategy_note" })), false)
})

test("【1·附】isStrategySet / isStrategyAlt：缺 problem/altIds/setId/name/status 的脏字段一律 false", () => {
    const setOk = makeNode({ type: "strategy_set", problem: "p?", altIds: ["a1", "a2"] })
    assert.equal(isStrategySet(setOk), true)
    assert.equal(isStrategySet(makeNode({ type: "strategy_set" })), false, "缺 problem")
    assert.equal(isStrategySet(makeNode({ type: "strategy_set", problem: "p?" })), false, "缺 altIds")
    assert.equal(isStrategySet(makeNode({ problem: "p?", altIds: [] })), false, "type 缺省不是 set")

    const altOk = makeNode({ type: "strategy_alt", setId: "set-1", name: "A", status: "chosen" })
    assert.equal(isStrategyAlt(altOk), true)
    assert.equal(isStrategyAlt(makeNode({ type: "strategy_alt", name: "A", status: "chosen" })), false, "缺 setId")
    assert.equal(isStrategyAlt(makeNode({ type: "strategy_alt", setId: "set-1", status: "chosen" })), false, "缺 name")
    assert.equal(isStrategyAlt(makeNode({ type: "strategy_alt", setId: "set-1", name: "A" })), false, "缺 status")
})

/* --------------------------------------------- 【2】checkPropose 规则护栏 */

test("【2】checkPropose：候选数 2 与 11 被拒，3~10 放行", () => {
    const problem = "cache the render results?"
    const tooFew = checkPropose({ problem, alternatives: alts(PROPOSE_MIN_ALTS - 1) }, [])
    assert.equal(tooFew.ok, false)
    assert.match(tooFew.reason, /候选数/)

    const tooMany = checkPropose({ problem, alternatives: alts(PROPOSE_MAX_ALTS + 1) }, [])
    assert.equal(tooMany.ok, false)
    assert.match(tooMany.reason, /候选数/)

    assert.deepEqual(checkPropose({ problem, alternatives: alts(PROPOSE_MIN_ALTS) }, []), { ok: true })
    assert.deepEqual(checkPropose({ problem, alternatives: alts(PROPOSE_MAX_ALTS) }, []), { ok: true })
})

test("【2】checkPropose：name 为空 / 超长 / 重复被拒", () => {
    const problem = "cache the render results?"

    const emptyName = checkPropose(
        { problem, alternatives: [altOf({ name: "" }), altOf({ name: "b" }), altOf({ name: "c" })] },
        [],
    )
    assert.equal(emptyName.ok, false)
    assert.match(emptyName.reason, /空的候选 name/)

    const longName = checkPropose(
        { problem, alternatives: [altOf({ name: "n".repeat(LIMIT_NAME + 1) }), altOf({ name: "b" }), altOf({ name: "c" })] },
        [],
    )
    assert.equal(longName.ok, false)
    assert.match(longName.reason, /name 超长/)

    const dup = checkPropose(
        { problem, alternatives: [altOf({ name: "same" }), altOf({ name: "same" }), altOf({ name: "c" })] },
        [],
    )
    assert.equal(dup.ok, false)
    assert.match(dup.reason, /name 重复/)
    assert.ok(dup.reason.includes("same"), "重复的 name 要点名")
})

test("【2】checkPropose：字段超长点名（problem / approach / tradeoffs / estimatedRisk 各一条）", () => {
    const longProblem = checkPropose(
        { problem: "p".repeat(LIMIT_PROBLEM + 1), alternatives: alts(3) },
        [],
    )
    assert.equal(longProblem.ok, false)
    assert.match(longProblem.reason, /problem 超长/)

    const longApproach = checkPropose(
        { problem: "cache the render results?", alternatives: [altOf({ approach: "a".repeat(LIMIT_APPROACH + 1) }), altOf({ name: "b" }), altOf({ name: "c" })] },
        [],
    )
    assert.equal(longApproach.ok, false)
    assert.match(longApproach.reason, /approach 超长/)

    const longTradeoffs = checkPropose(
        { problem: "cache the render results?", alternatives: [altOf({ tradeoffs: "t".repeat(LIMIT_TRADEOFFS + 1) }), altOf({ name: "b" }), altOf({ name: "c" })] },
        [],
    )
    assert.equal(longTradeoffs.ok, false)
    assert.match(longTradeoffs.reason, /tradeoffs 超长/)

    const longRisk = checkPropose(
        { problem: "cache the render results?", alternatives: [altOf({ estimatedRisk: "r".repeat(LIMIT_ESTIMATED_RISK + 1) }), altOf({ name: "b" }), altOf({ name: "c" })] },
        [],
    )
    assert.equal(longRisk.ok, false)
    assert.match(longRisk.reason, /estimatedRisk 超长/)
})

test("【2】checkPropose：problem 为空被拒；provisionalPick 不在 alternatives 中被拒", () => {
    const emptyProblem = checkPropose({ problem: "   ", alternatives: alts(3) }, [])
    assert.equal(emptyProblem.ok, false)
    assert.match(emptyProblem.reason, /problem 不能为空/)

    const badPick = checkPropose(
        { problem: "cache the render results?", alternatives: alts(3), provisionalPick: "ghost" },
        [],
    )
    assert.equal(badPick.ok, false)
    assert.match(badPick.reason, /不在 alternatives 中/)

    // 合法 pick 不误伤
    assert.deepEqual(
        checkPropose({ problem: "cache the render results?", alternatives: alts(3), provisionalPick: "alt-1" }, []),
        { ok: true },
    )
})

/* ---------------------------------------- 【3】problem 相似 → 复用而非新建 */

test("【3】checkPropose：problem 与历史 set 高相似 → {ok:false, kind:\"reuse\"}，reason 含 setId", () => {
    const existing = [
        {
            setId: "set-42",
            problem: "如何选择数据库索引策略以优化查询性能",
            altIds: ["alt-x"],
            altNames: ["alt-x"],
        },
    ]
    const out = checkPropose(
        { problem: "如何选择数据库索引策略来优化查询性能", alternatives: alts(3) },
        existing,
    )
    assert.equal(out.ok, false)
    assert.equal(out.kind, "reuse")
    assert.ok(typeof out.reason === "string" && out.reason.includes("set-42"), `reason 需含 setId：${out.reason}`)

    // 完全不同的问题不应被判复用
    const unrelated = checkPropose({ problem: "should we drop the legacy file watcher entirely?", alternatives: alts(3) }, existing)
    assert.deepEqual(unrelated, { ok: true })
})

/* ------------------------------------------------- 【4】descendantsOf 遍历 */

test("【4】descendantsOf：正常子树返回全部后代且不含起点；起点不存在返回 []", () => {
    const nodes = [
        makeNode({ nodeId: "r" }),
        makeNode({ nodeId: "a", parentId: "r" }),
        makeNode({ nodeId: "b", parentId: "r" }),
        makeNode({ nodeId: "c", parentId: "a" }),
        makeNode({ nodeId: "d", parentId: "c" }),
        makeNode({ nodeId: "orphan", parentId: "ghost" }),
    ]
    const idx = buildChildIndex(nodes)
    assert.equal(idx.byId.size, 6)

    const got = descendantsOf(idx, "r").map((n) => n.nodeId).sort()
    assert.deepEqual(got, ["a", "b", "c", "d"])
    assert.ok(!got.includes("r"), "后代不含起点本身")

    assert.deepEqual(descendantsOf(idx, "no-such-id"), [], "起点不存在返回 []")
    assert.deepEqual(descendantsOf(idx, "ghost"), [], "悬空 parentId 当作起点不存在，返回 [] 而非抛错")
})

test("【4】descendantsOf：自环与互指环不死循环，返回有限结果", () => {
    // 自己当自己的 parent（悬空自指）
    const selfIdx = buildChildIndex([makeNode({ nodeId: "self", parentId: "self" })])
    assert.deepEqual(descendantsOf(selfIdx, "self"), [])

    // x.parentId = y 且 y.parentId = x：靠 seen 去重，不死循环
    const cycIdx = buildChildIndex([
        makeNode({ nodeId: "x", parentId: "y" }),
        makeNode({ nodeId: "y", parentId: "x" }),
    ])
    assert.deepEqual(descendantsOf(cycIdx, "x").map((n) => n.nodeId), ["y"])
})

/* -------------------------------------------------- 【5】wilsonLowerBound */

test("【5】wilsonLowerBound：n=0 返回 0；同 n 下 wins 越大值越大（单调）", () => {
    assert.equal(wilsonLowerBound(5, 0), 0)
    assert.equal(wilsonLowerBound(0, 0), 0)
    assert.equal(wilsonLowerBound(0, 10), 0)

    const n = 40
    const wins = [0, 5, 10, 20, 40]
    const values = wins.map((w) => wilsonLowerBound(w, n))
    for (let i = 1; i < values.length; i++) {
        assert.ok(values[i] > values[i - 1], `wins=${wins[i - 1]}→${wins[i]} (n=${n}) 下界应严格递增：${values[i - 1]} → ${values[i]}`)
    }
})

test("【5】wilsonLowerBound：同一 wins/n 比例下 n 越大下界越高（小样本更保守）", () => {
    const small = wilsonLowerBound(1, 2) // 50%
    const medium = wilsonLowerBound(5, 10) // 50%
    const large = wilsonLowerBound(50, 100) // 50%
    assert.ok(small < medium, `${small} < ${medium}`)
    assert.ok(medium < large, `${medium} < ${large}`)
})

/* ------------------------------------------------------ 【6】scoreSubtree */

test("【6】scoreSubtree：n < MIN_SUBTREE_NODES → score null，恰好达到则有分", () => {
    const two = [makeNode({ outcome: "success" }), makeNode({ outcome: "failed" })]
    const r = scoreSubtree(two)
    assert.equal(r.s, 1)
    assert.equal(r.f, 1)
    assert.equal(r.p, 0)
    assert.equal(r.n, 2)
    assert.equal(r.score, null, `n=2 < ${MIN_SUBTREE_NODES} 时 score 必须为 null`)

    const three = [...two, makeNode({ outcome: "partial" })]
    const r3 = scoreSubtree(three)
    assert.equal(r3.n, 3)
    assert.notEqual(r3.score, null)

    // 自定义 minSamples 也生效
    assert.equal(scoreSubtree(three, 4).score, null)
})

test("【6】scoreSubtree：partial 计半权（s=1,p=2,n=3 明显高于 s=0,p=6,n=6）", () => {
    const a = [
        makeNode({ outcome: "success" }),
        makeNode({ outcome: "partial" }),
        makeNode({ outcome: "partial" }),
    ]
    const ra = scoreSubtree(a)
    assert.deepEqual({ s: ra.s, f: ra.f, p: ra.p, n: ra.n }, { s: 1, f: 0, p: 2, n: 3 })

    const b = Array.from({ length: 6 }, () => makeNode({ outcome: "partial" }))
    const rb = scoreSubtree(b)
    assert.deepEqual({ s: rb.s, f: rb.f, p: rb.p, n: rb.n }, { s: 0, f: 0, p: 6, n: 6 })

    assert.ok(
        ra.score > rb.score,
        `s=1,p=2 (w=2/3) 应明显高于全 partial (w=3/6)：${ra.score} vs ${rb.score}`,
    )

    // 半权精确性：score === wilson(s + 0.5*p, n)，既不满权也不零权
    assert.ok(Math.abs(ra.score - wilsonLowerBound(1 + 0.5 * 2, 3)) < 1e-12, "partial 必须按 0.5 计入 wins")
    assert.ok(ra.score < wilsonLowerBound(3, 3), "partial 不计满权")
    assert.ok(ra.score > wilsonLowerBound(1, 3), "partial 不计零权")
})

test("【6】scoreSubtree：只统计 type===\"experience\"，混入 set/alt/note 不改变结果", () => {
    const pure = [
        makeNode({ outcome: "success" }),
        makeNode({ outcome: "success" }),
        makeNode({ outcome: "failed" }),
    ]
    const base = scoreSubtree(pure)
    assert.deepEqual({ s: base.s, f: base.f, p: base.p, n: base.n }, { s: 2, f: 1, p: 0, n: 3 })

    const mixed = [
        ...pure,
        makeNode({ type: "strategy_set", problem: "p?", altIds: ["a1"], outcome: "success" }),
        makeNode({ type: "strategy_alt", setId: "set-1", name: "A", status: "chosen", outcome: "success" }),
        makeNode({ type: "strategy_note", outcome: "failed" }),
        makeNode({ outcome: "success" }), // 这个是 experience，要计入
    ]
    const r = scoreSubtree(mixed)
    assert.deepEqual(
        { s: r.s, f: r.f, p: r.p, n: r.n },
        { s: 3, f: 1, p: 0, n: 4 },
        "set/alt/note 不得稀释胜率，只有 experience 计数",
    )
    assert.notEqual(r.score, null)
})

/* --------------------------------------------------- 【7】canAutoSwitch */

test("【7】canAutoSwitch：margin 与 best.n 两个条件", () => {
    const base = { currentChosenAltId: "alt-b", hasActiveAlt: true }

    // 全满足 → true
    assert.equal(
        canAutoSwitch({ ...base, best: scoreOf("alt-a", 0.6, 10), second: scoreOf("alt-b", 0.3, 8) }),
        true,
    )

    // margin 恰好等于 AUTO_SWITCH_DELTA → false（要求严格大于）
    // 用 0.4/0.2：0.4 是 0.2 的精确 2 倍，相减结果恰为 0.2，是真正的等值边界
    assert.equal(AUTO_SWITCH_DELTA, 0.2, "下面的等值边界依赖 AUTO_SWITCH_DELTA === 0.2")
    assert.equal(
        canAutoSwitch({
            ...base,
            best: scoreOf("alt-a", 0.4, 10),
            second: scoreOf("alt-b", 0.2, 10),
        }),
        false,
        "margin ≤ AUTO_SWITCH_DELTA 不得自动切换",
    )

    // margin 小于阈值 → false
    assert.equal(
        canAutoSwitch({ ...base, best: scoreOf("alt-a", 0.31, 10), second: scoreOf("alt-b", 0.3, 10) }),
        false,
    )

    // best.n < AUTO_SWITCH_MIN_SAMPLES → false（即使 margin 很大）
    assert.equal(
        canAutoSwitch({
            ...base,
            best: scoreOf("alt-a", 0.9, AUTO_SWITCH_MIN_SAMPLES - 1),
            second: scoreOf("alt-b", 0.1, 10),
        }),
        false,
        "样本数不足不得自动切换",
    )

    // 恰好达到样本下限 → 放行
    assert.equal(
        canAutoSwitch({
            ...base,
            best: scoreOf("alt-a", 0.6, AUTO_SWITCH_MIN_SAMPLES),
            second: scoreOf("alt-b", 0.3, 10),
        }),
        true,
    )
})

test("【7】canAutoSwitch：best 即当前 chosen / 无 active alt → false", () => {
    // best.altId === currentChosenAltId → false
    assert.equal(
        canAutoSwitch({
            best: scoreOf("alt-a", 0.6, 10),
            second: scoreOf("alt-b", 0.3, 8),
            currentChosenAltId: "alt-a",
            hasActiveAlt: true,
        }),
        false,
        "已 chosen 的分支无需切换",
    )

    // hasActiveAlt = false → false
    assert.equal(
        canAutoSwitch({
            best: scoreOf("alt-a", 0.6, 10),
            second: scoreOf("alt-b", 0.3, 8),
            currentChosenAltId: "alt-b",
            hasActiveAlt: false,
        }),
        false,
        "会话无 active alt 时切换语义不清晰",
    )

    // 无 currentChosenAltId 但确有 active alt → 放行
    assert.equal(
        canAutoSwitch({
            best: scoreOf("alt-a", 0.6, 10),
            second: scoreOf("alt-b", 0.3, 8),
            currentChosenAltId: undefined,
            hasActiveAlt: true,
        }),
        true,
    )

    // 任一侧 score 为 null（样本不足）→ false
    assert.equal(
        canAutoSwitch({
            best: scoreOf("alt-a", 0.6, 10),
            second: scoreOf("alt-b", null, 2),
            currentChosenAltId: "alt-b",
            hasActiveAlt: true,
        }),
        false,
    )
})

/* ------------------------------------------------------ 【8】adviceLog */

test("【8】parseAdviceLog：非数组 → []，脏条目逐条丢弃，不抛异常", () => {
    for (const bad of [null, undefined, "[]", 42, { length: 1 }, new Map()]) {
        assert.deepEqual(parseAdviceLog(bad), [], `非数组输入 ${String(bad)} 应返回 []`)
    }

    const good1 = adviceOf(1)
    const good2 = adviceOf(2)
    const raw = [
        good1,
        null,
        42,
        "x",
        { setId: "set-1" },
        { ...good1, margin: "high" },
        { ...good2, margin: NaN },
        good2,
        {},
        [],
        undefined,
    ]
    assert.deepEqual(parseAdviceLog(raw), [good1, good2], "脏条目逐条丢弃且保序")

    // 各种畸形输入都不抛
    const cyclic = { self: null }
    cyclic.self = cyclic
    assert.doesNotThrow(() => parseAdviceLog([cyclic, Symbol("x"), new Date()]))
    assert.doesNotThrow(() => parseAdviceLog(cyclic))

    // isValidAdvice 单独冒烟
    assert.equal(isValidAdvice(adviceOf(0)), true)
    assert.equal(isValidAdvice({}), false)
    assert.equal(isValidAdvice(null), false)
})

test("【8】parseAdviceLog：超过 ADVICE_LOG_MAX 条 FIFO 裁最旧", () => {
    const total = ADVICE_LOG_MAX + 10
    const many = Array.from({ length: total }, (_, i) => adviceOf(i))
    const out = parseAdviceLog(many)

    assert.equal(out.length, ADVICE_LOG_MAX, `上限应为 ${ADVICE_LOG_MAX}`)
    assert.equal(out[0].recommendedAltName, "name-10", "最旧的 10 条被裁掉")
    assert.equal(out[out.length - 1].recommendedAltName, `name-${total - 1}`, "最新一条必须保留")

    // 恰好等于上限不动
    assert.equal(parseAdviceLog(many.slice(0, ADVICE_LOG_MAX)).length, ADVICE_LOG_MAX)
})

/* -------------------------------------------------- 【9】resolveActiveAlt */

test("【9】resolveActiveAlt：按会话过滤，取会话内创建序最后一个 chosen", () => {
    const otherSession = makeNode({
        nodeId: "alt-other",
        sessionId: "sess-2",
        type: "strategy_alt",
        setId: "set-1",
        name: "other",
        status: "chosen",
    })
    // turnIndex 故意倒挂：先 pick(21) 后 pick(10)，仍须取创建序最后一个
    const first = makeNode({
        nodeId: "alt-1",
        sessionId: "sess-1",
        type: "strategy_alt",
        setId: "set-1",
        name: "A",
        status: "chosen",
        turnIndex: 21,
    })
    const unproven = makeNode({
        nodeId: "alt-2",
        sessionId: "sess-1",
        type: "strategy_alt",
        setId: "set-1",
        name: "B",
        status: "unproven",
    })
    const second = makeNode({
        nodeId: "alt-3",
        sessionId: "sess-1",
        type: "strategy_alt",
        setId: "set-1",
        name: "C",
        status: "chosen",
        turnIndex: 10,
    })
    const nodes = [otherSession, first, unproven, second]

    const got = resolveActiveAlt(nodes, "sess-1")
    assert.equal(got?.nodeId, "alt-3", "取本会话创建序最后一个 chosen，不按 turnIndex")
    assert.equal(resolveActiveAlt(nodes, "sess-2")?.nodeId, "alt-other", "别的会话的 chosen 不算")
    assert.equal(resolveActiveAlt(nodes, "sess-3"), null, "会话不存在 → null")
})

test("【9】resolveActiveAlt：无 chosen / 脏 alt 节点 → null", () => {
    assert.equal(resolveActiveAlt([], "sess-1"), null)

    const noChosen = [
        makeNode({ nodeId: "alt-u", sessionId: "sess-1", type: "strategy_alt", setId: "set-1", name: "A", status: "unproven" }),
        makeNode({ nodeId: "alt-r", sessionId: "sess-1", type: "strategy_alt", setId: "set-1", name: "B", status: "rejected" }),
        makeNode({ nodeId: "exp-1", sessionId: "sess-1", outcome: "success" }),
    ]
    assert.equal(resolveActiveAlt(noChosen, "sess-1"), null)

    // 脏 alt（缺 status）不是合法 alt，更不是 chosen
    const dirty = [makeNode({ nodeId: "alt-dirty", sessionId: "sess-1", type: "strategy_alt", setId: "set-1", name: "A" })]
    assert.equal(resolveActiveAlt(dirty, "sess-1"), null)
})

/* ------------------------------- 【10】P0-3 descendantsOf 不得穿树到另一个 set */

test("【10】P0-3：同会话第二次 propose 挂进 set1 候选子树，descendantsOf 不得串到 set2", async () => {
    const store = await loadStore()
    const sess = "sess-tree"

    const first = store.proposeStrategySet({
        problem: "缓存层选型（第一问）",
        alts: [altOf({ name: "k-a" }), altOf({ name: "k-b" }), altOf({ name: "k-c" })],
        sessionId: sess,
        agentName: "build",
    })
    const altK = first.altIds[0]

    // set1 候选自己的经验：显式 parentId，绕开 active alt 自动挂靠
    const own = []
    for (const i of [1, 2]) {
        own.push(
            store.commit({
                summary: `set1 经验 ${i}`,
                outcome: "success",
                files: ["src/cache.ts"],
                sessionId: sess,
                agentName: "build",
                parentId: altK,
                branchId: altK,
            }).nodeId,
        )
    }

    // 第二次 propose：默认 parentId = latestNodeForSession → 上面最后那条经验，
    // 即 set2 直接挂进 set1 候选 altK 的子树（跨 set 串味的构造场景）。
    const second = store.proposeStrategySet({
        problem: "缓存层选型（第二问）",
        alts: [altOf({ name: "k-d" }), altOf({ name: "k-e" })],
        sessionId: sess,
        agentName: "build",
    })

    // 前置断言刻意**不走 descendantsOf**（它正是被切断的对象）：手动沿 parentId 链回溯。
    const idx0 = buildChildIndex(store.sortedNodes())
    const seen = new Set()
    let cur = second.setId
    let throughAltK = false
    while (cur && !seen.has(cur)) {
        if (cur === altK) {
            throughAltK = true
            break
        }
        seen.add(cur)
        cur = idx0.byId.get(cur)?.parentId
    }
    assert.ok(throughAltK, "前置：set2 的祖先链必须穿过 set1 候选 altK")

    // 往 set2 的候选下挂经验：先 pick，让 active alt 指向 set2 的候选，再 commit（自动挂靠）
    const picked = store.pickStrategy({ setId: second.setId, altName: "k-d", sessionId: sess, agentName: "build" })
    assert.equal(picked?.currentAlt, "k-d")
    const foreign = store.commit({
        summary: "set2 经验",
        outcome: "failed",
        files: ["src/cache.ts"],
        sessionId: sess,
        agentName: "build",
    })
    assert.equal(foreign.parentId, second.altIds[0], "前置：经验挂在 set2 的候选下")

    // 被测：从 set1 候选出发的子树不得包含 set2 及其候选与经验
    const idx = buildChildIndex(store.sortedNodes())
    const sub = descendantsOf(idx, altK)
    const ids = new Set(sub.map((n) => n.nodeId))
    assert.ok(!ids.has(second.setId), "set2 不得进入 set1 候选的子树（Wilson 子树不得跨 set）")
    for (const id of second.altIds) {
        assert.ok(!ids.has(id), `set2 的候选 ${id} 不得进入 set1 候选的子树`)
    }
    assert.ok(!ids.has(foreign.nodeId), "挂在 set2 候选下的经验不得算进 set1 候选子树")

    // 切断不能误伤自己人：set1 自己的两条经验必须保留
    for (const id of own) {
        assert.ok(ids.has(id), `set1 自己的经验 ${id} 必须保留在子树内`)
    }

    // 打分口径一并断言：set1 候选子树只数得到自己的 2 个经验节点
    const score = scoreSubtree(sub)
    assert.equal(score.s, 2, `set1 候选子树应为 2 success，实际 s=${score.s}`)
    assert.equal(score.n, 2, `set1 候选子树只应含自己的 2 个经验节点，实际 n=${score.n}`)
})
