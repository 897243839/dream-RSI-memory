/**
 * Read-only install diagnostics for the opencode plugin install (CLI §9).
 *
 * 安装/卸载本身不在此文件：CLI 委托 `scripts/install.mjs`（spawnSync 继承 stdio），
 * 保证「CLI 与脚本共用同一实现」。本文件只做 status / doctor / memory 的只读检查，
 * 且不写任何用户文件。
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveConfig } from "./config.js"
import { stripJsonc } from "./utils.js"

export const PLUGIN_ID = "dream-rsi-memory"

/** 包根：本文件编译到 dist/lib/，上两级即包根（dev checkout 或 scope 内的快照都成立）。 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

export function readPackageVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: unknown }
        return typeof pkg.version === "string" ? pkg.version : "unknown"
    } catch {
        return "unknown"
    }
}

/** 数据目录（复用插件的配置解析：OPENCODE_CONFIG_DIR / 项目级 / ~/.config）。 */
export function memoryDataDir(): string {
    return resolveConfig().dataDir
}

/** 与 scripts/install.mjs 一致：~/.cache/opencode/packages。 */
export function opencodeCachePackagesDir(): string {
    return join(homedir(), ".cache", "opencode", "packages")
}

export function scopeDir(): string {
    return join(opencodeCachePackagesDir(), `${PLUGIN_ID}@latest`)
}

function readJson(file: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(stripJsonc(readFileSync(file, "utf8")))
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    } catch {
        return null
    }
}

/* ------------------------------------------------------------------ scope */

export type ScopeLayout = "root" | "nested" | "missing" | "unknown"

export interface ScopeInfo {
    dir: string
    exists: boolean
    /** root = scope 根即插件目录（B1 新布局）；nested = 插件埋在 node_modules/<id>/（旧布局）。 */
    layout: ScopeLayout
    pluginDir: string | null
    diskVersion: string | null
}

function versionOf(pkg: Record<string, unknown> | null): string | null {
    return pkg && typeof pkg.version === "string" ? pkg.version : null
}

export function inspectScope(dir: string = scopeDir()): ScopeInfo {
    if (!existsSync(dir)) {
        return { dir, exists: false, layout: "missing", pluginDir: null, diskVersion: null }
    }
    const rootPkg = readJson(join(dir, "package.json"))
    // 新布局（B1）：scope 根就是插件目录 —— 有 name 匹配的 manifest 且有 dist/。
    // 旧布局的 placeholder manifest 叫 dream-rsi-memory-offline-installed，根上没有 dist/，
    // 因此不会被误判为 root 布局。
    if (
        rootPkg &&
        typeof rootPkg.name === "string" &&
        rootPkg.name.startsWith(PLUGIN_ID) &&
        existsSync(join(dir, "dist"))
    ) {
        return { dir, exists: true, layout: "root", pluginDir: dir, diskVersion: versionOf(rootPkg) }
    }
    // 旧布局（嵌套）：node_modules/<id>/package.json。
    const nestedDir = join(dir, "node_modules", PLUGIN_ID)
    if (existsSync(join(nestedDir, "package.json"))) {
        return {
            dir,
            exists: true,
            layout: "nested",
            pluginDir: nestedDir,
            diskVersion: versionOf(readJson(join(nestedDir, "package.json"))),
        }
    }
    return { dir, exists: true, layout: "unknown", pluginDir: null, diskVersion: versionOf(rootPkg) }
}

/* ----------------------------------------------------------------- config */

/** 与 scripts/install.mjs 的 configPath 相同的解析规则；exists=false 表示文件尚未创建。 */
export function resolveOpencodeConfigPath(): { file: string; exists: boolean } {
    const base = process.env.XDG_CONFIG_HOME
        ? resolve(process.env.XDG_CONFIG_HOME, "opencode")
        : join(homedir(), ".config", "opencode")
    const json = join(base, "opencode.json")
    const jsonc = join(base, "opencode.jsonc")
    if (existsSync(json)) return { file: json, exists: true }
    if (existsSync(jsonc)) return { file: jsonc, exists: true }
    return { file: json, exists: false }
}

export interface ConfigInfo {
    file: string
    exists: boolean
    /** opencode 配置里指向本插件的所有条目（裸包名 / file 路径 / 目录路径都算）。 */
    entries: string[]
}

