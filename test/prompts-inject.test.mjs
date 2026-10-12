import test from "node:test"
import assert from "node:assert/strict"
import { renderMenuText, renderSystemHelpText } from "../dist/lib/prompts.js"

/**
 * 设计方案 §10 验收 15：策略库的两处提示词注入。
 * - renderSystemHelpText() 的 WHEN 列表第 4 条（设计决策工作流）与第 5 条（自动切换感知）
 * - renderMenuText() 的「可动作」列表新增 strategy_propose / strategy_pick 行
 */

/** 取编号列表里以 `n. ` 开头的那一条（WHEN-NOT 只有 3 条，不会撞上 4/5）。 */
function numberedLine(text, n) {
    return text.split("\n").find((line) => line.startsWith(`${n}. `))
}

test("renderSystemHelpText：WHEN 第 4 条＝设计决策工作流（≥20 探索 → question 人选 → propose → pick）", () => {
    const text = renderSystemHelpText()
    assert.ok(text.includes("WHEN（满足其一就参与"), "应保留 WHEN 列表头")

    const line4 = numberedLine(text, 4)
    assert.ok(line4, "WHEN 列表应有第 4 条（设计决策工作流）")
    assert.ok(line4.includes("strategy_propose"), line4)
    assert.ok(line4.includes("strategy_pick"), line4)
    assert.ok(line4.includes("≥20"), line4)
    assert.ok(line4.includes("question"), line4)
    assert.ok(line4.includes("sub-agent"), line4)
    assert.ok(line4.includes("设计决策"), line4)
    // 工作流顺序：先探索 ≥20 → 再 question 与人选 → 再 propose 入库 → 最后 pick 定分支
    assert.ok(line4.indexOf("sub-agent") < line4.indexOf("≥20"), "应先 sub-agent 探索")
    assert.ok(line4.indexOf("≥20") < line4.indexOf("question"), "先探索 ≥20 再与人选")
    assert.ok(line4.indexOf("question") < line4.indexOf("strategy_propose"), "先人选再入库")
    assert.ok(line4.indexOf("strategy_propose") < line4.indexOf("strategy_pick"), "先 propose 再 pick")
})

test("renderSystemHelpText：WHEN 第 5 条＝收到自动切换通知后按新分支继续", () => {
    const text = renderSystemHelpText()
    const line5 = numberedLine(text, 5)
    assert.ok(line5, "WHEN 列表应有第 5 条（自动切换感知）")
    assert.ok(line5.includes("自动切换通知"), line5)
    assert.ok(line5.includes("strategy_pick"), line5)
    assert.ok(line5.includes("新分支"), line5)
    // 第 3 条原有的「≥20」是记忆库节点数，不能与第 4 条的探索数混淆
    const line3 = numberedLine(text, 3)
    assert.ok(line3.includes("dream_rsi_memory_dream"), "原第 3 条（dream 进化）必须保留")
})

function menuInput(overrides = {}) {
    return {
        nodeCount: 30,
        policyId: "p-abc12345",
        stage: "F",
        minNodesProvisional: 5,
        minNodes: 20,
        maxTokensHint: 200,
        ...overrides,
    }
}

test("renderMenuText：新增 strategy_propose/strategy_pick 动作行，原 3 条动作行仍在", () => {
    const text = renderMenuText(menuInput())
    const lines = text.split("\n")

    // 新增行
    const injected = lines.filter((l) => l.includes("strategy_propose"))
    assert.equal(injected.length, 1, "新动作行应恰好出现一次")
    assert.ok(
        injected[0].includes("dream_rsi_memory_strategy_propose") && injected[0].includes("strategy_pick") && injected[0].includes("切换分支"),
        injected[0],
    )

    // 原有 3 条动作行（search / commit / dream）不得被挤掉
    assert.ok(lines.includes("- dream_rsi_memory_search 检索历史经验"), text)
    assert.ok(lines.includes("- dream_rsi_memory_commit 沉淀一条可复用结论"), text)
    assert.ok(lines.includes("- dream_rsi_memory_dream 自我进化检索策略"), text)
    assert.ok(text.includes("可动作（跟不跟着做均可）"), "动作列表头应保留")

    // 各阶段 sizeLine 与注入行都在（S/M/F 三种 sizeLine 都过一遍）
    for (const stage of ["S", "M", "F"]) {
        const stageText = renderMenuText(menuInput({ stage }))
        assert.ok(stageText.includes("strategy_propose"), `stage=${stage} 也要带新动作行`)
        assert.ok(stageText.includes("- dream_rsi_memory_search 检索历史经验"), `stage=${stage} 也要带原有动作行`)
    }
})

/**
 * token 粗估口径（验收 15 的「菜单 ≤ 200 tokens」）：
 * - 中日韩表意文字与中文标点（\u3000-\u303f / \u3400-\u4dbf / \u4e00-\u9fff / \uff00-\uffef）按 1 字 ≈ 1 token
 * - 其余字符（ASCII、换行、≤ 之类符号）按 4 字符 ≈ 1 token
 * 另用总字符数 < 900 作保守上限兜底（即便所有字符都按 1 字 ≈ 1 token 也不至于误报）。
 */
function estimateTokens(text) {
    const cjk = text.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g)?.length ?? 0
    const other = text.length - cjk
    return cjk + other / 4
}

test("renderMenuText：总长度 ≤ 200 tokens（保守上限 < 900 字符）", () => {
    const variants = [
        ["S 播种期，无 teaser", menuInput({ stage: "S" })],
        ["M 试用期，无 teaser", menuInput({ stage: "M" })],
        ["F 正式期，无 teaser", menuInput({ stage: "F" })],
        [
            "F 正式期 + 上次进化 + 命中 teaser（最长形态）",
            menuInput({
                stage: "F",
                turnsSinceDream: 12,
                lastDreamAt: "2026-10-12T09:00:00.000Z",
                teaser: 'n-ab12cd34 "桌面引擎从不发射 idle"（成功）',
            }),
        ],
    ]
    for (const [label, input] of variants) {
        const text = renderMenuText(input)
        const tokens = estimateTokens(text)
        assert.ok(tokens < 200, `${label}：估算 ${tokens.toFixed(1)} tokens，应 < 200\n${text}`)
        assert.ok(text.length < 900, `${label}：总长 ${text.length} 字符，应 < 900\n${text}`)
        assert.ok(text.includes("strategy_propose"), `${label}：新动作行必须在`)
    }
})
