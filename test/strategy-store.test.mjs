import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, writeFileSync, statSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { loadStore, baseConfig, flush } from "./helpers.mjs"

function readJson(file) {
    return JSON.parse(readFileSync(file, "utf8"))
}

/** 造一个满足限长护栏的 AltCandidate（name≤20 / approach≤300 / tradeoffs≤200 / risk≤200）。 */
function alt(name, over = {}) {
    return {
        name,
        approach: `approach for ${name}`,
        tradeoffs: `tradeoffs for ${name}`,
        estimatedRisk: `risk for ${name}`,
        ...over,
    }
}

/** 造一条合法 AdviceRecord；用 i 标识以便 FIFO 断言。 */
function advice(i, over = {}) {
    return {
        setId: `set-${i % 2}`,
        problem: `problem ${i % 2}`,
        recommendedAltId: `alt-id-${i}`,
        recommendedAltName: `alt-${i}`,
        margin: i / 100,
        nBest: 6,
        nSecond: 3,
        autoSwitched: false,
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
        ...over,
    }
}

function chosenAlts(store, sessionId) {
    return store
        .sortedNodes()
        .filter((n) => n.type === "strategy_alt" && n.status === "chosen" && n.sessionId === sessionId)
}

/* ------------------------------------------------------- 旧库兼容 */

test("旧库兼容：只含经验节点的旧库加载不报错，且 session 文件不被重写", async () => {
    const config = baseConfig()
    const store = await loadStore(config)
    store.commit({ summary: "old one", files: ["a.ts"], sessionId: "old-sess", agentName: "build" })
    store.commit({ summary: "old two", files: ["b.ts"], sessionId: "old-sess", agentName: "build" })
    await flush(store)

    const projectDir = join(config.dataDir, "tproj")
    const indexFile = join(projectDir, "index.json")
    const sessionsDir = join(projectDir, "sessions")
    const partFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))
    assert.equal(partFiles.length, 1)
    const partFile = join(sessionsDir, partFiles[0])

    // 模拟旧库：index.json 没有 adviceLog 键（策略库功能之前的写入方），
    // 且节点上没有 type 键（commit 不传 type 时不写该字段，天然如此）
    const index = readJson(indexFile)
    delete index.adviceLog
    writeFileSync(indexFile, JSON.stringify(index), "utf8")

    // 固定 session 文件 mtime：加载后若被重写，mtime 会变回当前时间
    const past = new Date("2020-01-01T00:00:00.000Z")
    utimesSync(partFile, past, past)
    const before = readFileSync(partFile, "utf8")

    const reloaded = await loadStore(config)
    assert.equal(reloaded.count(), 2)
    assert.deepEqual(reloaded.sortedNodes().map((n) => n.summary), ["old one", "old two"])
    assert.deepEqual(reloaded.getAdviceLog(), [], "缺键时 adviceLog 懒补为空数组")
    // 节点文件不被重写：内容与 mtime 都不变
    assert.equal(readFileSync(partFile, "utf8"), before)
    assert.equal(statSync(partFile).mtimeMs, past.getTime())
})

/* ------------------------------------------------------- propose 防劫持 */

