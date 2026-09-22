import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { captureTurn, extractNodeFields, type FileCollector } from "./capture.js"
import { runDream } from "./dream.js"
import type { Logger } from "./logger.js"
import type { MetaLlm } from "./meta-llm.js"
import { nodeDetailText, replayOptsOf, statusText } from "./report.js"
import type { MemoryStore } from "./store.js"
import type { CommitInput, Outcome } from "./types.js"
import { normalizeFiles, truncate } from "./utils.js"

export interface ToolDeps {
    client: unknown
    store: MemoryStore
    config: ReturnType<typeof import("./config.js").resolveConfig>
    logger: Logger
    collector: FileCollector
    meta: MetaLlm
}

function outcomeLabel(outcome: Outcome): string {
    return outcome === "success" ? "成功" : outcome === "failed" ? "失败" : "部分完成"
}

export function createTools(deps: {
    client: unknown
    store: MemoryStore
    config: ReturnType<typeof import("./config.js").resolveConfig>
    logger: Logger
    collector: FileCollector
    meta: MetaLlm
}): Record<string, ToolDefinition> {
    const { client, store, config, logger, collector, meta } = deps
    const s = tool.schema

    // ------------------------------------------------------------------ commit
    const commitTool = tool({
        description:
            "[dream-memory] 把当前回合（或指定的探索/踩坑/结论）记入长期记忆决策树节点。可在回合中获得新结论后调用；不传 summary/outcome 时会自动从对话素材中提取结构化字段。聊天命令等价：/dream commit <结论摘要>。",
        args: {
            summary: s.string().optional().describe("一句话结论（≤60 字）。留空则从对话自动提取"),
            files: s.array(s.string()).optional().describe("本回合实际触碰的文件路径（项目相对或绝对）"),
            outcome: s
                .union([s.literal("success"), s.literal("failed"), s.literal("partial")])
                .optional()
                .describe("success=目标达成 failed=踩坑且根因清楚 partial=有进展未完成"),
            why: s.string().optional().describe("outcome=failed 时的失败根因；其它结果可省略"),
            errorMessage: s.string().optional().describe("失败时原始报错的关键一句"),
            score: s.number().optional().describe("自评质量分 0~1，可省略"),
            parentId: s.string().optional().describe("父节点 id，省略则接到最近节点"),
            branchId: s.string().optional().describe("显式分支 id，用于分叉新探索路线"),
        },
        async execute(args, ctx) {
            const { sessionID, agent, worktree } = ctx
            const touched = collector.take(sessionID)
            const providedFiles = normalizeFiles(worktree, [...(args.files ?? []), ...touched])

            const material = await captureTurn(client, sessionID, config.capture.maxMaterialChars)
            const extracted = extractNodeFields(material)

            const summary = args.summary?.trim() || extracted.summary
            const outcome: Outcome = args.outcome || extracted.outcome
            let why = args.why?.trim() || extracted.why
            if (outcome === "failed" && !why) why = "（失败：模型未记录根因，建议回看该节点 errorMessage）"

            const input: CommitInput = {
                summary,
                files: providedFiles,
                outcome,
                why,
                errorMessage: args.errorMessage?.trim() || extracted.errorMessage,
                score: args.score,
                parentId: args.parentId,
                branchId: args.branchId,
                sessionId: sessionID,
                agentName: agent,
            }
            const node = store.commit(input)

            return (
                `[dream-memory] 已记录节点 ${node.nodeId}（turn ${node.turnIndex}，${outcomeLabel(node.outcome)}）` +
                (providedFiles.length ? `，关联 ${providedFiles.length} 个文件` : "") +
                `\nsummary：${node.summary}`
            )
        },
    })

    // ---------------------------------------------------------------- search
    const searchTool = tool({
        description:
            "[dream-memory] 在长期记忆决策树中检索过去相似任务的经验。开工前或卡壳时调用：按文件重合 + 语义/报错相似度 + 结果好坏加权排序，返回最近相关的历史节点。聊天命令等价：/dream search <关键词>。",
        args: {
            query: s.string().describe("检索意图/问题描述，尽量包含关键动作或领域词"),
            files: s.array(s.string()).optional().describe("涉及的文件路径，用于文件重合度匹配"),
            limit: s.number().optional().describe("返回条数上限（1~10，默认取当前策略 maxRecall）"),
        },
        async execute(args, ctx) {
            const { sessionID, worktree } = ctx
            const touched = collector.take(sessionID)
            const files = normalizeFiles(worktree, [...(args.files ?? []), ...touched])
            const policy = store.activePolicy()
            const requested = args.limit ?? policy.params.maxRecall
            const limit = Math.min(Math.max(Math.round(requested), 1), 10)
            const hits = store.search(args.query, files, { limit })

            const lines = [`[dream-memory] 检索得 ${hits.length} 条历史经验（策略 ${policy.policyId}）：`]
            for (const hit of hits) {
                const tag = [
                    hit.fileMatch ? "文件重合" : "",
                    hit.failureSimilar ? "同类失败" : "",
                ]
                    .filter(Boolean)
                    .join("|")
                lines.push(
                    `• ${hit.node.nodeId} (turn ${hit.node.turnIndex}, ${hit.node.outcome}, score ${hit.score.toFixed(3)})${tag ? " [" + tag + "]" : ""}\n` +
                        `  ${truncate(hit.node.summary || "（无摘要）", 160)}` +
                        (hit.node.why ? `\n  教训：${truncate(hit.node.why, 140)}` : "") +
                        (hit.node.files.length ? `\n  文件：${hit.node.files.slice(0, 3).join(", ")}` : ""),
                )
            }
            if (hits.length === 0) {
                lines.push("  无结果。可先 dream_memory_commit 记录当前局面，或换关键词/加文件路径重试。")
            } else {
                const topScore = hits[0].score
                if (topScore < 0.15) {
                    lines.push(`\n  ⚠ 检索质量低（top=${topScore.toFixed(3)}），建议 dream_memory_dream 进化策略`)
                } else if (topScore < 0.3) {
                    lines.push(`\n  检索质量一般（top=${topScore.toFixed(3)}），可 dream_memory_dream 优化策略`)
                }
            }
            return lines.join("\n")
        },
    })

    // ------------------------------------------------------------ inspect
    const inspectTool = tool({
        description: "[dream-memory] 查看某个记忆节点的完整详情（摘要、根因、报错、文件、父分支）。",
        args: { node_id: s.string().describe("节点 id，例如 n-ab12cd34") },
        async execute(args, _ctx) {
            return nodeDetailText(store, args.node_id)
        },
    })

    // ------------------------------------------------------------ status
    const statusTool = tool({
        description: "[dream-memory] 查看记忆库状态：节点统计、当前检索策略与参数、replay 指标、最近一次做梦结果。",
        args: {},
        async execute() {
            return statusText(store, config)
        },
    })

    // ------------------------------------------------------------ switch
    const switchTool = tool({
        description: "[dream-memory] 手动切换检索策略（参数组）。列出候选用搜 history，或 /memory policy。",
        args: { policy_id: s.string().describe("策略 id，例如 p-default") },
        async execute(args, _ctx) {
            const prev = store.activePolicy()
            const next = store.setActivePolicy(args.policy_id)
            if (!next) {
                const available = store
                    .listPolicies()
                    .map((p) => p.policyId)
                    .join(", ")
                return `[dream-memory] 策略 ${args.policy_id} 不存在。可用：${available || "（无）"}`
            }
            return `[dream-memory] 检索策略 ${prev.policyId} → ${next.policyId}\n新参数：${JSON.stringify(next.params)}`
        },
    })
// ------------------------------------------------------------ dream
    const dreamTool = tool({
        description:
            "[dream-memory] 触发一次“做梦”：在严格时间线 holdout 上评估候选检索策略，仅当 train 与 valid 上都有稳健提升才切换策略（不退化保证）。可用 focus 指定优先改善的方面。",
        args: { focus: s.string().optional().describe("可选：希望优先改善的方面（file recall / failure avoid / precision / budget）；省略时自动取最薄弱指标") },
        async execute(args, _ctx) {
            const result = await runDream(store, config, { logger, meta, focus: args.focus })
            return result.text
        },
    })

    return {
        dream_memory_commit: commitTool,
        dream_memory_search: searchTool,
        dream_memory_node: inspectTool,
        dream_memory_status: statusTool,
        dream_memory_policy: switchTool,
        dream_memory_dream: dreamTool,
    }
}