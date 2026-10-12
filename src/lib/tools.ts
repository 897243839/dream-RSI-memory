import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { captureTurn, extractNodeFields, type FileCollector } from "./capture.js"
import { runDream } from "./dream.js"
import type { Logger } from "./logger.js"
import type { MetaLlm } from "./meta-llm.js"
import { nodeDetailText, replayOptsOf, statusText } from "./report.js"
import { getStage } from "./stages.js"
import type { MemoryStore } from "./store.js"
import { checkPropose } from "./strategy.js"
import type { AdviceRecord, CommitInput, NodeRecord, Outcome } from "./types.js"
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
            "[dream-rsi-memory] 把当前回合（或指定的探索/踩坑/结论）记入长期记忆决策树节点。可在回合中获得新结论后调用；不传 summary/outcome 时会自动从对话素材中提取结构化字段。聊天命令等价：/dream commit <结论摘要>。",
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
            if (!sessionID) return "[dream-rsi-memory] 缺少 sessionID，无法记录。"
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
                `[dream-rsi-memory] 已记录节点 ${node.nodeId}（turn ${node.turnIndex}，${outcomeLabel(node.outcome)}）` +
                (providedFiles.length ? `，关联 ${providedFiles.length} 个文件` : "") +
                `\nsummary：${node.summary}`
            )
        },
    })

    // ---------------------------------------------------------------- search
    const searchTool = tool({
        description:
            "[dream-rsi-memory] 在长期记忆决策树中检索过去相似任务的经验。开工前或卡壳时调用：按文件重合 + 语义/报错相似度 + 结果好坏加权排序，返回最近相关的历史节点。聊天命令等价：/dream search <关键词>。",
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
            const hits = store.search(args.query, files, { limit, log: { trigger: "tool" } })

            const lines = [`[dream-rsi-memory] 检索得 ${hits.length} 条历史经验（策略 ${policy.policyId}）：`]
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
            // 策略集命中时注入该 set 的最新分支建议（§8）；adviceLog 为空则不注入，普通经验命中行为不变。
            const adviceLog = store.getAdviceLog()
            if (adviceLog.length > 0) {
                for (const hit of hits) {
                    if (hit.node.type !== "strategy_set") continue
                    let latest: AdviceRecord | undefined
                    for (const a of adviceLog) {
                        if (a.setId !== hit.node.nodeId) continue
                        if (!latest || a.createdAt > latest.createdAt) latest = a
                    }
                    if (!latest) continue
                    lines.push(
                        `  ▸ 分支建议（${hit.node.nodeId}）：推荐 ${latest.recommendedAltName}，margin ${latest.margin.toFixed(3)}，${latest.autoSwitched ? "已自动切换" : "未自动切换"}`,
                    )
                }
            }
            if (hits.length === 0) {
                lines.push("  无结果。可先 dream_rsi_memory_commit 记录当前局面，或换关键词/加文件路径重试。")
            } else {
                const topScore = hits[0].score
                // P0：S 播种期（n<5）劝 search/commit，避免撞 S 期"证据不足"返回；
                // dream.enabled=false 同样不劝 dream；M/F 期照常劝 dream。
                const stage = getStage(store.count(), config.dream)
                const dreamSuggestable = config.dream.enabled && stage !== "S"
                const low = dreamSuggestable
                    ? `建议 dream_rsi_memory_dream 进化策略`
                    : `建议 dream_rsi_memory_commit 沉淀当前局面，或 dream_rsi_memory_search 换关键词重试`
                const medium = dreamSuggestable
                    ? `可 dream_rsi_memory_dream 优化策略`
                    : `可 dream_rsi_memory_commit 记录当前局面，或 dream_rsi_memory_search 加文件路径重试`
                if (topScore < 0.15) {
                    lines.push(`\n  ⚠ 检索质量低（top=${topScore.toFixed(3)}），${low}`)
                } else if (topScore < 0.3) {
                    lines.push(`\n  检索质量一般（top=${topScore.toFixed(3)}），${medium}`)
                }
            }
            return lines.join("\n")
        },
    })

    // ------------------------------------------------------------ inspect
    const inspectTool = tool({
        description: "[dream-rsi-memory] 查看某个记忆节点的完整详情（摘要、根因、报错、文件、父分支）。",
        args: { node_id: s.string().describe("节点 id，例如 n-ab12cd34") },
        async execute(args, _ctx) {
            return nodeDetailText(store, args.node_id)
        },
    })

    // ------------------------------------------------------------ status
    const statusTool = tool({
        description: "[dream-rsi-memory] 查看记忆库状态：节点统计、当前检索策略与参数、replay 指标、最近一次做梦结果。",
        args: {},
        async execute() {
            return statusText(store, config)
        },
    })

    // ------------------------------------------------------------ switch
    const switchTool = tool({
        description: "[dream-rsi-memory] 手动切换检索策略（参数组）。列出候选用搜 history，或 /memory policy。",
        args: { policy_id: s.string().describe("策略 id，例如 p-default") },
        async execute(args, _ctx) {
            const prev = store.activePolicy()
            const next = store.setActivePolicy(args.policy_id)
            if (!next) {
                const available = store
                    .listPolicies()
                    .map((p) => p.policyId)
                    .join(", ")
                return `[dream-rsi-memory] 策略 ${args.policy_id} 不存在。可用：${available || "（无）"}`
            }
            return `[dream-rsi-memory] 检索策略 ${prev.policyId} → ${next.policyId}\n新参数：${JSON.stringify(next.params)}`
        },
    })
