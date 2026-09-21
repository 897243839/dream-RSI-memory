#!/usr/bin/env node
/**
 * Install / uninstall dream-rsi-memory for opencode.
 *
 * opencode loads plugins from ~/.cache/opencode/packages/<name>@latest/ and
 * resolves `plugin: ["dream-rsi-memory"]` by installing that package's
 * dependencies (a `file:` dep back to this repo) into its node_modules.
 *
 * Two installation paths:
 *
 *  dev  (default) — requires a working npm install first:
 *      + npm install && npm run install:opencode
 *      1. builds dist/  (needs local typescript)
 *      2. provisions ~/.cache/opencode/packages/dream-rsi-memory@latest/
 *         - package.json with a file: dependency back to this repo
 *         - node_modules/@opencode-ai/plugin  (junction to local devDeps)
 *         - node_modules/dream-rsi-memory      -> junction/symlink to this repo
 *      3. adds `dream-rsi-memory` to the opencode config plugin array
 *
 *  offline (intranet / no npm next) — no network, npm, or Node build needed:
 *      + On the networked machine:  npm run vendor
 *         -> produces ./vendor/{dist/,node_modules/} (self-contained assets)
 *      + Copy the repo (including vendor/) to the intranet machine, then:
 *           node scripts/install.mjs --offline
 *      1. copies vendor/dist -> dist           (no tsc needed)
 *      2. copies vendor/node_modules -> the scope dir (no npm needed)
 *      3. adds `dream-rsi-memory` to the opencode config plugin array
 *
 * Idempotent: safe to re-run after every code change; only a restart of
 * opencode (or a fresh session) picks up a rebuilt dist.
 *
 * Usage:
 *   node scripts/install.mjs [--offline] [--config PATH]
 *   node scripts/install.mjs --vendor          # build offline assets into vendor/
 *   node scripts/install.mjs --uninstall       # remove plugin entry + scope dir
 */
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, cpSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
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

const VENDOR = join(REPO, "vendor")
const VENDOR_DIST = join(VENDOR, "dist")
const VENDOR_NM = join(VENDOR, "node_modules")

const isWin = process.platform === "win32"

const args = process.argv.slice(2)
const FLAG = {
    offline: args.includes("--offline"),
    vendor: args.includes("--vendor"),
    uninstall: args.includes("--uninstall"),
    verbose: args.includes("--verbose"),
}
const customCfg = args.includes("--config") ? args[args.indexOf("--config") + 1] : undefined

function log(msg) {
    console.log(`[install] ${msg}`)
}
function fail(msg) {
    console.error(`[install] ERROR ${msg}`)
    process.exit(1)
}

/* -------------------------------------------------------------- raw helpers */
function run(cmd, argsArr, opt = {}) {
    const r = spawnSync(cmd, argsArr, { cwd: process.cwd(), stdio: "inherit", ...opt })
    if (r.status !== 0) throw new Error(`${cmd} ${argsArr.join(" ")} exit ${r.status}`)
}

/** Resolve the real on-disk path (follows junctions). Null when missing. */
function realPath(p) {
    try {
        return resolve(realpathSync(p))
    } catch {
        return null
    }
}

/** Re-create a directory that is a junction/symlink to `target`. */
function ensureLink(dir, target) {
    const desired = resolve(target)
    const existing = realPath(dir)
    if (existing === desired) {
        log(`link ok: ${dir} → ${desired}`)
        return
    }
    if (existing === null) log(`creating ${dir} → ${desired}`)
    else log(`rebuilding ${dir} (currently → ${existing}, want ${desired})`)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    if (isWin) {
        const r = spawnSync("cmd", ["/c", "mklink", "/J", dir, desired], { stdio: "pipe" })
        if (r.status !== 0) fail(`mklink /J ${dir} ${desired} failed: ${r.stderr?.toString()}`)
        log(`linked: ${dir} → ${desired}`)
    } else {
        const r = spawnSync("ln", ["-s", desired, dir], { stdio: "pipe" })
        if (r.status !== 0) fail(`ln -s ${desired} ${dir} failed: ${r.stderr?.toString()}`)
        log(`linked: ${dir} → ${desired}`)
    }
}

/** Deep copy dir, replacing destination entirely. */
function copyTree(src, dst, label) {
    if (!existsSync(src)) return false
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true })
    log(`${label}: ${dst}`)
    return true
}