export function readPluginConfigEntries(file: string): string[] {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown> | null
    if (parsed && typeof parsed === "object") {
        const list = parsed["plugins"] ?? parsed["plugin"]
        if (Array.isArray(list)) {
            return list.filter((x): x is string => typeof x === "string" && x.includes(PLUGIN_ID))
        }
    }
    // 解析失败（畸形 jsonc）时退回裸正则，与 install.mjs 的容错口径一致。
    const out = new Set<string>()
    for (const m of raw.matchAll(/"[^"]*dream-rsi-memory[^"]*"/g)) out.add(m[0].slice(1, -1))
    return [...out]
}

/* ---------------------------------------------------------------- status */

export interface InstallStatus {
    installed: boolean
    cliVersion: string
    diskVersion: string | null
    scope: ScopeInfo
    config: ConfigInfo
}

export function statusOpenCode(): InstallStatus {
    const scope = inspectScope()
    const cfg = resolveOpencodeConfigPath()
    const config: ConfigInfo = { file: cfg.file, exists: cfg.exists, entries: readPluginConfigEntries(cfg.file) }
    return {
        installed: scope.exists && scope.layout !== "missing" && scope.layout !== "unknown" && config.entries.length > 0,
        cliVersion: readPackageVersion(),
        diskVersion: scope.diskVersion,
        scope,
        config,
    }
}

/* ---------------------------------------------------------------- doctor */

export interface DoctorReport {
    cliVersion: string
    dist: { ok: boolean; indexJs: string; cliJs: string }
    scope: ScopeInfo
    config: ConfigInfo
    dataDir: { dir: string; exists: boolean; projects: number; nodes: number }
    /** 进程数；平台查不到时为 "unknown"（doctor 是诊断不是断言，不算问题）。 */
    opencodeProcesses: number | "unknown"
    problems: string[]
}

/** best-effort opencode 进程计数；任何平台差异都返回 "unknown" 而不是抛错。 */
export function countOpencodeProcesses(): number | "unknown" {
    try {
        if (process.platform === "win32") {
            const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq opencode.exe", "/FO", "CSV", "/NH"], {
                encoding: "utf8",
                timeout: 10_000,
            })
            if (r.status !== 0) return "unknown"
            const lines = (r.stdout ?? "")
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.toLowerCase().includes("opencode.exe"))
            return lines.length
        }
        const r = spawnSync("pgrep", ["-f", "opencode"], { encoding: "utf8", timeout: 10_000 })
        if (r.status === null) return "unknown"
        if (r.status === 1) return 0 // pgrep: no match
        if (r.status !== 0) return "unknown"
        return (r.stdout ?? "").split(/\r?\n/).filter(Boolean).length
    } catch {
        return "unknown"
    }
}