// ------------------------------------------------------------ dream
    const dreamTool = tool({
        description:
            "[dream-rsi-memory] 触发一次“做梦”：在严格时间线 holdout 上评估候选检索策略，仅当 train 与 valid 上都有稳健提升才切换策略（不退化保证）。可用 focus 指定优先改善的方面。",
        args: { focus: s.string().optional().describe("可选：希望优先改善的方面（file recall / failure avoid / precision / budget）；省略时自动取最薄弱指标") },
        async execute(args, ctx) {
            // §6.1 工具层从不 throw：runDream 内部已兜一层（running→failed），这里再套一层防御。
            try {
                const result = await runDream(store, config, {
                    logger,
                    meta,
                    focus: args.focus,
                    // P0：会话 id 必须接进 dream，否则 resolveActiveAlt 恒 null →
                    // canAutoSwitch 条件 3 恒 false → 全自动切换永不触发。
                    sessionId: ctx.sessionID || undefined,
                })
                return result.text
            } catch (error) {
                logger.error("dream tool failed", { error: String(error) })
                return `[dream-rsi-memory] dream 执行失败：${String(error)}`
            }
        },
    })

    // ------------------------------------------------ strategy propose (§5.1)
    const proposeTool = tool({
        description:
            "[dream-rsi-memory] 设计决策候选入库：把 3~10 个筛后的可靠候选方案（各含 approach/tradeoffs/estimatedRisk）作为一个策略集写入记忆树。检索确认库中没有该问题的候选后调用；入库后用 dream_rsi_memory_strategy_pick 定为当前分支。",
        args: {
            problem: s.string().describe("设计决策问题陈述（≤80 字）"),
            alternatives: s
                .array(
                    s.object({
                        name: s.string().describe("候选名（≤20 字，set 内唯一）"),
                        approach: s.string().describe("实现路径（≤300 字）"),
                        tradeoffs: s.string().describe("代价/取舍（≤200 字）"),
                        estimatedRisk: s.string().describe("预估风险（≤200 字）"),
                    }),
                )
                .describe("3~10 个筛后的可靠候选短名单"),
            provisionalPick: s.string().optional().describe("冷启动预选的候选 name，必须在 alternatives 中"),
            parentId: s.string().optional().describe("set 节点挂哪，省略走既有默认（最近节点）"),
        },
        async execute(args, ctx) {
            const { sessionID, agent } = ctx
            if (!sessionID) return "[dream-rsi-memory] 缺少 sessionID，无法入库候选。"
            const check = checkPropose(
                {
                    problem: args.problem,
                    alternatives: args.alternatives,
                    provisionalPick: args.provisionalPick,
                },
                store.listSetMetas(),
            )
            if (!check.ok) return `[dream-rsi-memory] ${check.reason}`
            const { setId, altIds } = store.proposeStrategySet({
                problem: args.problem,
                alts: args.alternatives,
                provisionalPick: args.provisionalPick,
                parentId: args.parentId,
                sessionId: sessionID,
                agentName: agent ?? "unknown",
            })
            return (
                `[dream-rsi-memory] 策略集 ${setId} 已入库，候选节点：${altIds.join(", ")}` +
                `\n候选已入库（均为 unproven），请用 dream_rsi_memory_strategy_pick 将其中之一定为当前分支。`
            )
        },
    })

    // ------------------------------------------------- strategy pick (§5.2)
    const pickTool = tool({
        description:
            "[dream-rsi-memory] 把策略集中的某个候选定为当前分支（冷启动选定 / 撞墙手动换路）。被换下的旧分支按 verdict 记为 superseded（让位，不计失败）或 rejected（真实证伪，计入失败）。",
        args: {
            setId: s.string().describe("策略集节点 id，例如 n-ab12cd34"),
            altName: s.string().describe("候选 name（需属于该策略集）"),
            reason: s.string().optional().describe("选定/切换理由"),
            verdict: s
                .union([s.literal("superseded"), s.literal("rejected")])
                .optional()
                .describe("被让位旧分支的判定：superseded=主动让位（默认） rejected=真实证伪"),
        },
        async execute(args, ctx) {
            const { sessionID, agent } = ctx
            if (!sessionID) return "[dream-rsi-memory] 缺少 sessionID，无法切换分支。"
            const res = store.pickStrategy({
                setId: args.setId,
                altName: args.altName,
                reason: args.reason,
                verdict: args.verdict,
                sessionId: sessionID,
                agentName: agent ?? "unknown",
            })
            if (!res) {
                const setMetas = store.listSetMetas()
                const set = setMetas.find((m) => m.setId === args.setId)
                if (!set) {
                    const available = setMetas.map((m) => m.setId).join(", ")
                    return `[dream-rsi-memory] 策略集 ${args.setId} 不存在。可用：${available || "（无）"}`
                }
                const altNames = set.altIds
                    .map((id) => store.getNode(id)?.name)
                    .filter((n): n is string => !!n)
                    .join(", ")
                if (!set.altIds.some((id) => store.getNode(id)?.name === args.altName)) {
                    return `[dream-rsi-memory] 候选 ${args.altName} 不属于策略集 ${args.setId}。可用：${altNames || "（无）"}`
                }
                // altName 属于该 set 却仍返回 undefined：set 存在 + 成员匹配已被上面两条拦掉，
                // 此处只可能是目标 status=rejected（真实证伪，不可再选）；chosen/superseded 都会返回成功对象。
                const selectable = set.altIds
                    .map((id) => store.getNode(id))
                    .filter(
                        (n): n is NodeRecord =>
                            !!n && !!n.name && (n.status ?? "unproven") !== "rejected",
                    )
                    .map((n) => `${n.name}(${n.status ?? "unproven"})`)
                    .join(", ")
                return `[dream-rsi-memory] 候选 ${args.altName} 已被证伪（status=rejected），不可再选为当前分支。可选候选：${selectable || "（无）"}（status 为 unproven/chosen/superseded）`
            }
            const head = res.previousAlt
                ? `[dream-rsi-memory] 分支切换：${res.previousAlt} → ${res.currentAlt}`
                : `[dream-rsi-memory] 已选定分支 ${res.currentAlt}`
            return head + (res.note ? `\n${res.note}` : "")
        },
    })

    return {
        dream_rsi_memory_commit: commitTool,
        dream_rsi_memory_search: searchTool,
        dream_rsi_memory_node: inspectTool,
        dream_rsi_memory_status: statusTool,
        dream_rsi_memory_policy: switchTool,
        dream_rsi_memory_dream: dreamTool,
        dream_rsi_memory_strategy_propose: proposeTool,
        dream_rsi_memory_strategy_pick: pickTool,
    }
}