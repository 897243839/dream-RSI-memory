import type { Logger } from "./logger.js"
import type { MemoryConfig, RecallParams } from "./types.js"
import { buildMutationPrompt } from "./prompts.js"
import { clampParams } from "./utils.js"

interface PartLike {
    type?: string
    text?: string
}

interface MessageLike {
    id: string
    role: string
    summary?: boolean
    time?: { created?: number }
    parts?: PartLike[]
}

function textOf(message: MessageLike): string {
    const parts = message.parts ?? []
    return parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join("\n")
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Background helper for dreaming: parameter mutation via a hidden LLM session (created per-call, auto-cleaned). */
export class MetaLlm {
    constructor(
        private readonly client: unknown,
        private readonly config: MemoryConfig,
        private readonly logger: Logger,
        private readonly directory: string,
    ) {}

    get configured(): boolean {
        const c = this.config.curator
        return c.enabled && !!c.providerID && !!c.modelID
    }

    private modelField(): { providerID: string; modelID: string } | undefined {
        const c = this.config.curator
        if (!c.providerID || !c.modelID) return undefined
        return { providerID: c.providerID, modelID: c.modelID }
    }

    private async createTempSession(): Promise<string | null> {
        try {
            const clientAny = this.client as {
                session: {
                    create(options: { body?: { title?: string }; query?: { directory?: string } }): Promise<{ data?: { id: string } }>
                }
            }
            const created = await clientAny.session.create({
                body: { title: "dream-memory-mutate" },
                query: { directory: this.directory },
            })
            return created?.data?.id ?? null
        } catch (error) {
            this.logger.error("mutate session create failed", { error: String(error) })
            return null
        }
    }

    private async deleteTempSession(sessionId: string): Promise<void> {
        try {
            const clientAny = this.client as {
                session: { delete(options: { path: { id: string } }): Promise<unknown> }
            }
            await clientAny.session.delete({ path: { id: sessionId } })
        } catch {
            /* ignore — session may have expired */
        }
    }

    private async runHidden(promptText: string): Promise<string | null> {
        const sessionId = await this.createTempSession()
        if (!sessionId) return null

        const sentAt = Date.now()
        try {
            const clientAny = this.client as {
                session: {
                    prompt(options: unknown): Promise<unknown>
                    messages(options: unknown): Promise<{ data?: MessageLike[] }>
                }
            }
            await clientAny.session.prompt({
                path: { id: sessionId },
                body: {
                    model: this.modelField(),
                    parts: [{ type: "text", text: promptText, ignored: true }],
                },
            })

            const deadline = Date.now() + this.config.curator.timeoutMs
            let lastText: string | null = null
            while (Date.now() < deadline) {
                await sleep(700)
                const response = await clientAny.session.messages({ path: { id: sessionId } })
                const messages: MessageLike[] = response?.data ?? []
                const assistants = messages.filter((m) => m.role === "assistant" && !m.summary)
                for (let i = assistants.length - 1; i >= 0; i--) {
                    const created = assistants[i].time?.created ?? 0
                    if (created >= sentAt) {
                        const text = textOf(assistants[i])
                        if (text) {
                            lastText = text
                            break
                        }
                    }
                }
                if (lastText) return lastText
            }
            this.logger.warn("mutate timed out")
            return null
        } catch (error) {
            this.logger.error("mutate prompt failed", { error: String(error) })
            return null
        } finally {
            void this.deleteTempSession(sessionId)
        }
    }

    async mutate(params: RecallParams, notes: string): Promise<RecallParams[]> {
        if (!this.configured) return []
        const prompt = buildMutationPrompt(params, notes)
        const raw = await this.runHidden(prompt)
        const match = raw?.match(/\[[\s\S]*\]/)
        if (!match) return []
        try {
            const parsed = JSON.parse(match[0]) as unknown
            if (!Array.isArray(parsed)) return []
            const candidates: RecallParams[] = []
            for (const item of parsed.slice(0, 2)) {
                if (!item || typeof item !== "object") continue
                const cand = clampParams({ ...params, ...(item as Partial<RecallParams>) })
                if (cand.maxRecall !== params.maxRecall) continue
                candidates.push(cand)
            }
            return candidates
        } catch {
            return []
        }
    }
}