test("propose 防劫持：provisionalPick 后再 propose，新 alt 仍挂 setId 且 branchId 自持", async () => {
    const store = await loadStore()
    const first = store.proposeStrategySet({
        problem: "用什么缓存策略扛住热点读",
        alts: [alt("redis-string"), alt("local-lru"), alt("multi-tier")],
        provisionalPick: "redis-string",
        sessionId: "s-hijack",
        agentName: "build",
    })
    assert.equal(first.altIds.length, 3)
    const set1 = store.getNode(first.setId)
    assert.equal(set1.type, "strategy_set")
    assert.equal(set1.branchId, first.setId)
    for (const id of first.altIds) {
        const a = store.getNode(id)
        assert.equal(a.type, "strategy_alt")
        assert.equal(a.parentId, first.setId, "alt 必须直接挂 setId，不得挂会话链上的其他节点")
        assert.equal(a.branchId, id, "alt 的 branchId 必须是自身 id，避免同 set 共享 branch")
    }
    // provisionalPick 立即生效：选中项 chosen，其余仍 unproven
    assert.equal(store.getNode(first.altIds[0]).status, "chosen")
    assert.equal(store.getNode(first.altIds[1]).status, "unproven")
    assert.equal(store.getNode(first.altIds[2]).status, "unproven")
    assert.equal(set1.chosenAltId, first.altIds[0])

    // chosen 后普通 commit 不传 parentId 会挂进 alt 子树 —— 这正是劫持源
    const work = store.commit({ summary: "work under alt", files: ["c.ts"], sessionId: "s-hijack", agentName: "build" })
    const alt1 = store.getNode(first.altIds[0])
    assert.equal(work.parentId, alt1.nodeId)
    assert.equal(work.branchId, alt1.nodeId)

    // 再 propose 一批：新 alt 必须挂新 set 自己，不得被会话链拖进 set1/alt1 子树
    const second = store.proposeStrategySet({
        problem: "缓存失效怎么通知下游",
        alts: [alt("pubsub"), alt("ttl-poll")],
        sessionId: "s-hijack",
        agentName: "build",
    })
    assert.notEqual(second.setId, first.setId)
    for (const id of second.altIds) {
        const a = store.getNode(id)
        assert.equal(a.parentId, second.setId)
        assert.notEqual(a.parentId, alt1.nodeId)
        assert.notEqual(a.parentId, work.nodeId)
        assert.equal(a.branchId, id)
        assert.equal(a.status, "unproven")
    }
})

/* ------------------------------------------------------- pick 不变量 */

test("pick：每会话 ≤1 chosen，resolveActiveAlt 取最后一次，commit 自动挂 active alt", async () => {
    const store = await loadStore()
    const { setId, altIds } = store.proposeStrategySet({
        problem: "上传大文件走哪种断点方案",
        alts: [alt("chunked"), alt("s3-multipart"), alt("ws-stream")],
        sessionId: "s-pick",
        agentName: "build",
    })
    const [chunked, multipart, stream] = altIds.map((id) => store.getNode(id))

    const r1 = store.pickStrategy({ setId, altName: "s3-multipart", sessionId: "s-pick", agentName: "build" })
    assert.equal(r1.previousAlt, null)
    assert.equal(r1.currentAlt, "s3-multipart")
    assert.equal(chosenAlts(store, "s-pick").length, 1)
    assert.equal(store.resolveActiveAlt("s-pick").nodeId, multipart.nodeId)

    const r2 = store.pickStrategy({
        setId,
        altName: "ws-stream",
        sessionId: "s-pick",
        agentName: "build",
        reason: "multipart 被网关截断",
    })
    assert.equal(r2.previousAlt, "s3-multipart")
    assert.equal(r2.currentAlt, "ws-stream")
    assert.ok(r2.note.includes("multipart 被网关截断"))
    assert.equal(chosenAlts(store, "s-pick").length, 1, "换分支后本会话仍是唯一 chosen")
    assert.equal(store.getNode(multipart.nodeId).status, "superseded")
    assert.equal(store.resolveActiveAlt("s-pick").nodeId, stream.nodeId, "active alt 取最后一次 pick")

    // 幂等：已在该分支直接成功，不重复写轨迹
    const before = store.sortedNodes().filter((n) => n.type === "strategy_note").length
    const r3 = store.pickStrategy({ setId, altName: "ws-stream", sessionId: "s-pick", agentName: "build" })
    assert.equal(r3.previousAlt, null)
    assert.equal(r3.currentAlt, "ws-stream")
    assert.equal(r3.note, "已在该分支")
    assert.equal(store.sortedNodes().filter((n) => n.type === "strategy_note").length, before)
    assert.equal(chosenAlts(store, "s-pick").length, 1)

    // 每次有效 pick 写 1 条 strategy_note 轨迹：partial + 挂 setId
    const notes = store.sortedNodes().filter((n) => n.type === "strategy_note")
    assert.equal(notes.length, 2, "两次有效 pick 各写一条轨迹")
    for (const note of notes) {
        assert.equal(note.outcome, "partial")
        assert.equal(note.parentId, setId)
        assert.equal(note.branchId, setId)
        assert.equal(note.sessionId, "s-pick")
    }

    // 不存在的 set / 不属于 set 的 altName → undefined
    assert.equal(store.pickStrategy({ setId: "n-nope", altName: "ws-stream", sessionId: "s-pick" }), undefined)
    assert.equal(store.pickStrategy({ setId, altName: "no-such-alt", sessionId: "s-pick" }), undefined)

    // commit 不传 parentId：自动挂 active alt，branchId 继承
    const under = store.commit({ summary: "run under active alt", files: ["d.ts"], sessionId: "s-pick", agentName: "build" })
    assert.equal(under.parentId, stream.nodeId)
    assert.equal(under.branchId, stream.nodeId)
    assert.equal(chunked.status, "unproven", "未触碰的分支保持 unproven")
})