export function doctorOpenCode(): DoctorReport {
    const problems: string[] = []
    const cliVersion = readPackageVersion()

    const indexJs = join(PACKAGE_ROOT, "dist", "index.js")
    const cliJs = join(PACKAGE_ROOT, "dist", "cli.js")
    const dist = { ok: existsSync(indexJs) && existsSync(cliJs), indexJs, cliJs }
    if (!dist.ok) problems.push("missing build artifacts — run `npm run build`")

    const scope = inspectScope()
    if (scope.layout === "missing") {
        problems.push(`scope dir missing — run \`dreamrsimem plugin install opencode\` (${scope.dir})`)
    } else if (scope.layout === "unknown") {
        problems.push(`scope dir present but layout not recognised (${scope.dir})`)
    }
    if (scope.diskVersion && scope.diskVersion !== cliVersion) {
        problems.push(`disk version ${scope.diskVersion} != CLI version ${cliVersion} — re-run install`)
    }

    const cfg = resolveOpencodeConfigPath()
    const config: ConfigInfo = { file: cfg.file, exists: cfg.exists, entries: readPluginConfigEntries(cfg.file) }
    if (config.entries.length === 0) {
        problems.push(`no ${PLUGIN_ID} entry in ${config.file} — run \`dreamrsimem plugin install opencode\``)
    } else {
        for (const entry of config.entries) {
            // 绝对路径条目指向不存在的目录 = 插件静默死亡（正是 doctor 要抓的头号问题）。
            if (/^(file:\/\/\/|[A-Za-z]:[\\/]|\/)/.test(entry)) {
                const target = entry.replace(/^file:\/\/\//, "/").replace(/\//g, process.platform === "win32" ? "\\" : "/")
                const normalized = process.platform === "win32" && target.startsWith("\\") ? target.slice(1) : target
                if (!existsSync(normalized)) problems.push(`plugin entry points to missing dir: ${entry}`)
            }
        }
    }

    const dataDir = memoryDataDir()
    const projects = listMemoryProjects(dataDir)
    const data = {
        dir: dataDir,
        exists: existsSync(dataDir),
        projects: projects.length,
        nodes: projects.reduce((sum, p) => sum + p.nodes, 0),
    }
    if (!data.exists) problems.push(`data dir missing (no memory yet): ${dataDir}`)

    return {
        cliVersion,
        dist,
        scope,
        config,
        dataDir: data,
        opencodeProcesses: countOpencodeProcesses(),
        problems,
    }
}

/* ---------------------------------------------------------------- memory */

export interface MemoryProjectSummary {
    projectId: string
    rootPath: string | null
    nodes: number
    sessions: number
    lastUpdated: string | null
}

function str(value: unknown): string {
    return typeof value === "string" ? value : value == null ? "" : String(value)
}

/** 扫 <dataDir>/<projectId>/：index.json 给 rootPath，sessions/*.json 给节点数与最近更新。 */
export function listMemoryProjects(dataDir: string): MemoryProjectSummary[] {
    if (!existsSync(dataDir)) return []
    const out: MemoryProjectSummary[] = []
    for (const dirent of readdirSync(dataDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue
        const dir = join(dataDir, dirent.name)
        const index = readJson(join(dir, "index.json"))
        let nodes = 0
        let sessions = 0
        let lastUpdated: string | null = null
        const sessionsDir = join(dir, "sessions")
        if (existsSync(sessionsDir)) {
            for (const file of readdirSync(sessionsDir)) {
                if (!file.endsWith(".json")) continue
                sessions++
                const part = readJson(join(sessionsDir, file))
                const list = part && Array.isArray(part.nodes) ? (part.nodes as Record<string, unknown>[]) : []
                nodes += list.length
                for (const node of list) {
                    const createdAt = node?.["createdAt"]
                    if (typeof createdAt === "string" && (lastUpdated === null || createdAt > lastUpdated)) {
                        lastUpdated = createdAt
                    }
                }
            }
        }
        out.push({
            projectId: dirent.name,
            rootPath: index && typeof index["rootPath"] === "string" ? (index["rootPath"] as string) : null,
            nodes,
            sessions,
            lastUpdated,
        })
    }
    out.sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""))
    return out
}

/** 把一个项目的全部节点按时间排序导出为 Markdown；项目不存在返回 null。 */
export function exportProjectMarkdown(dataDir: string, projectId: string): string | null {
    const dir = join(dataDir, projectId)
    if (!existsSync(join(dir, "index.json")) && !existsSync(join(dir, "sessions"))) return null
    const index = readJson(join(dir, "index.json"))
    const nodes: Record<string, unknown>[] = []
    const sessionsDir = join(dir, "sessions")
    if (existsSync(sessionsDir)) {
        for (const file of readdirSync(sessionsDir)) {
            if (!file.endsWith(".json")) continue
            const part = readJson(join(sessionsDir, file))
            if (part && Array.isArray(part.nodes)) {
                nodes.push(...(part.nodes as Record<string, unknown>[]))
            }
        }
    }
    nodes.sort((a, b) => str(a["createdAt"]).localeCompare(str(b["createdAt"])))
    const rootPath = index && typeof index["rootPath"] === "string" ? (index["rootPath"] as string) : "(unknown)"
    const lines: string[] = [
        `# dream-rsi-memory — ${projectId}`,
        "",
        `- project: ${rootPath}`,
        `- nodes: ${nodes.length}`,
        `- generated: ${new Date().toISOString()}`,
        "",
    ]
    for (const node of nodes) {
        lines.push(`## ${str(node["outcome"])} · ${str(node["agentName"])} · ${str(node["createdAt"])}`, "")
        lines.push(str(node["summary"]))
        const files = Array.isArray(node["files"]) ? node["files"].filter((f): f is string => typeof f === "string") : []
        if (files.length) lines.push("", `- files: ${files.join(", ")}`)
        if (typeof node["why"] === "string" && node["why"]) lines.push(`- why: ${node["why"]}`)
        if (typeof node["errorMessage"] === "string" && node["errorMessage"]) lines.push(`- error: ${node["errorMessage"]}`)
        if (typeof node["score"] === "number") lines.push(`- score: ${node["score"]}`)
        lines.push("")
    }
    return lines.join("\n")
}
