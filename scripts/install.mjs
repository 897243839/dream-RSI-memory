#!/usr/bin/env node
/**
 * One-shot install of dream-rsi-memory into opencode.
 *
 * opencode loads plugins from ~/.cache/opencode/packages/<name>@latest/ and
 * resolves `plugin: ["dream-rsi-memory"]` by installing that package's
 * dependencies (a `file:` dep back to this repo) into its node_modules.
 *
 * This script reproduces that layout directly (no npm registry needed):
 *   1. builds dist/
 *   2. provisions ~/.cache/opencode/packages/dream-rsi-memory@latest/
 *      - package.json with a file: dependency back to this repo
 *      - node_modules/@opencode-ai/plugin (copied from local devDeps if missing)
 *      - node_modules/dream-rsi-memory  -> junction/symlink to this repo
 *   3. adds `dream-rsi-memory` to the opencode config plugin array (unless present)
 *
 * Idempotent: safe to re-run after every code change; only a restart of
 * opencode (or a fresh session) picks up a rebuilt dist.
 *
 * Usage:  node scripts/install.mjs [--config PATH]
 */
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..")
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"))

const CACHE = join(homedir(), ".cache", "opencode", "packages")
const SCOPE_DIR = join(CACHE, "dream-rsi-memory@latest")
const NM_DM = join(SCOPE_DIR, "node_modules", "dream-rsi-memory")
const NM_PLUGIN = join(SCOPE_DIR, "node_modules", "@opencode-ai", "plugin")

const isWin = process.platform === "win32"

function log(msg) {
    console.log(`[install] ${msg}`)
}

function fail(msg) {
    console.error(`[install] ERROR ${msg}`)
    process.exit(1)
}