/* ------------------------------------------------------- verdict 语义 */

test("pick：superseded 不是终态可重新选中，rejected 一票否决返回 undefined", async () => {
    const store = await loadStore()
    const { setId, altIds } = store.proposeStrategySet({
        problem: "索引重建用全量还是增量",
        alts: [alt("full-rebuild"), alt("incremental"), alt("dual-write")],
        sessionId: "s-verdict",
        agentName: "build",
    })
    const [full, incremental, dual] = altIds.map((id) => store.getNode(id))

    store.pickStrategy({ setId, altName: "full-rebuild", sessionId: "s-verdict", agentName: "build" })
    const r = store.pickStrategy({
        setId,
        altName: "incremental",
        sessionId: "s-verdict",
        agentName: "build",
        verdict: "superseded",
    })
    assert.equal(r.previousAlt, "full-rebuild")
    assert.equal(r.currentAlt, "incremental")
    assert.equal(store.getNode(full.nodeId).status, "superseded", "superseded 只是让位，不是证伪")
    assert.notEqual(store.getNode(full.nodeId).status, "rejected")

    // superseded 允许重新 pick（§4.8 回滚路径依赖这一点，也不计入失败）
    const back = store.pickStrategy({ setId, altName: "full-rebuild", sessionId: "s-verdict", agentName: "build" })
    assert.equal(back.previousAlt, "incremental")
    assert.equal(back.currentAlt, "full-rebuild")
    assert.equal(store.getNode(full.nodeId).status, "chosen")
    assert.equal(store.getNode(incremental.nodeId).status, "superseded")
    assert.equal(chosenAlts(store, "s-verdict").length, 1)

    // verdict=rejected：让位的分支被证伪，之后不可再选
    store.pickStrategy({ setId, altName: "dual-write", sessionId: "s-verdict", agentName: "build", verdict: "rejected" })
    assert.equal(store.getNode(full.nodeId).status, "rejected")
    assert.equal(dual.status, "chosen")
    assert.equal(
        store.pickStrategy({ setId, altName: "full-rebuild", sessionId: "s-verdict", agentName: "build" }),
        undefined,
    )
    assert.equal(store.getNode(full.nodeId).status, "rejected", "rejected 不被复活")
    assert.equal(chosenAlts(store, "s-verdict").length, 1)
    assert.equal(store.resolveActiveAlt("s-verdict").nodeId, dual.nodeId)
})

/* ------------------------------------------------------- count 口径 */

