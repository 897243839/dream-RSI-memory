import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { captureTurn, type FileCollector } from "./capture.js"
import { runDream } from "./dream.js"
import type { Logger } from "./logger.js"
import type { MetaLlm } from "./meta-llm.js"
import { nodeDetailText, replayOptsOf, statusText } from "./report.js"
import type { MemoryStore } from "./store.js"
import type { CommitInput, Outcome } from "./types.js"
import { dedupe, normalizeProjectPath, truncate } from "./utils.js"

export interface ToolDeps {
    client: unknown
    store: MemoryStore
    config: ReturnType<typeof import("./config.js").resolveConfig>
    logger: Logger
    collector: FileCollector
    meta: MetaLlm
}

function normalizeFiles(root: string, files: string[]): string[] {
    const out: string[] = []
    for (const file of files) {
        const norm = normalizeProjectPath(root, file)
        if (norm) out.push(norm)
    }
    return dedupe(out)
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
            "[dream-memory] 把当前回合（或指定的探索/踩坑/结论）记入长期记忆决策树节点。可在回合中获得新结论后调用；不传 summary/outcome 时会自动抓最近对话素材，在后台由小模型补全标注。",
        args: {
            summary: s.string().optional().describe("一句话结论（≤60 字）。留空则由后台补全"),
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
            distill: s.boolean().optional().describe("是否允许后台小模型补全标注（默认 true）"),
        },
        async execute(args, ctx) {
            const { sessionID, agent, worktree } = ctx
            const touched = collector.take(sessionID)
            const providedFiles = normalizeFiles(worktree, [...(args.files ?? []), ...touched])
            const outcome: Outcome = args.outcome ?? "partial"

            let why = args.why?.trim()
            if (outcome === "failed" && !why) why = "（失败：模型未记录根因，建议回看该节点 errorMessage）"
            let summary = args.summary?.trim()
            if (!summary) summary = `auto: ${truncate(await captureMaterialText(), 96)}`

            const input: CommitInput = {
                summary,
                files: providedFiles,
                outcome,
                why,
                errorMessage: args.errorMessage?.trim() || undefined,
                score: args.score,
                parentId: args.parentId,
                branchId: args.branchId,
                sessionId: sessionID,
                agentName: agent,
            }
            const node = store.commit(input)

            const wantDistill = args.distill !== false
            const needsDistill = meta.configured && wantDistill && (!args.summary?.trim() || (outcome === "failed" && !args.why?.trim()))
            if (needsDistill) {
                store.patchNode(node.nodeId, { distillPending: true })
                const material = await captureTurn(client, sessionID, config.distill.maxMaterialChars)
                void (async () => {
                    try {
                        const draft = await meta.distill(material, args)
                        if (draft) {
                            const patch: Record<string, unknown> = { distillPending: false }
                            if (!args.summary?.trim() && draft.summary) patch.summary = draft.summary
                            if (!args.why?.trim() && draft.why) patch.why = draft.why
                            if (outcome === "partial" && draft.outcome && draft.outcome !== "partial") patch.outcome = draft.outcome
                            if (!args.errorMessage?.trim() && draft.errorMessage) patch.errorMessage = draft.errorMessage
                            if (draft.files && draft.files.length) {
                                const draftFiles = normalizeFiles(worktree, draft.files)
                                patch.files = dedupe([...(node.files ?? []), ...draftFiles])
                            }
                            store.patchNode(node.nodeId, patch)
                        } else {
                            store.patchNode(node.nodeId, { distillPending: false })
                        }
                    } catch (error) {
                        store.patchNode(node.nodeId, { distillPending: false })
                        logger.warn("background distill failed", { error: String(error), nodeId: node.nodeId })
                    }
                })()
            }

            return (
                `[dream-memory] 已记录节点 ${node.nodeId}（turn ${node.turnIndex}，${outcomeLabel(node.outcome)}）` +
                (providedFiles.length ? `，关联 ${providedFiles.length} 个文件` : "") +
                (needsDistill ? "，后台小模型正在补全标注" : "") +
                `\nsummary：${node.summary}`
            )

            async function captureMaterialText(): Promise<string> {
                try {
                    const material = await captureTurn(client, sessionID, config.distill.maxMaterialChars)
                    return material.assistantText || material.userText || "（无内容）"
                } catch {
                    return "（无内容）"
                }
            }
        },
    })

    // ---------------------------------------------------------------- search
    const searchTool = tool({
        description:
            "[dream-memory] 在长期记忆决策树中检索过去相似任务的经验。开工前或卡壳时调用：按文件重合 + 语义/报错相似度 + 结果好坏加权排序，返回最近相关的历史节点。",
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
            if (hits.length === 0) lines.push("  无结果。可先 commit_task_trace 记录当前局面，或换关键词/加文件路径重试。")
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
        commit_task_trace: commitTool,
        search_history_experience: searchTool,
        inspect_node_detail: inspectTool,
        dream_status: statusTool,
        switch_policy: switchTool,
        run_dream_optimization: dreamTool,
    }
}