/* ------------------------------------------------------------------ 1. build */
function run(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: REPO, stdio: "inherit" })
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exit ${r.status}`)
}

function build() {
    log(`building dist …`)
    rmSync(join(REPO, "dist"), { recursive: true, force: true })
    try {
        // run the local tsc directly, no shell, no npm layer
        run(process.execPath, [require.resolve("typescript/bin/tsc", { paths: [REPO] })])
    } catch {
        run(isWin ? "npm.cmd" : "npm", ["run", "build"])
    }
    const entry = join(REPO, "dist", "index.js")
    if (!existsSync(entry)) fail(`build finished but missing ${entry}`)
    const built = readFileSync(entry, "utf8")
    if (!built.includes("dream-memory")) fail("dist/index.js does not look like the plugin (no magic string)")
    log(`dist ok (${pkg.version})`)
}

/* --------------------------------------------------------- 2. provision scope */
/** Resolve the real on-disk path (follows junctions/symlinks). Null when missing. */
function realPath(p) {
    try {
        return resolve(realpathSync(p))
    } catch {
        return null
    }
}

/** Re-create a directory that is a junction/symlink to `target`. Plain dirs & stale links are replaced. */
function ensureLink(dir, target) {
    const desired = resolve(target)
    const existing = realPath(dir)
    if (existing === desired) {
        log(`link ok: ${dir} → ${desired}`)
        return
    }
    if (existing === null) {
        log(`creating ${dir} → ${desired}`)
    } else {
        log(`rebuilding ${dir} (currently → ${existing}, want ${desired})`)
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    if (isWin) {
        // junction needs an absolute path and works without admin rights
        const r = spawnSync("cmd", ["/c", "mklink", "/J", dir, desired], { stdio: "pipe" })
        if (r.status !== 0) fail(`mklink /J ${dir} ${desired} failed: ${r.stderr?.toString()}`)
        log(`linked: ${dir} → ${desired}`)
    } else {
        const r = spawnSync("ln", ["-s", desired, dir], { stdio: "pipe" })
        if (r.status !== 0) fail(`ln -s ${desired} ${dir} failed: ${r.stderr?.toString()}`)
        log(`linked: ${dir} → ${desired}`)
    }
}

function provisionScope() {
    mkdirSync(SCOPE_DIR, { recursive: true })

    const absRepo = REPO.split(sep).join("/")
    const manifest = {
        dependencies: {
            "@opencode-ai/plugin": pkg.peerDependencies?.["@opencode-ai/plugin"] ?? ">=1.4.3",
            "dream-rsi-memory": `file:${absRepo}`,
        },
    }
    const manifestFile = join(SCOPE_DIR, "package.json")
    let manifestOk = false
    if (existsSync(manifestFile)) {
        try {
            const cur = JSON.parse(readFileSync(manifestFile, "utf8"))
            manifestOk = cur.dependencies?.["dream-rsi-memory"] === `file:${absRepo}`
        } catch {
            manifestOk = false
        }
    }
    if (!manifestOk) {
        writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8")
        log(`wrote ${manifestFile}`)
    }

    // main plugin body: must be the repo itself so dist stays in sync with rebuilds
    ensureLink(NM_DM, REPO)

    // runtime dep of the plugin itself
    ensureLink(NM_PLUGIN, join(REPO, "node_modules", "@opencode-ai", "plugin"))
}

/* ------------------------------------------------------- 3. opencode config */
function configPath(custom) {
    if (custom) return resolve(custom)
    const base = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME, "opencode") : join(homedir(), isWin ? ".config" : ".config", "opencode")
    const json = join(base, "opencode.json")
    const jsonc = join(base, "opencode.jsonc")
    if (existsSync(json)) return json
    if (existsSync(jsonc)) return jsonc
    return json
}

/** Append `dream-rsi-memory` into the plugin array of a json/jsonc config. */
function ensureConfigPlugin(file) {
    const appName = "dream-rsi-memory"
    const raw = readFileSync(file, "utf8")
    if (/"dream-rsi-memory"/.test(raw)) {
        log(`plugin already listed in ${file}`)
        return
    }
    const m = raw.match(/(\s*"plugin"\s*:\s*)\[([\s\S]*?)\]/)
    if (m) {
        const prefix = m[1]
        const inner = m[2].trim()
        const newInner = inner.length === 0 ? `"${appName}"` : `${inner.replace(/,\s*$/, "")}, "${appName}"`
        const next = raw.slice(0, m.index) + `${prefix}[${newInner}]` + raw.slice(m.index + m[0].length)
        writeFileSync(file, next, "utf8")
        log(`added "${appName}" to plugin list in ${file}`)
        return
    }
    // No plugin array: insert a top-level `plugin` key after the opening brace.
    // Safe for JSON and JSONC (comments, trailing commas) — only touches the
    // first top-level object's opening brace.
    let depth = 0
    let inString = false
    let esc = false
    let braceAt = -1
    for (let i = 0; i < raw.length && braceAt < 0; i++) {
        const c = raw[i]
        if (esc) { esc = false; continue }
        if (inString) {
            if (c === "\\") esc = true
            else if (c === '"') inString = false
            continue
        }
        if (c === '"') { inString = true; continue }
        if (c === "{" && depth === 0) braceAt = i
        else if (c === "{") depth++
        else if (c === "}") depth--
    }
    if (braceAt < 0) fail(`cannot insert plugin key into ${file}: no top-level object found`)
    const indent = "  "
    const insertion = `\n${indent}"plugin": ["${appName}"],`
    const next = raw.slice(0, braceAt + 1) + insertion + raw.slice(braceAt + 1)
    writeFileSync(file, next, "utf8")
    log(`added "${appName}" to plugin list in ${file}`)
}

/* ------------------------------------------------------------------- main */
const customCfg = process.argv.includes("--config") ? process.argv[process.argv.indexOf("--config") + 1] : undefined

build()
provisionScope()
const cfg = configPath(customCfg)
if (existsSync(cfg)) ensureConfigPlugin(cfg)
else fail(`no opencode config found at ${cfg}; create one with  "plugin": ["dream-rsi-memory"]  then re-run`)

log(`
install done (dream-rsi-memory v${pkg.version})
  linked scope : ${SCOPE_DIR}
  plugin body  : ${NM_DM} → ${REPO}
  config       : ${cfg}
Restart opencode (or open a fresh session) to load the updated plugin.
Uninstall: remove the "dream-rsi-memory" entry from ${cfg}'s plugin array and delete ${SCOPE_DIR}.
`)