test("count() 只数经验节点：set/alt/note 混入不虚增", async () => {
    const store = await loadStore()
    store.commit({ summary: "exp 1", files: ["a.ts"], sessionId: "s-count", agentName: "build" })
    store.commit({ summary: "exp 2", files: ["b.ts"], sessionId: "s-count", agentName: "build" })
    store.commit({ summary: "exp 3", files: ["c.ts"], sessionId: "s-count", agentName: "build" })
    assert.equal(store.count(), 3)

    store.proposeStrategySet({
        problem: "异步队列选型",
        alts: [alt("bullmq"), alt("sqs"), alt("redis-stream")],
        provisionalPick: "bullmq",
        sessionId: "s-count",
        agentName: "build",
    })
    // 1 set + 3 alt + 1 note（provisionalPick 轨迹）都不计入经验数
    assert.equal(store.count(), 3)
    const total = store.sortedNodes().length
    assert.equal(total, 3 + 1 + 3 + 1)

    store.commit({ summary: "exp 4", files: ["d.ts"], sessionId: "s-count", agentName: "build" })
    assert.equal(store.count(), 4)
    assert.equal(store.sortedNodes().length, total + 1)
})

/* ------------------------------------------------------- 空 sessionId */

test("commit 空 sessionId：不影响其他会话的 resolveActiveAlt 与挂链", async () => {
    const store = await loadStore()
    const { altIds } = store.proposeStrategySet({
        problem: "会话隔离验证",
        alts: [alt("path-x"), alt("path-y")],
        provisionalPick: "path-x",
        sessionId: "s-real",
        agentName: "build",
    })
    const active = store.getNode(altIds[0])
    assert.equal(store.resolveActiveAlt("s-real").nodeId, active.nodeId)

    // 空串会话：resolveActiveAlt 直接拒绝，节点自成一条链，不得劫持 s-real
    // （store 层无法阻止该节点被归入 "unknown" 文件分组，工具层 guard 负责拦截入口；
    //   这里验证的是任意真实会话的 active alt 与挂链均不受影响）
    const ghost = store.commit({ summary: "ghost", files: ["g.ts"], sessionId: "", agentName: "build" })
    assert.equal(ghost.sessionId, "")
    assert.equal(ghost.parentId, undefined)
    assert.equal(ghost.branchId, ghost.nodeId)
    assert.equal(store.resolveActiveAlt(""), null)
    assert.equal(store.resolveActiveAlt("s-real").nodeId, active.nodeId, "空会话不得污染 s-real 的 active alt")

    // s-real 后续 commit 仍挂到自己的 active alt
    const next = store.commit({ summary: "still on x", files: ["h.ts"], sessionId: "s-real", agentName: "build" })
    assert.equal(next.parentId, active.nodeId)
    assert.equal(next.branchId, active.nodeId)
})

/* ------------------------------------------------------- adviceLog 脏数据 */

test("adviceLog 脏数据不触发 rebuild：policies/dreamRuns 完好，脏条目被丢弃", async () => {
    const config = baseConfig()
    const store = await loadStore(config)
    store.commit({ summary: "keep me", files: ["a.ts"], sessionId: "s-dirty", agentName: "build" })
    store.recordDream({
        runId: "run-keep",
        status: "done",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        candidatesJson: '{"kept":true}',
        chosenPolicyId: "p-default",
    })
    await flush(store)

    const indexFile = join(config.dataDir, "tproj", "index.json")
    const index = readJson(indexFile)
    assert.ok(Array.isArray(index.adviceLog), "前置条件：index 带 adviceLog 数组")
    const pDefaultBefore = index.policies["p-default"]
    assert.ok(pDefaultBefore, "前置条件：index 里有 p-default")
    // 植入一个自定义策略：若加载走了 rebuild，policies 会被重置为 initialPolicies，它必消失
    index.policies["p-marker"] = { ...pDefaultBefore, policyId: "p-marker", dreamRound: 99, isActive: false }
    // 塞脏 adviceLog
    index.adviceLog = [{ bogus: 1 }, null, "x"]
    writeFileSync(indexFile, JSON.stringify(index), "utf8")

    const reloaded = await loadStore(config)
    assert.deepEqual(reloaded.getAdviceLog(), [], "全部脏条目被丢弃")
    assert.equal(reloaded.count(), 1, "经验节点照常从 sessions 加载")
    assert.equal(reloaded.latestDream()?.runId, "run-keep", "dreamRuns 未被重置 → 没走 rebuild")
    assert.ok(reloaded.listPolicies().some((p) => p.policyId === "p-marker"), "自定义策略存活 → 没走 rebuild")
    assert.ok(reloaded.listPolicies().some((p) => p.policyId === "p-default"))
    // 磁盘上同样完好（rebuild 会把 dreamRuns 重写为空对象、policies 重置）
    const after = readJson(indexFile)
    assert.equal(after.dreamRuns["run-keep"].candidatesJson, '{"kept":true}')
    assert.deepEqual(after.policies["p-default"], pDefaultBefore)
    assert.deepEqual(after.policies["p-marker"], index.policies["p-marker"])
})

