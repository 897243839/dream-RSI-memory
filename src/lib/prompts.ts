import type { CaptureMaterial, CommitInput, DistillResult, RecallParams } from "./types.js"

const OUTCOME_VALUES = ['"success"', '"failed"', '"partial"'].join("|")

export function buildDistillPrompt(material: CaptureMaterial, args: Partial<CommitInput>): string {
    const userSnippet = material.userText ? `用户意图：\n${material.userText}\n` : ""
    const asstSnippet = material.assistantText ? `助手行为摘要：\n${material.assistantText}\n` : ""
    const toolSnippet =
        material.tools.length > 0
            ? `本次使用的工具：\n${material.tools.map((t) => `- ${t.tool}${t.error ? ` (ERROR: ${t.error})` : ""}`).join("\n")}\n`
            : ""
    const intent = args
        ? `已有部分标注（仅补缺，不反悔）：summary=${JSON.stringify(args.summary ?? "")} outcome=${JSON.stringify(args.outcome ?? "")} why=${JSON.stringify(args.why ?? "")}\n`
        : ""
    return [
        "你是一个严格的记忆馆藏官。下面是一次真实 coding 会话回合的素材，请抽取成一条可复用的长期记忆。",
        "",
        userSnippet + asstSnippet + toolSnippet,
        "规则：",
        "1. summary：一句话概括该回合解决/探索的问题与结论（≤60 字，中英皆可）。",
        "2. outcome：success=目标达成；failed=明确踩坑/失败且根因清楚；partial=有进展但未完成（默认）。",
        "3. why：仅当 outcome=failed 时必填，写明失败根因（≤80 字），供未来避免重蹈。",
        "4. files：该回合实际触碰的文件，必须是项目相对路径；拿不准就留空数组。",
        "5. errorMessage：若失败来自具体报错，原文摘录关键一句；否则 null。",
        "",
        "只输出一个 JSON，不要任何解释/代码块包裹：",
        `{"summary": string, "outcome": ${OUTCOME_VALUES}, "why": string|null, "files": string[], "errorMessage": string|null}`,
        intent,
        "若素材不足以判断失败根因，outcome 请给 partial，why 给 null。",
    ].join("\n")
}

export function buildMutationPrompt(params: RecallParams, notes: string): string {
    const values = [
        `- fileOverlapWeight = ${params.fileOverlapWeight}`,
        `- ftsScoreWeight = ${params.ftsScoreWeight}`,
        `- successBoost = ${params.successBoost}`,
        `- failureBoost = ${params.failureBoost}`,
        `- recencyHalfLife = ${params.recencyHalfLife}`,
        `- maxRecall = ${params.maxRecall}`,
        `- minScore = ${params.minScore}`,
    ].join("\n")
    return [
        "你是记忆检索策略进化器。现有检索参数如下：",
        values,
        "",
        `当前最薄弱指标：${notes}`,
        "",
        "请提出 ≤2 组互不相同的候选参数，针对性改善薄弱指标，同时遵守硬边界：fileOverlapWeight∈[0,1], ftsScoreWeight∈[0,1], successBoost∈[0,0.4], failureBoost∈[0,0.5], recencyHalfLife∈[20,200], maxRecall∈[1,10], minScore∈[0,0.3]（整数）。",
        "只改动 1-3 个参数，其它保持原值。",
        "",
        '只输出一个 JSON 数组（元素为参数对象）：[ {"fileOverlapWeight":..., ...}, ... ]',
    ].join("\n")
}

export function renderMenuText(info: {
    nodeCount: number
    policyId: string
    replayTrain?: number
    minNodes: number
    maxTokensHint: number
}): string {
    const lines = [
        "[dream-memory] 长期记忆就绪：节点 " + info.nodeCount + " · 检索策略 " + info.policyId +
            (info.replayTrain !== undefined ? " · replay(train)=" + info.replayTrain.toFixed(3) : ""),
        "可选动作（纯提示，忽略它也能正常继续工作）：",
        "  1. commit_task_trace — 把本轮探索/踩坑/结论记入记忆库",
        "  2. search_history_experience — 开工前检索相似历史经验",
        "  3. inspect_node_detail / switch_policy / dream_status",
        "  4. run_dream_optimization" + (info.nodeCount >= info.minNodes ? " — 触发做梦优化检索策略" : " — 需要 ≥" + info.minNodes + " 节点"),
    ]
    return lines.join("\n").slice(0, Math.max(info.maxTokensHint * 3, 600))
}

export function parseDistillJson(raw: string): DistillResult | null {
    if (!raw) return null
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
        const obj = JSON.parse(match[0]) as Record<string, unknown>
        const outcome = obj.outcome === "success" || obj.outcome === "failed" || obj.outcome === "partial" ? obj.outcome : undefined
        const files = Array.isArray(obj.files) ? (obj.files as unknown[]).filter((f): f is string => typeof f === "string") : undefined
        const result: DistillResult = {}
        if (typeof obj.summary === "string" && obj.summary.trim()) result.summary = obj.summary.trim()
        if (typeof obj.why === "string" && obj.why.trim()) result.why = obj.why.trim()
        if (outcome) result.outcome = outcome
        if (typeof obj.errorMessage === "string" && obj.errorMessage.trim()) result.errorMessage = obj.errorMessage.trim()
        if (files && files.length) result.files = files
        return result
    } catch {
        return null
    }
}