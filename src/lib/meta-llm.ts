import type { Logger } from "./logger.js"
import type { MemoryConfig, DistillResult, RecallParams } from "./types.js"
import { buildDistillPrompt, buildMutationPrompt, parseDistillJson } from "./prompts.js"
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

/** Background "馆藏官" small-model helper: distill + occasional strategy mutation. */
export class MetaLlm {
    private sessionId: string | null = null

    constructor(
        private readonly client: unknown,
        private readonly config: MemoryConfig,
        private readonly logger: Logger,
        private readonly directory: string,
    ) {}

    get configured(): boolean {
        const d = this.config.distill
        return d.enabled && !!d.providerID && !!d.modelID
    }

    private modelField(): { providerID: string; modelID: string } | undefined {
        const d = this.config.distill
        if (!d.providerID || !d.modelID) return undefined
        return { providerID: d.providerID, modelID: d.modelID }
    }

    private async ensureSession(): Promise<string | null> {
        if (this.sessionId) return this.sessionId
        try {
            const clientAny = this.client as {
                session: {
                    create(options: { body?: { title?: string }; query?: { directory?: string } }): Promise<{ data?: { id: string } }>
                }
            }
            const created = await clientAny.session.create({
                body: { title: "dream-memory-distill" },
                query: { directory: this.directory },
            })
            const id = created?.data?.id
            if (!id) return null
            this.sessionId = id
            return id
        } catch (error) {
            this.logger.error("distill session create failed", { error: String(error) })
            return null
        }
    }

    private async runHidden(promptText: string): Promise<string | null> {
        const sessionId = await this.ensureSession()
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

            const deadline = Date.now() + this.config.distill.timeoutMs
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
            this.logger.warn("distill timed out")
            return null
        } catch (error) {
            this.logger.error("distill prompt failed", { error: String(error) })
            return null
        }
    }

    async distill(material: Parameters<typeof buildDistillPrompt>[0], args: Parameters<typeof buildDistillPrompt>[1]): Promise<DistillResult | null> {
        if (!this.configured) return null
        const prompt = buildDistillPrompt(material, args)
        const raw = await this.runHidden(prompt)
        const result = parseDistillJson(raw ?? "")
        if (result && (result.summary || result.why || result.outcome)) {
            this.logger.debug("distill ok", { summary: result.summary?.slice(0, 60) })
            return result
        }
        return null
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