/* ------------------------------------------------------- adviceLog FIFO */

test("adviceLog 超 50 条 FIFO 裁剪最旧", async () => {
    const store = await loadStore()
    assert.deepEqual(store.getAdviceLog(), [])
    for (let i = 0; i < 55; i++) store.appendAdvice(advice(i))
    const log = store.getAdviceLog()
    assert.equal(log.length, 50, "上限 50 条")
    assert.equal(log[0].recommendedAltId, "alt-id-5", "最旧的 5 条被裁掉")
    assert.equal(log[0].recommendedAltName, "alt-5")
    assert.equal(log[log.length - 1].recommendedAltId, "alt-id-54")
})

/* ------------------------------------------------------- strategyOverview */

test("strategyOverview：lastAdvice 取末条，lastAutoSwitch 取最后一条 autoSwitched", async () => {
    const store = await loadStore()
    assert.deepEqual(store.strategyOverview(), {
        setCount: 0,
        altCount: 0,
        chosen: null,
        lastAdvice: null,
        lastAutoSwitch: null,
    })

    const { setId } = store.proposeStrategySet({
        problem: "概览统计口径",
        alts: [alt("route-a"), alt("route-b")],
        provisionalPick: "route-a",
        sessionId: "s-overview",
        agentName: "build",
    })
    const picked = store.strategyOverview()
    assert.equal(picked.setCount, 1)
    assert.equal(picked.altCount, 2)
    assert.deepEqual(picked.chosen, { setId, problem: "概览统计口径", altName: "route-a" })
    assert.equal(picked.lastAdvice, null)
    assert.equal(picked.lastAutoSwitch, null)

    const a1 = advice(1)
    const a2 = advice(2, { autoSwitched: true })
    const a3 = advice(3)
    store.appendAdvice(a1)
    store.appendAdvice(a2)
    store.appendAdvice(a3)
    const over = store.strategyOverview()
    assert.deepEqual(over.lastAdvice, a3, "lastAdvice 是最后一条")
    assert.deepEqual(over.lastAutoSwitch, a2, "lastAutoSwitch 是最后一条 autoSwitched===true 的")
    assert.equal(over.setCount, 1, "adviceLog 不影响 set 计数")
})

/* ------------------------------------------------------- listSetMetas */

