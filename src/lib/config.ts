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
    debug: false,
    capture: {
        maxMaterialChars: 6000,
    },
    curator: {
        enabled: false,
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

const MERGE_KEYS = ["capture", "curator", "menu", "dream", "replayWeights"] as const

function migrateLegacy(user: Record<string, unknown>): Record<string, unknown> {
    // v0.4.2 及更早：distill 段同时承载素材预算与馆藏管理员配置。
    // v0.4.3 拆为 capture（素材预算）与 curator（馆藏管理员）。旧键自动迁移。
    const legacy = user["distill"]
    if (!legacy || typeof legacy !== "object") return user

    const out = { ...user }
    const l = legacy as Record<string, unknown>
    if (!out.capture || typeof out.capture !== "object") {
        out.capture = { maxMaterialChars: l.maxMaterialChars ?? DEFAULTS.capture.maxMaterialChars }
    } else if ((out.capture as Record<string, unknown>).maxMaterialChars === undefined && l.maxMaterialChars !== undefined) {
        ;(out.capture as Record<string, unknown>).maxMaterialChars = l.maxMaterialChars
    }
    if (!out.curator || typeof out.curator !== "object") {
        out.curator = {
            enabled: l.enabled ?? DEFAULTS.curator.enabled,
            providerID: l.providerID,
            modelID: l.modelID,
            timeoutMs: l.timeoutMs ?? DEFAULTS.curator.timeoutMs,
        }
    } else if ((out.curator as Record<string, unknown>).timeoutMs === undefined && l.timeoutMs !== undefined) {
        ;(out.curator as Record<string, unknown>).timeoutMs = l.timeoutMs
    }
    delete out.distill
    return out
}

function deepMerge(user: Record<string, unknown>): Partial<MemoryConfig> {
    const migrated: Record<string, unknown> = migrateLegacy(user)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(migrated)) {
        const value = migrated[key]
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