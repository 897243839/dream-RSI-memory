import { runReplay } from "./replay.js"
import type { MemoryStore } from "./store.js"
import type { MemoryConfig } from "./types.js"
import { truncate } from "./utils.js"

export function replayOptsOf(config: MemoryConfig): { trainRatio: number; weights: MemoryConfig["replayWeights"] } {
    return { trainRatio: config.dream.trainRatio, weights: config.replayWeights }
}

export function nodeStatsText(store: MemoryStore): string {
    const counts = { success: 0, failed: 0, partial: 0 }
    for (const node of store.sortedNodes()) {
        if (node.outcome in counts) counts[node.outcome as keyof typeof counts]++
    }
    return `节点 ${store.count()} 个（success ${counts.success} / failed ${counts.failed} / partial ${counts.partial}）`
}

export function statusText(store: MemoryStore, config: MemoryConfig): string {
    const active = store.activePolicy()
    const report = runReplay(store, active.params, replayOptsOf(config))
    const autoCount = store
        .sortedNodes()
        .reduce((sum, n) => (n.autoCreated ? sum + 1 : sum), 0)
    const lines = [
        "[dream-memory] 项目记忆库",
        `  ${nodeStatsText(store)}${autoCount ? `（其中 idle 自动采集 ${autoCount} 个）` : ""}`,
        `  当前策略：${active.policyId}`,
        `  params：${JSON.stringify(active.params)}`,
        `  replay：train=${report.train.totalScore.toFixed(3)}` +
            (report.valid ? ` valid=${report.valid.totalScore.toFixed(3)}` : "") +
            (report.n === 0 ? "（暂无节点）" : "（4 指标：fileHitRate+failureAvoidRate+precision+recallBudget）"),
    ]
    const warn = store.watchdogNotice(active.policyId, report.train.totalScore, 2 * config.dream.epsilon)
    if (warn) lines.push(`  ⚠ ${warn}`)
    const latest = store.latestDream()
    if (latest) {
        lines.push(
            `  最近做梦：${latest.runId} ${latest.status}` +
                (latest.chosenPolicyId ? " → " + latest.chosenPolicyId : "") +
                (latest.notes ? " · " + latest.notes : ""),
        )
    }
    return lines.join("\n")
}

export function policyListText(store: MemoryStore): string {
    const policies = store.listPolicies()
    const lines = ["[dream-memory] 策略列表（dreamRound 升序）："]
    if (policies.length === 0) lines.push("  （无）")
    for (const p of policies) {
        lines.push(`  ${p.policyId}${p.isActive ? " (active)" : ""} — ${JSON.stringify(p.params)}${p.parentPolicyId ? ` \u2190 ${p.parentPolicyId}` : ""}`)
    }
    return lines.join("\n")
}

export function nodeDetailText(store: MemoryStore, nodeId: string): string {
    const node = store.getNode(nodeId)
    if (!node) return `[dream-memory] 节点 ${nodeId} 不存在。`
    const lines: (string | null)[] = [
        `[dream-memory] 节点 ${node.nodeId}`,
        `  turn ${node.turnIndex} · ${node.outcome} · agent=${node.agentName} · session ${node.sessionId.slice(0, 8)}`,
        `  summary：${node.summary}`,
        `  why：${node.why ?? "—"}`,
        node.errorMessage ? `  error：${truncate(node.errorMessage, 200)}` : null,
        node.files.length ? `  files：${node.files.join(", ")}` : null,
        node.parentId ? `  parent：${node.parentId}` : null,
        node.branchId ? `  branch：${node.branchId}` : null,
    ]
    return lines.filter((l): l is string => !!l).join("\n")
}

export function dreamHelpText(): string {
    return [
        "用法：",
        "  /dream status   — 记忆库+replay 概览",
        "  /dream run      — 立即触发一次做梦优化（需足够节点）",
        "  /memory stats   — 节点统计与当前策略",
        "  /memory policy  — 全部策略列表",
        "  /memory show <nodeId> — 查看某节点详情",
    ].join("\n")
}