test("listSetMetas：altNames 与 altIds 一一对应，chosenAltId 随 pick 更新", async () => {
    const store = await loadStore()
    const first = store.proposeStrategySet({
        problem: "元数据对应关系",
        alts: [alt("alpha"), alt("beta"), alt("gamma")],
        sessionId: "s-meta",
        agentName: "build",
    })
    let metas = store.listSetMetas()
    assert.equal(metas.length, 1)
    assert.equal(metas[0].setId, first.setId)
    assert.equal(metas[0].problem, "元数据对应关系")
    assert.deepEqual(metas[0].altIds, first.altIds)
    assert.deepEqual(metas[0].altNames, ["alpha", "beta", "gamma"])
    assert.equal(metas[0].chosenAltId, undefined)

    const second = store.proposeStrategySet({
        problem: "第二个决策问题",
        alts: [alt("delta"), alt("epsilon")],
        sessionId: "s-meta",
        agentName: "build",
    })
    metas = store.listSetMetas()
    assert.equal(metas.length, 2)
    for (const meta of metas) {
        assert.equal(meta.altNames.length, meta.altIds.length, "altNames 与 altIds 等长")
        meta.altIds.forEach((id, i) => {
            assert.equal(meta.altNames[i], store.getNode(id).name, "第 i 个名字对应第 i 个 id")
        })
    }
    assert.deepEqual(metas[0].altIds, first.altIds)
    assert.deepEqual(metas[1].altIds, second.altIds)

    // pick 后 chosenAltId 指向被选中的 alt
    store.pickStrategy({ setId: second.setId, altName: "epsilon", sessionId: "s-meta", agentName: "build" })
    const after = store.listSetMetas().find((m) => m.setId === second.setId)
    assert.equal(after.chosenAltId, second.altIds[1])
    assert.equal(store.getNode(after.chosenAltId).name, "epsilon")
})

/* ------------------------------------------------------- P0-2 跨会话 pick */

test("P0-2 跨会话 pick：会话 B 发起也必须让位会话 A 的 chosen（每会话 ≤1 chosen）", async () => {
    const store = await loadStore()
    // set 与两个候选都属于会话 A（alt 的 sessionId = 创建会话）
    const { setId, altIds } = store.proposeStrategySet({
        problem: "跨会话切换走哪条链路",
        alts: [alt("alt-x"), alt("alt-y")],
        sessionId: "sess-A",
        agentName: "build",
    })
    const [altX, altY] = altIds

    // 会话 A 先选中 alt-x
    const rA = store.pickStrategy({ setId, altName: "alt-x", sessionId: "sess-A", agentName: "build" })
    assert.equal(rA?.currentAlt, "alt-x")
    assert.equal(store.getNode(altX).status, "chosen")
    assert.equal(chosenAlts(store, "sess-A").length, 1, "前置：会话 A 恰好 1 个 chosen")

    // 换**会话 B** 再 pick 同 set 的 alt-y：
    // 让位循环若按 input.sessionId 过滤，B 发起时清不到 A 的 chosen → alt_x/alt_y 双 chosen。
    const rB = store.pickStrategy({ setId, altName: "alt-y", sessionId: "sess-B", agentName: "build" })
    assert.equal(rB?.currentAlt, "alt-y", "跨会话 pick 应成功")

    // 断言（修复后行为）：会话 A 仍然只有 1 个 chosen，且是 alt-y；alt-x 必须已让位
    assert.equal(store.getNode(altX).status, "superseded", "旧 chosen 必须让位为 superseded")
    assert.equal(store.getNode(altY).status, "chosen")
    const chosenA = chosenAlts(store, "sess-A")
    assert.equal(chosenA.length, 1, `会话 A 必须恰好 1 个 chosen，实际 ${chosenA.length}`)
    assert.equal(chosenA[0].nodeId, altY, "留在 chosen 位上的应是最后被 pick 的 alt-y")

    // 全局不变量：任意会话的 chosen 数 ≤ 1
    const perSession = new Map()
    for (const node of store.sortedNodes()) {
        if (node.type !== "strategy_alt" || node.status !== "chosen") continue
        perSession.set(node.sessionId, (perSession.get(node.sessionId) ?? 0) + 1)
    }
    for (const [sid, count] of perSession) {
        assert.ok(count <= 1, `会话 ${sid} 出现 ${count} 个 chosen，违反「每会话 ≤1 chosen」`)
    }
})
