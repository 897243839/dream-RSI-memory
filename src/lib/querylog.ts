import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * queryLog（P2）：记录每一次**用户面**检索出口（工具 / 命令 / teaser）的
 * 查询原文、当时生效的策略与返回结果，落盘为 `dataDir/<projectId>/querylog.jsonl`
 * （每行一个 JSON）。仅此三处触发；内部评估（status / menuStats 的 replay 打分、
 * dream 的候选评估）绝不落盘。
 *
 * 为二期 P3a（跨 cycle 慢调回路）预留的消费口：`policyId` 可聚合每策略在线战绩
 * （store.onlineStats），`ts`/`turnIndex`/`query` 可重建历史可见集做真实查询回放
 * （replay.ts 的 evalRealCases）。
 */
export interface QueryLogResult {
    nodeId: string
    rank: number
    score: number
}

export type QueryTrigger = "tool" | "command" | "teaser"

export interface QueryLogEntry {
    ts: string
    /** 检索发生时的当前 turn（最后已 commit 节点的 turnIndex）；拿不到记 null。 */
    turnIndex: number | null
    query: string
    policyId: string
    trigger: QueryTrigger
    results: QueryLogResult[]
}

export function queryLogPath(projectDir: string): string {
    return join(projectDir, "querylog.jsonl")
}

/**
 * 追加一行；append 后若超过 max 则裁掉最旧的行。
 * 日志写入绝不允许打断检索主流程：任何错误在这里吞掉，由调用方决定是否记日志。
 * 返回实际写入是否成功。
 */
export function appendQueryLog(projectDir: string, entry: QueryLogEntry, max: number): boolean {
    try {
        const file = queryLogPath(projectDir)
        appendFileSync(file, JSON.stringify(entry) + "\n", "utf8")
        const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1000
        const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "")
        if (lines.length > limit) {
            writeFileSync(file, lines.slice(-limit).join("\n") + "\n", "utf8")
        }
        return true
    } catch {
        return false
    }
}

/** 读取全部查询日志；文件缺失/损坏行一律容错（坏行跳过）。 */
export function readQueryLog(projectDir: string): QueryLogEntry[] {
    try {
        const file = queryLogPath(projectDir)
        if (!existsSync(file)) return []
        const out: QueryLogEntry[] = []
        for (const line of readFileSync(file, "utf8").split("\n")) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
                const parsed = JSON.parse(trimmed) as Partial<QueryLogEntry>
                if (
                    typeof parsed?.query === "string" &&
                    typeof parsed?.policyId === "string" &&
                    typeof parsed?.ts === "string" &&
                    (parsed.trigger === "tool" || parsed.trigger === "command" || parsed.trigger === "teaser") &&
                    Array.isArray(parsed.results)
                ) {
                    out.push(parsed as QueryLogEntry)
                }
            } catch {
                // 坏行跳过
            }
        }
        return out
    } catch {
        return []
    }
}