/* ------------------------------------------------------------ build + vendor */
function buildDist() {
    log(`building dist …`)
    rmSync(join(REPO, "dist"), { recursive: true, force: true })
    try {
        run(process.execPath, [require.resolve("typescript/bin/tsc", { paths: [REPO] })], { cwd: REPO })
    } catch {
        run(isWin ? "npm.cmd" : "npm", ["run", "build"], { cwd: REPO })
    }
    const entry = join(REPO, "dist", "index.js")
    if (!existsSync(entry)) fail(`build finished but missing ${entry}`)
    if (!readFileSync(entry, "utf8").includes("dream-memory")) fail("dist/index.js does not look like the plugin (no magic string)")
    log(`dist ok (${pkg.version})`)
}

/** Bundle runtime deps into vendor/ for offline/intranet transfer. */
function makeVendor() {
    if (!FLAG.offline) buildDist()
    else if (!existsSync(join(REPO, "dist", "index.js"))) fail(`--offline needs dist/ — run without --offline (or --vendor) on a networked machine first`)
    if (!existsSync(join(REPO, "node_modules", "@opencode-ai", "plugin", "package.json")))
        fail("missing node_modules/@opencode-ai/plugin — run `npm install` once on the networked machine")

    // dist
    copyTree(join(REPO, "dist"), VENDOR_DIST, `vendor dist → ${VENDOR_DIST}`)
    // runtime closure: @opencode-ai/plugin and every package the built code loads
    const runtimeDeps = new Set(["@opencode-ai/plugin", "dream-rsi-memory"])
    const scan = (spec) => {
        if (!spec) return
        for (const [name, ver] of Object.entries(spec)) {
            const p = name.startsWith("@") ? join("node_modules", name) : join("node_modules", name)
            void ver
            if (!existsSync(join(REPO, p))) continue
            if (runtimeDeps.has(name)) continue
            runtimeDeps.add(name)
            const meta = JSON.parse(readFileSync(join(REPO, p, "package.json"), "utf8"))
            scan(meta.dependencies)
        }
    }
    scan(JSON.parse(readFileSync(join(REPO, "node_modules", "@opencode-ai", "plugin", "package.json"), "utf8")).dependencies)

    rmSync(VENDOR_NM, { recursive: true, force: true })
    mkdirSync(VENDOR_NM, { recursive: true })
    for (const name of runtimeDeps) {
        const rel = name.startsWith("@") ? `node_modules/${name}` : `node_modules/${name}`
        const srcPath = join(REPO, rel)
        if (!existsSync(srcPath)) continue
        const dstPath = join(VENDOR_NM, ...name.startsWith("@") ? name.split("/") : [name])
        cpSync(srcPath, dstPath, { recursive: true })
    }
    // package deps of vendored tree are self-contained (already inside each copy if nested)
    log(`vendor node_modules → ${VENDOR_NM} (${runtimeDeps.size} tops)`)

    // single-file archive for intranet transfer (git-ignored, release/article friendly).
    // Self-contained: vendor/ + the installer itself + package.json — a target machine
    // needs nothing but this one file (extract, then run the bundled installer).
    const archive = join(REPO, "dream-rsi-memory-vendor.tar.gz")
    rmSync(archive, { force: true })
    const r = spawnSync(isWin ? "tar" : "tar", ["-czf", archive, "-C", REPO, "vendor", "scripts", "package.json"], { cwd: REPO, stdio: "pipe" })
    if (r.status !== 0) fail(`tar failed: ${r.stderr?.toString()}`)
    const size = existsSync(archive) ? Math.round(statSync(archive).size / 1e6) : 0
    log(`archive → ${archive} (${size} MB, self-contained)`)

    writeFileSync(
        join(VENDOR, "manifest.json"),
        JSON.stringify({ plugin: pkg.name, version: pkg.version, createdAt: new Date().toISOString() }, null, 2) + "\n",
        "utf8"
    )
    log(`vendor ready (${pkg.version})`)
}

