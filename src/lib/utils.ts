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