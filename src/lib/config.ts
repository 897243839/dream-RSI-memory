import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { MemoryConfig } from "./types.js"
import { stripJsonc } from "./utils.js"

function defaultDataDir(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "dream-memory",
    )
}

const DEFAULTS: MemoryConfig = {
    enabled: true,
    dataDir: defaultDataDir(),
    debug: true,
    distill: {
        enabled: true,
        maxMaterialChars: 6000,
        timeoutMs: 120_000,
    },
    menu: {
        enabled: true,
        cooldownTurns: 2,
        forceEveryTurns: 5,
        maxTokensHint: 200,
    },
    dream: {
        enabled: true,
        minNodes: 20,
        trainRatio: 0.8,
        epsilon: 0.005,
        candidateCount: 3,
    },
    replayWeights: {
        fileHitRate: 0.35,
        failureAvoidRate: 0.25,
        precision: 0.25,
        recallBudget: 0.15,
    },
    autoCommitOnIdle: true,
    autoCommitIdleGapMs: 5 * 60_000,
}

const MERGE_KEYS = ["distill", "menu", "dream", "replayWeights"] as const

function deepMerge(user: Record<string, unknown>): Partial<MemoryConfig> {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(user)) {
        const value = user[key]
        if (
            (MERGE_KEYS as readonly string[]).includes(key) &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
        ) {
            out[key] = { ...(DEFAULTS[key as keyof MemoryConfig] as object), ...(value as object) }
        } else {
            out[key] = value
        }
    }
    return out as Partial<MemoryConfig>
}

function readJsonCandidates(candidates: string[]): Record<string, unknown> | null {
    for (const file of candidates) {
        if (!existsSync(file)) continue
        try {
            const parsed = JSON.parse(stripJsonc(readFileSync(file, "utf8")))
            if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
        } catch {
            // malformed candidate — keep scanning
        }
    }
    return null
}

/** Resolution order: $OPENCODE_CONFIG_DIR → project root/.opencode → project root → ~/.config/opencode */
export function resolveConfig(ctx?: PluginInput): MemoryConfig {
    const candidates: string[] = []
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (configDir) {
        candidates.push(join(configDir, "dream-memory.jsonc"), join(configDir, "dream-memory.json"))
    }
    if (ctx?.directory) {
        candidates.push(
            join(ctx.directory, ".opencode", "dream-memory.jsonc"),
            join(ctx.directory, ".opencode", "dream-memory.json"),
            join(ctx.directory, "dream-memory.jsonc"),
            join(ctx.directory, "dream-memory.json"),
        )
    }
    candidates.push(
        join(homedir(), ".config", "opencode", "dream-memory.jsonc"),
        join(homedir(), ".config", "opencode", "dream-memory.json"),
    )

    const user = readJsonCandidates(candidates)
    return { ...DEFAULTS, ...(user ? deepMerge(user) : {}) }
}