/* ------------------------------------------------------------ provision scope */
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
            manifestOk = JSON.parse(readFileSync(manifestFile, "utf8")).dependencies?.["dream-rsi-memory"] === `file:${absRepo}`
        } catch {
            manifestOk = false
        }
    }
    if (!manifestOk) {
        writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8")
        log(`wrote ${manifestFile}`)
    }

    if (FLAG.offline) {
        // offline: no junction to repo node_modules — copy everything in
        if (existsSync(NM_DM)) rmSync(NM_DM, { recursive: true, force: true })
        mkdirSync(dirname(NM_DM), { recursive: true })
        cpSync(REPO, NM_DM, { recursive: true, filter: (src) => !src.includes(`${sep}node_modules${sep}`) && !src.includes(`${sep}.git${sep}`) && !src.includes(`${sep}vendor${sep}`) })
        log(`copied repo → ${NM_DM}`)
        copyTree(join(VENDOR_NM, "@opencode-ai"), join(SCOPE_DIR, "node_modules", "@opencode-ai"), "offline @opencode-ai")
        for (const name of readdirSync(VENDOR_NM, { withFileTypes: true })) {
            if (name.name === "@opencode-ai") continue
            const dst = join(SCOPE_DIR, "node_modules", name.name)
            cpSync(join(VENDOR_NM, name.name), dst, { recursive: true })
        }
        log(`offline runtime deps → ${join(SCOPE_DIR, "node_modules")}`)
    } else {
        // dev: keep repo as the single source of truth
        ensureLink(NM_DM, REPO)
        ensureLink(NM_PLUGIN, join(REPO, "node_modules", "@opencode-ai", "plugin"))
    }
}

/* ------------------------------------------------------------ opencode config */
function configPath(custom) {
    if (custom) return resolve(custom)
    const base = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME, "opencode") : join(homedir(), ".config", "opencode")
    const json = join(base, "opencode.json")
    const jsonc = join(base, "opencode.jsonc")
    if (existsSync(json)) return json
    if (existsSync(jsonc)) return jsonc
    return json
}

/** Remove `dream-rsi-memory` from the plugin array of a config file. */
function removeConfigPlugin(file) {
    const appName = "dream-rsi-memory"
    const raw = readFileSync(file, "utf8")
    if (!/"dream-rsi-memory"/.test(raw)) {
        log(`plugin not listed in ${file}`)
        return
    }
    // replace the exact quoted entry (with optional surrounding comma/space/newline)
    const next = raw.replace(/[ \t]*"dream-rsi-memory",?[ \t]*\r?\n?/, "")
    writeFileSync(file, next, "utf8")
    log(`removed "${appName}" from ${file}`)
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

/* ---------------------------------------------------------------------- main */
function uninstall() {
    const cfg = configPath(customCfg)
    if (existsSync(cfg)) removeConfigPlugin(cfg)
    if (existsSync(SCOPE_DIR)) {
        rmSync(SCOPE_DIR, { recursive: true, force: true })
        log(`removed ${SCOPE_DIR}`)
    }
    log("uninstall done. restart opencode to drop the plugin.")
}

if (FLAG.uninstall) {
    uninstall()
    process.exit(0)
}

if (FLAG.vendor) {
    makeVendor()
    log(`
vendor done (${pkg.version})
  assets: ${VENDOR}  (dist/ + node_modules/)
Copy the repo (including vendor/) to the intranet machine, then run:
  node scripts/install.mjs --offline
`)
    process.exit(0)
}

if (FLAG.offline) {
    if (!existsSync(join(VENDOR, "dist", "index.js"))) {
        // support transfer of just the single-file vendor archive
        const archive = join(REPO, "dream-rsi-memory-vendor.tar.gz")
        if (existsSync(archive)) {
            log(`extracting ${archive} → vendor/`)
            rmSync(VENDOR, { recursive: true, force: true })
            const r = spawnSync("tar", ["-xzf", archive, "-C", REPO], { cwd: REPO, stdio: "pipe" })
            if (r.status !== 0) fail(`tar -xzf failed: ${r.stderr?.toString()}`)
        } else {
            fail(`offline needs ${join(VENDOR, "dist")} (or ${archive}) — run \`npm run vendor\` on a networked machine first`)
        }
    }
    if (!existsSync(join(REPO, "dist", "index.js"))) {
        // restore dist from vendor so the plugin body has code to execute
        copyTree(VENDOR_DIST, join(REPO, "dist"), "restored vendor dist → dist")
    }
    log("offline mode (no npm/network/build)")
} else {
    buildDist()
}

provisionScope()
const cfg = configPath(customCfg)
if (existsSync(cfg)) ensureConfigPlugin(cfg)
else fail(`no opencode config found at ${cfg}; create one with  "plugin": ["dream-rsi-memory"]  then re-run`)

const sourceNote = FLAG.offline ? `copied from ${join(VENDOR_NM)}` : `linked → ${REPO}`
log(`
install done (dream-rsi-memory v${pkg.version})
  scope dir : ${SCOPE_DIR}
  plugin    : ${NM_DM}  ${sourceNote}
  config    : ${cfg}
Restart opencode (or open a fresh session) to load the plugin.
Uninstall: node scripts/install.mjs --uninstall
`)