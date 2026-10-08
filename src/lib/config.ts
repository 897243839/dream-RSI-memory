import { existsSync, readFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { MemoryConfig } from "./types.js"
import { stripJsonc } from "./utils.js"

/** v2.0.1 起插件 id / 数据目录 / 配置文件统一为 `dream-rsi-memory`（v2.0.0 及更早叫 `dream-memory`）。 */
const PLUGIN_DIR_NAME = "dream-rsi-memory"
/** legacy（v2.0.1 改名前）旧名，勿删：升级用户的旧数据目录与旧配置文件仍用这个名字。 */
const LEGACY_PLUGIN_DIR_NAME = "dream-memory"

function pluginStorageRoot(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
    )
}

function defaultDataDir(): string {
    return join(pluginStorageRoot(), PLUGIN_DIR_NAME)
}

/** legacy 数据目录（v2.0.1 改名前），仅用于启动迁移，勿删。 */
function legacyDataDir(): string {
    return join(pluginStorageRoot(), LEGACY_PLUGIN_DIR_NAME)
}

/**
 * v2.0.1 数据目录迁移：`…/storage/plugin/dream-memory` → `…/dream-rsi-memory`。
 * 只在解析到**默认**数据目录时执行（用户显式配置过 `dataDir` 的一律不碰）：
 * - 新目录不存在、旧目录存在 → 整体 `renameSync`（失败原样抛出，不静默吞）；
 * - 新旧都存在 → 用新目录，旧目录**原样保留**（绝不合并/覆盖），仅提示残留路径。
 * 只在启动（resolveConfig）时执行一次；不要在旧版插件仍在运行时手工搬目录。
 */
function migrateLegacyDataDir(newDir: string): void {
    if (newDir !== defaultDataDir()) return
    const oldDir = legacyDataDir()
    if (!existsSync(oldDir)) return
    if (existsSync(newDir)) {
        console.log(`[dream-rsi-memory] 旧数据目录残留（未合并，继续使用新目录）：${oldDir}`)
        return
    }
    renameSync(oldDir, newDir)
    console.log(`[dream-rsi-memory] 已把旧数据目录迁移到新位置：${newDir}`)
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

/** 单个位置内的配置文件名：新名在前；旧名兜底（legacy，勿删——升级用户配置文件不丢）。 */
function configNamesIn(dir: string): string[] {
    return [
        join(dir, "dream-rsi-memory.jsonc"),
        join(dir, "dream-rsi-memory.json"),
        join(dir, "dream-memory.jsonc"), // legacy 旧名（v2.0.1 改名前），勿删
        join(dir, "dream-memory.json"), // legacy 旧名（v2.0.1 改名前），勿删
    ]
}

/** Resolution order: $OPENCODE_CONFIG_DIR → project root/.opencode → project root → ~/.config/opencode
 *
 * V2: `ctx` 只需要项目目录（V1 的 `PluginInput.directory` → V2 的 `ctx.location.directory`）。
 */
export function resolveConfig(ctx?: { directory?: string }): MemoryConfig {
    const candidates: string[] = []
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (configDir) candidates.push(...configNamesIn(configDir))
    if (ctx?.directory) {
        candidates.push(...configNamesIn(join(ctx.directory, ".opencode")))
        candidates.push(...configNamesIn(ctx.directory))
    }
    candidates.push(...configNamesIn(join(homedir(), ".config", "opencode")))

    const user = readJsonCandidates(candidates)
    const merged: Partial<MemoryConfig> = user ? deepMerge(user) : {}
    if (merged.dataDir === undefined) migrateLegacyDataDir(defaultDataDir())
    const dataDir = typeof merged.dataDir === "string" && merged.dataDir ? merged.dataDir : defaultDataDir()
    return { ...DEFAULTS, ...merged, dataDir }
}
