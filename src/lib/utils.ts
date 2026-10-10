import { createHash } from "node:crypto"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { PARAM_CLAMPS, type RecallParams } from "./types.js"

export function sha1Id(value: string): string {
    return createHash("sha1").update(value).digest("hex").slice(0, 12)
}

export function projectIdOf(directory: string): string {
    return sha1Id(directory.toLowerCase())
}

/**
 * True when the path is a filesystem root (e.g. "/", "C:\\", "\\\\server\\share")
 * or otherwise too short to be a usable project working directory.
 */
export function isRootPath(path: string): boolean {
    const trimmed = path.trim()
    if (!trimmed) return true
    if (trimmed === "/" || trimmed === "\\") return true
    if (isAbsolute(trimmed)) {
        // absolute path whose depth is exactly one: the root itself
        const parts = trimmed.split(/[\\/]+/).filter(Boolean)
        return parts.length <= 1
    }
    return false
}

export function nowIso(): string {
    return new Date().toISOString()
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

export function clampParams(params: RecallParams): RecallParams {
    const out = { ...params }
    for (const key of Object.keys(PARAM_CLAMPS) as (keyof RecallParams)[]) {
        const [min, max] = PARAM_CLAMPS[key]
        out[key] = clamp(out[key], min, max)
    }
    out.maxRecall = Math.round(out.maxRecall)
    return out
}

export function toPosix(input: string): string {
    return input.replace(/\\/g, "/")
}

/**
 * Normalize a user/model-supplied file path into a project-relative posix path.
 * Returns null for the project root itself or paths outside the project.
 */
export function normalizeProjectPath(root: string, input: string): string | null {
    if (!input) return null
    // ".." is never normalized away so that an escaped path cannot silently
    // become an inside path: compare resolved physical paths instead of string
    // prefixes. Additionally reject absolute results (relative() across drive
    // letters on win32 returns an absolute path, not a ".."-prefixed one).
    const rootAbs = resolve(root)
    const abs = resolve(root, input)
    const rel = relative(rootAbs, abs)
    if (rel === "" || rel === ".") return null
    if (isAbsolute(rel)) return null
    if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../")) return null
    return toPosix(rel)
}

export function fileStem(file: string): string {
    return basename(file).replace(/\.[^.]*$/, "")
}

export function dedupe(list: string[]): string[] {
    return [...new Set(list)]
}

/** Normalize user/model-supplied file paths into project-relative posix paths (drops root/outside). */
export function normalizeFiles(root: string, files: string[]): string[] {
    const out: string[] = []
    for (const file of files) {
        const norm = normalizeProjectPath(root, file)
        if (norm) out.push(norm)
    }
    return dedupe(out)
}

export function truncate(value: string, max: number): string {
    if (value.length <= max) return value
    return value.slice(0, Math.max(0, max - 1)) + "…"
}

/** Keep the tail (most recent) of a string within a char budget. */
export function tail(value: string, max: number): string {
    if (value.length <= max) return value
    return "…" + value.slice(value.length - Math.max(0, max - 1))
}

/** Minimal JSONC strip: remove line/block comments (string aware) and trailing commas. */
export function stripJsonc(source: string): string {
    let out = ""
    let inString = false
    let inLine = false
    let inBlock = false
    for (let i = 0; i < source.length; i++) {
        const ch = source[i]
        const next = source[i + 1] ?? ""
        if (inLine) {
            if (ch === "\n") {
                inLine = false
                out += ch
            }
            continue
        }
        if (inBlock) {
            if (ch === "*" && next === "/") {
                inBlock = false
                i++
            }
            continue
        }
        if (inString) {
            out += ch
            if (ch === '"') {
                // a quote ends the string unless it is escaped: odd run of "\"
                let backslashes = 0
                for (let j = i - 1; j >= 0 && source[j] === "\\"; j--) backslashes++
                if (backslashes % 2 === 0) inString = false
            }
            continue
        }
        if (ch === '"') {
            inString = true
            out += ch
            continue
        }
        if (ch === "/" && next === "/") {
            inLine = true
            i++
            continue
        }
        if (ch === "/" && next === "*") {
            inBlock = true
            i++
            continue
        }
        out += ch
    }
    return out.replace(/,(\s*[}\]])/g, "$1")
}

/** FNV-1a 32-bit hash（无符号），用于把 projectId/createdAt/runId 映射成 RNG 种子。 */
export function fnv1a32(input: string): number {
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
}

/** mulberry32：~5 行的可复现 PRNG（输出 0..1）。 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** 整数语义的参数（播种/微扰后取整，保持记录整洁）。 */
const INTEGER_PARAMS = new Set<keyof RecallParams>(["recencyHalfLife", "maxRecall"])

/**
 * 对参数组做 seeded 的 ±frac 相对扰动（每参数乘 `1 + (rng()*2-1)*frac`），
 * 随后 clampParams 收边界、整数参数 round。播种（P1 建库）与启发式变体的
 * 每次运行微扰共用此函数。
 */
export function perturbParams(base: RecallParams, rng: () => number, frac = 0.2): RecallParams {
    const out = { ...base }
    for (const key of Object.keys(PARAM_CLAMPS) as (keyof RecallParams)[]) {
        out[key] = base[key] * (1 + (rng() * 2 - 1) * frac)
    }
    const clamped = clampParams(out)
    for (const key of INTEGER_PARAMS) clamped[key] = Math.round(clamped[key])
    return clamped
}