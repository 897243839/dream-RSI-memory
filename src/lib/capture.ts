import type { CaptureMaterial, Outcome } from "./types.js"
import { tail, truncate } from "./utils.js"

interface PartLike {
    type?: string
    text?: string
    tool?: string
    state?: { status?: string }
}

interface MessageLike {
    id: string
    role: string
    summary?: boolean
    parts?: PartLike[]
}

interface MessageResponseLike {
    data?: MessageLike[]
    [key: string]: unknown
}

/**
 * Fetch the tail of a session and isolate the most recent user turn: the last
 * user message plus all assistant parts after it (text for extraction, tools).
 */
export async function captureTurn(client: unknown, sessionID: string, maxChars: number): Promise<CaptureMaterial> {
    let raw: MessageLike[] = []
    try {
        const clientAny = client as {
            session: { messages(options?: unknown): Promise<MessageResponseLike> }
        }
        const response = await clientAny.session.messages({ path: { id: sessionID } })
        raw = response?.data ?? []
    } catch {
        // session read failed — return empty material, caller logs
    }

    const userParts: string[] = []
    const assistantParts: string[] = []
    const tools: { tool: string; error?: string }[] = []
    let sawUser = false

    for (let i = raw.length - 1; i >= 0; i--) {
        const message = raw[i]
        if (message.summary === true) continue
        const parts = message.parts ?? []
        if (message.role === "user") {
            if (sawUser) break
            sawUser = true
            for (const part of parts) if (part.type === "text" && part.text) userParts.push(part.text)
        } else if (message.role === "assistant") {
            if (sawUser) continue // parts before the most recent user message belong to earlier turns
            for (const part of parts) {
                if (part.type === "text" && part.text) assistantParts.push(part.text)
                else if (part.type === "tool" && part.tool) {
                    tools.push({
                        tool: part.tool,
                        error: part.state?.status === "error" ? "failed" : undefined,
                    })
                }
            }
        }
    }

    const budget = Math.max(Math.floor(maxChars / 2), 500)
    return {
        userText: tail(userParts.join("\n"), budget),
        assistantText: tail(assistantParts.join("\n"), maxChars - budget),
        tools,
    }
}

/**
 * Pure-computation extraction of structured node fields from captured material.
 * No LLM call — rules-based, instant, deterministic.
 */
export function extractNodeFields(material: CaptureMaterial): {
    summary: string
    outcome: Outcome
    why: string | undefined
    errorMessage: string | undefined
} {
    const raw = (material.assistantText || material.userText || "").replace(/\s+/g, " ").trim()
    const summary = truncate(raw, 60) || "（无内容）"

    const hasError = material.tools.some((t) => t.error)
    const allToolsOk = material.tools.length > 0 && !hasError
    const outcome: Outcome = hasError ? "failed" : allToolsOk ? "success" : "partial"

    const errorMessage = material.tools.find((t) => t.error)?.error
    const why = hasError ? truncate(errorMessage ?? "未知错误", 80) : undefined

    return { summary, outcome, why, errorMessage }
}

/** Collects file paths touched by edit/write tools per session, for commit enrichment. */
export class FileCollector {
    private files = new Map<string, string[]>()

    add(sessionID: string, file: string): void {
        if (!file) return
        const list = this.files.get(sessionID) ?? []
        list.push(file)
        this.files.set(sessionID, list)
    }

    has(sessionID: string): boolean {
        const list = this.files.get(sessionID)
        return !!list && list.length > 0
    }

    /** Read the collected files without clearing them (used by the teaser hint). */
    peek(sessionID: string): string[] {
        return this.files.get(sessionID) ?? []
    }

    take(sessionID: string): string[] {
        const list = this.files.get(sessionID) ?? []
        this.files.delete(sessionID)
        return list
    }
}