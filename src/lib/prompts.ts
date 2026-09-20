import type { CaptureMaterial, CommitInput, DistillResult, RecallParams } from "./types.js"

export const OUTCOME_VALUES = ['"success"', '"failed"', '"partial"'].join("|")

/**
 * 结构化系统帮助块（按 ACP 触发模式整块注入，替换旧的 2 行弱文案）。
 * WHY：旧文案说“非每回合必须、跟不跟着做均可”且无示例、无触发哲学——
 * 模型没有任何动机调用。整块化为 WHEN / WHEN-NOT / 真实示例 / 哲学，
 * 让模型在回合边界有明确、可执行的触发条件。
 */
export function renderSystemHelpText(): string {
    return [
        "[dream-memory] 长期记忆：可复用经验的检索与沉淀工具（会话边界自主决定是否参与）",
        "",
        "WHEN（满足其一就参与，不要犹豫）：",
        "1. 本回合要动手的任务，你怀疑过去（任何项目/任何 session）做过类似的事——先 search_history_experience 检索历史经验，把命中的经验喂给自己再开工。",
        "2. 回合中你得出了“未来愿意复用”的结论，或踩了一个根因清楚的坑——用 commit_task_trace 记一条，让未来的自己避开。",
        "3. 记忆库节点足够多（≥20）且近期检索质量不佳——可 run_dream_optimization 让蒸馏/检索策略自我进化。",
        "",
        "WHEN-NOT（命中任一即不参与））：",
        "1. 纯闲聊、寒暄、没有动手没有结论的回合。",
        "2. 你检索过且记忆库确实没有相关命中（空结果就是答案——保持安静）。",
        "3. 教程/闲聊专用/内部 agent（title/summary/compaction）的回合。",
        "",
        "示例（真实命中时，你会先收到一条 teaser 提示，长这样）：",
        '  [dream-memory] 命中历史：n-ab12cd34 "桌面引擎从不发射 session.idle…"（成功） → 可 search_history_experience 取全文。',
        "",
        "哲学：记忆是为你服务的工具，不是负担。有真实可复用的经验时，调用它几乎总是划算；没有命中时不打扰就是最高效。所有动作都会在合适时机由列表提示，跟不跟着做均可，但一旦看到命中 teaser，通常值得跟进。",
    ].join("\n")
}

export interface MenuRenderInput {
    nodeCount: number
    policyId: string
    replayTrain?: number
    minNodes: number
    maxTokensHint: number
    teaser?: string
}

/**
 * 回合菜单文本。有真实检索命中时附带 teaser（诱导模型自主调用——这是关键触发链），
 * 无命中时退出为空串（不刷屏）。
 */
export function renderMenuText(input: MenuRenderInput): string {
    const { nodeCount, policyId, minNodes, maxTokensHint, teaser } = input
    const replayTrain = input.replayTrain ?? 0
    const sizeLine =
        nodeCount < minNodes
            ? `记忆库当前 ${nodeCount} 条（<${minNodes}），尚未到自动进化阈值`
            : `记忆库 ${nodeCount} 条，策略 ${policyId}，可 run_dream_optimization 自我进化`
    const teaserLine = teaser ? `命中历史：${teaser}` : ""
    return [
        `[dream-memory] ${sizeLine}`,
        teaserLine,
        "可动作（跟不跟着做均可）：",
        "- search_history_experience 检索历史经验",
        "- commit_task_trace 沉淀一条可复用结论",
        "- run_dream_optimization 自我进化检索策略",
        `（菜单注入上限 ${maxTokensHint} tokens；此条为系统提示，不占用回复正文）`,
    ]
        .filter(Boolean)
        .join("\n")
}

/** 蒸馏提示：把一回合素材压缩成一条可复用 JSON 记忆。 */
export function buildDistillPrompt(
    material: CaptureMaterial,
    args: Partial<CommitInput>,
    intent = "",
): string {
    const userText = material.userText ? `用户意图：\n${material.userText}\n` : ""
    const assistantText = material.assistantText ? `助手行为摘要：\n${material.assistantText}\n` : ""
    const toolText =
        material.tools.length > 0
            ? `本次使用的工具：\n${material.tools.map((t) => `- ${t.tool}${t.error ? ` (ERROR: ${t.error})` : ""}`).join("\n")}\n`
            : ""
    const intentText = intent.trim() ? `任务类型提示：${intent.trim()}\n` : ""
    return [
        "你是一个严格的记忆馆藏官。下面是一次真实 coding 会话回合的素材，请抽取成一条可复用的长期记忆。",
        "",
        userText + assistantText + toolText + intentText,
        "规则：",
        "1. summary：一句话概括该回合解决/探索的问题与结论（≤60 字，中英皆可）。",
        "2. outcome：success=目标达成；failed=明确踩坑/失败且根因清楚；partial=有进展但未完成（默认）。",
        "3. why：仅当 outcome=failed 时必填，写明失败根因（≤80 字），供未来避免重蹈。",
        "4. files：该回合实际触碰的文件，必须是项目相对路径；拿不准就留空数组。",
        "5. errorMessage：若失败来自具体报错，原文摘录关键一句；否则 null。",
        "",
        "只输出一个 JSON，不要任何解释/代码块包裹：",
        `{"summary": string, "outcome": ${OUTCOME_VALUES}, "why": string|null, "files": string[], "errorMessage": string|null}`,
    ].join("\n")
}

/** 突变提示：让检索策略自我进化。 */
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
        "你是一个检索策略进化器。现有检索参数如下：",
        values,
        "",
        `当前最薄弱指标：${notes}`,
        "",
        "请提出 ≤2 组互不相同的候选参数，针对性改善薄弱指标，同时遵守硬边界：fileOverlapWeight∈[0,1], ftsScoreWeight∈[0,1], successBoost∈[0,0.4], failureBoost∈[0,0.5], recencyHalfLife∈[20,200], maxRecall∈[1,10], minScore∈[0,0.3]（整数）。",
        "只改动 1-3 个参数，其它保持原值。",
        "",
        '只输出一个 JSON（元素为参数对象）：[ {"fileOverlapWeight":..., ...}, ... ]',
    ].join("\n")
}

/** 解析蒸馏 LLM 返回的 JSON，失败返回 null。 */
export function parseDistillJson(raw: string): DistillResult | null {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
    const start = cleaned.indexOf("{")
    const end = cleaned.lastIndexOf("}")
    if (start < 0 || end <= start) return null
    try {
        const obj = JSON.parse(cleaned.slice(start, end + 1)) as Partial<DistillResult>
        if (typeof obj.summary !== "string" || !obj.summary.trim()) return null
        const summary = obj.summary.trim().slice(0, 60)
        const outcome = obj.outcome === "success" || obj.outcome === "failed" ? obj.outcome : "partial"
        const why = typeof obj.why === "string" && obj.why.trim() ? obj.why.trim().slice(0, 80) : undefined
        const files = Array.isArray(obj.files) ? obj.files.filter((f): f is string => typeof f === "string").slice(0, 12) : []
        const errorMessage = typeof obj.errorMessage === "string" && obj.errorMessage.trim() ? obj.errorMessage.trim().slice(0, 160) : undefined
        return {
            summary,
            outcome,
            why,
            files,
            errorMessage,
        }
    } catch {
        return null
    }
}
