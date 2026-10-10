#!/usr/bin/env node
/**
 * Install / uninstall dream-rsi-memory for opencode.
 *
 * Layout — the scope root IS the plugin directory (same shape as
 * billion-context@latest on this machine):
 *
 *   ~/.cache/opencode/packages/dream-rsi-memory@latest/
 *     index.js        shim: `export { default } from "./dist/index.js"`
 *     package.json    the real manifest (exports["./server"] → ./dist/index.js)
 *     dist/           built plugin
 *
 * opencode 2.x resolves a configured *directory* through its package.json
 * "exports" (falling back to `<dir>/server.*` / `<dir>/index.*`); it never
 * reads package.json "main" alone and it never looks inside node_modules for a
 * path entry. dream has ZERO runtime dependencies (`@opencode-ai/plugin` is a
 * peerDependency that opencode itself provides), so no node_modules layer is
 * installed at all — and any node_modules / package-lock.json left behind by
 * the previous nested layout is deleted on install (upgrade path).
 *
 * Two installation paths (identical result — a flat copy of the plugin body):
 *
 *  dev  (default) — networked machine:
 *      + npm install && npm run install:opencode
 *      1. builds dist/  (needs local typescript)
 *      2. copies index.js + package.json + dist/ into a staging dir and swaps
 *         it into ~/.cache/opencode/packages/dream-rsi-memory@latest atomically
 *      3. adds the scope *directory* to the opencode config plugin array
 *         (opencode 2.x drops absolute file targets: "configured plugin path
 *         must be a directory")
 *
 *  offline (intranet / no npm) — no network, npm, or Node build needed:
 *      + On the networked machine:  npm run vendor   (vendor/ = dist only)
 *      + Copy the repo (including vendor/) to the intranet machine, then:
 *            node scripts/install.mjs --offline
 *      or use the single-file installer:
 *            npm run pack:offline  ->  dream-rsi-memory-offline.tar.gz
 *                                        (install.ps1 / install.sh + plugin/)
 *
 * Idempotent: safe to re-run after every code change; the scope is a snapshot,
 * so RE-RUN after each build. Only a restart of opencode (or a fresh session)
 * picks up a rebuilt dist.
 *
 * Usage:
 *   node scripts/install.mjs [--offline] [--config PATH]
 *   node scripts/install.mjs --vendor          # build offline assets into vendor/
 *   node scripts/install.mjs --offline-package # build install.ps1/sh installer
 *   node scripts/install.mjs --uninstall       # remove plugin entry + scope dir
 */
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, copyFileSync, statSync, renameSync, readdirSync, rmdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..")
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"))

const CACHE = join(homedir(), ".cache", "opencode", "packages")
const SCOPE_DIR = join(CACHE, "dream-rsi-memory@latest")

/**
 * Plugin entry as an absolute **directory** path (forward slashes, JSON-string safe).
 *
 * opencode 2.x rejects absolute *file* targets: it logs
 * "configured plugin path must be a directory" and drops the entry, so the plugin
 * never loads (that is how both of this machine's plugins ended up silently dead).
 * For a path plugin it reads `<dir>/package.json` "exports" (["./server"]), falling
 * back to `<dir>/server.*` and `<dir>/index.*` — it never reads package.json "main"
 * and never looks inside `<dir>/node_modules`. That is why the repo ships an
 * `index.js` shim at the package root (copyPluginBody keeps it in sync) and why the
 * scope root itself is the plugin directory.
 *
 * A bare package name (`dream-rsi-memory`) is worse still: it makes every opencode
 * start run `npm install <name>`, which on a machine whose registry is unreachable
 * fails with 404/ENOTFOUND and blocks session start for minutes.
 */
function pluginEntrySpec() {
    return SCOPE_DIR.split("\\").join("/")
}

const VENDOR = join(REPO, "vendor")
const VENDOR_DIST = join(VENDOR, "dist")

const isWin = process.platform === "win32"
const npmCmd = isWin ? "npm.cmd" : "npm"

const args = process.argv.slice(2)
const FLAG = {
    offline: args.includes("--offline"),
    offlinePackage: args.includes("--offline-package"),
    vendor: args.includes("--vendor"),
    uninstall: args.includes("--uninstall"),
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
const RUN_QUOTE = new RegExp(`[${"\\s"}"]`)

/** Raw helper · run child with inherited stdio; throws on non-zero/abnormal exit. */
function run(cmd, argsArr, opt = {}) {
    // .cmd/.bat on Windows spawn via CreateProcess only with a shell involved;
    // pass a single command line when a shell is used (avoids DEP0190 + quoting).
    const shell = isWin && /\.(cmd|bat)$/i.test(cmd)
    const final = { cwd: process.cwd(), stdio: "inherit", ...opt }
    const q = (a) => (RUN_QUOTE.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)
    const r = shell
        ? spawnSync(`${cmd} ${argsArr.map(q).join(" ")}`, { ...final, shell: true })
        : spawnSync(cmd, argsArr, final)
    if (r.status !== 0) {
        const why = r.signal ? `signal ${r.signal}` : `exit ${r.status}`
        throw new Error(`${cmd} ${argsArr.join(" ")} ${why}`)
    }
}

/** Raw helper · run child and return captured stdout; throws on non-zero/abnormal exit. */
function runCapture(cmd, argsArr, opt = {}) {
    const shell = isWin && /\.(cmd|bat)$/i.test(cmd)
    const final = { encoding: "utf8", ...opt }
    const q = (a) => (RUN_QUOTE.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)
    const r = shell
        ? spawnSync(`${cmd} ${argsArr.map(q).join(" ")}`, { ...final, shell: true })
        : spawnSync(cmd, argsArr, final)
    if (r.status !== 0) {
        const why = r.signal ? `signal ${r.signal}` : `exit ${r.status}`
        throw new Error(`${cmd} ${argsArr.join(" ")} ${why}`)
    }
    return r.stdout
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
        run(npmCmd, ["run", "build"], { cwd: REPO })
    }
    const entry = join(REPO, "dist", "index.js")
    if (!existsSync(entry)) fail(`build finished but missing ${entry}`)
    if (!readFileSync(entry, "utf8").includes("dream-rsi-memory")) fail("dist/index.js does not look like the plugin (no magic string)")
    // opencode 2.x resolves a plugin directory as `<dir>/index.*` (never package.json "main").
    if (!existsSync(join(REPO, "index.js"))) fail(`missing ${join(REPO, "index.js")} (opencode 2.x needs <dir>/index.js)`)
    log(`dist ok (${pkg.version})`)
}

/**
 * The two packages the built plugin imports at runtime: dream's dist
 * value-imports `@opencode-ai/plugin` (dist/lib/tools.js, dist/lib/v2-compat.js)
 * and the SDK's `./tool.js` re-export in turn imports `zod`. opencode does not
 * inject them into the plugin's module graph (its loader is a plain
 * `import(entry)`), so both are copied into the scope's node_modules —
 * machine-independent, no registry needed.
 * NB: `@opencode-ai/plugin`'s package.json declares 4 dependencies
 * (@ai-sdk/provider, @opencode-ai/sdk, effect, zod) — only `./tool.js` is
 * reachable from dream's imports today, and that module's closure is just
 * `zod` (4.1.8, itself dependency-free). The moment dist imports any other
 * entry (/tui, /v2/effect, …) this closure is INCOMPLETE and the entry must be
 * added here; the smoke import in verifyInstall() is what catches it.
 */
const RUNTIME_PACKAGES = ["@opencode-ai/plugin", "zod"]

/**
 * Real plugin body (package.json + index.js shim + dist/ + the two runtime
 * packages) copied **flat** into `dstDir` — the scope root is the plugin
 * directory, and node_modules only ever holds RUNTIME_PACKAGES (no
 * node_modules/dream-rsi-memory layer).
 */
function copyPluginBody(dstDir) {
    rmSync(dstDir, { recursive: true, force: true })
    mkdirSync(dstDir, { recursive: true })
    cpSync(join(REPO, "package.json"), join(dstDir, "package.json"))
    // opencode 2.x resolves a plugin directory via package.json "exports" (or
    // `<dir>/index.*`), never package.json "main" alone — without this shim the
    // installed package would not load at all.
    const shim = join(REPO, "index.js")
    if (!existsSync(shim)) fail(`missing ${shim} (opencode 2.x needs <dir>/index.js)`)
    cpSync(shim, join(dstDir, "index.js"))
    if (copyTree(join(REPO, "dist"), join(dstDir, "dist"), `plugin dist → ${join(dstDir, "dist")}`) === false)
        fail(`missing ${join(REPO, "dist")} — build it first (skip --offline so buildDist() runs)`)

    for (const name of RUNTIME_PACKAGES) {
        const parts = name.split("/")
        const src = join(REPO, "node_modules", ...parts)
        if (!existsSync(join(src, "package.json")))
            fail(`missing ${src} — run \`npm install\` once on a networked machine (or use \`npm run pack:offline\`, which carries it)`)
        const dst = join(dstDir, "node_modules", ...parts)
        rmSync(dst, { recursive: true, force: true })
        mkdirSync(dirname(dst), { recursive: true })
        cpSync(src, dst, { recursive: true })
        log(`runtime package → ${dst}`)
    }
    return dstDir
}

/** Bundle the built dist into vendor/ for offline/intranet transfer. */
function makeVendor() {
    if (!FLAG.offline) buildDist()
    else if (!existsSync(join(REPO, "dist", "index.js"))) fail(`--offline needs dist/ — run without --offline (or --vendor) on a networked machine first`)

    // dist only — no closure is vendored here BECAUSE the runtime packages
    // (@opencode-ai/plugin + zod) ride along with the scope payload itself
    // (copyPluginBody), not because the plugin were dependency-free.
    copyTree(join(REPO, "dist"), VENDOR_DIST, `vendor dist → ${VENDOR_DIST}`)

    // single-file archive for intranet transfer (git-ignored, release/article friendly).
    // Self-contained: vendor/ + the installer itself + package.json — a target machine
    // needs nothing but this one file (extract, then run the bundled installer).
    const archive = join(REPO, "dream-rsi-memory-vendor.tar.gz")
    rmSync(archive, { force: true })
    const r = spawnSync("tar", ["-czf", archive, "-C", REPO, "vendor", "scripts", "package.json"], { cwd: REPO, stdio: "pipe" })
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

/* ------------------------------------------- offline package (copy-based, no npm) */
/**
 * Build a self-contained intranet installer that uses **pure file copies**
 * (no npm, no cache keys, works across any npm/Node version):
 *   vendor/offline/
 *     install.ps1 / install.sh        one-command installer (copies files)
 *     plugin/                         the full scope payload, laid down at the
 *                                     scope root by the installer:
 *                                       package.json + index.js shim + dist/
 *                                       node_modules/@opencode-ai/plugin + node_modules/zod
 *                                     (the only two runtime packages — no closure of others)
 *     package.json                    plugin metadata (informational)
 *     README-offline.txt              quick start
 *   dream-rsi-memory-offline.tar.gz   <- single file to carry to the intranet machine
 *
 * On the intranet machine (only Node.js >= 18 needed, no npm required):
 *   tar -xzf, then:  powershell -ExecutionPolicy Bypass -File install.ps1   (Windows)
 *   or:           chmod +x install.sh && ./install.sh                   (Linux/macOS)
 */
function makeOfflinePackage() {
    const offlineRoot = join(VENDOR, "offline")
    const pluginDir = join(offlineRoot, "plugin")
    rmSync(offlineRoot, { recursive: true, force: true })

    buildDist()

    // 1) the whole payload = flat plugin body + the two runtime packages
    //    (dream's dist value-imports @opencode-ai/plugin, whose tool.js imports
    //    zod — opencode injects neither, so they travel inside plugin/)
    copyPluginBody(pluginDir)

    // 2) assemble the installer folder
    mkdirSync(offlineRoot, { recursive: true })
    copyFileSync(join(REPO, "package.json"), join(offlineRoot, "package.json"))
    writeFileSync(join(offlineRoot, "install.ps1"), offlinePs1(), "utf8")
    writeFileSync(join(offlineRoot, "install.sh"), offlineSh(), "utf8")
    writeFileSync(join(offlineRoot, "README-offline.txt"), offlineReadme(), "utf8")

    // 3) single-file archive
    const archive = join(REPO, "dream-rsi-memory-offline.tar.gz")
    rmSync(archive, { force: true })
    const r = spawnSync("tar", ["-czf", archive, "-C", VENDOR, "offline"], { cwd: REPO, stdio: "pipe" })
    if (r.status !== 0) fail(`tar failed: ${r.stderr?.toString()}`)
    const size = existsSync(archive) ? Math.round((statSync(archive).size / 1e6) * 10) / 10 : 0
    log(`offline package → ${archive} (${size} MB)`)

    log(`offline package ready (${pkg.version})`)
}

const PLUGIN_ID = "dream-rsi-memory"

/** install.ps1 body — pure file copies, no npm needed (only Node.js on PATH). */
function offlinePs1() {
    const ver = pkg.version
    return `$ErrorActionPreference = "Stop"

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$cacheDir   = Join-Path $env:USERPROFILE ".cache\\opencode\\packages"
$configDir  = Join-Path $env:USERPROFILE ".config\\opencode"
$target     = Join-Path $cacheDir "${PLUGIN_ID}@latest"
$pluginSrc  = Join-Path $scriptDir "plugin"

Write-Host "=== ${PLUGIN_ID} ${ver} offline installer ===" -ForegroundColor Cyan

if (-not (Test-Path $pluginSrc)) { Write-Host "[ERROR] plugin/ not found: $pluginSrc"; exit 1 }

New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
New-Item -ItemType Directory -Path $target -Force | Out-Null

Write-Host "[1/3] copying plugin payload (dist/ + bundled node_modules)..." -ForegroundColor Yellow
# Upgrade path: drop remnants of the OLD nested layout before copying. The
# payload's node_modules replaces the target's wholesale, so stale npm-managed
# closures and any ${PLUGIN_ID} layer are removed here, first.
if (Test-Path (Join-Path $target "node_modules")) { Remove-Item (Join-Path $target "node_modules") -Recurse -Force }
if (Test-Path (Join-Path $target "package-lock.json")) { Remove-Item (Join-Path $target "package-lock.json") -Force }
Get-ChildItem -Path $pluginSrc -Force | ForEach-Object {
    $dest = Join-Path $target $_.Name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
}

Write-Host "[2/3] enabling plugin in opencode config..." -ForegroundColor Yellow
# opencode 2.x loads a plugin from a directory (<dir>/index.js), so the config
# entry is the target directory itself.
$entry = $target
$entrySpec = $entry -replace '\\\\','/'

$configFile = Join-Path $configDir "opencode.json"
if (-not (Test-Path $configFile)) { $configFile = Join-Path $configDir "opencode.jsonc" }
if (Test-Path $configFile) {
    $raw = [System.IO.File]::ReadAllText($configFile)
    $quotedEntry = '"' + $entrySpec + '"'
    # Legacy forms: bare package name (V1) or an old path entry under the scope.
    $legacy = [regex]::Match($raw, '"(?:' + [regex]::Escape("${PLUGIN_ID}") + '|[^"]*' + [regex]::Escape("${PLUGIN_ID}@latest") + '[^"]*)"')
    if ($raw.Contains($quotedEntry)) {
        Write-Host "plugin already listed in $configFile"
    } elseif ($legacy.Success) {
        # opencode 2.x drops absolute file targets ("configured plugin path must be
        # a directory") and re-fetches bare names from the npm registry on every
        # start (404 / ENOTFOUND blocks session start). Upgrade to the directory.
        $raw = $raw.Substring(0, $legacy.Index) + $quotedEntry + $raw.Substring($legacy.Index + $legacy.Length)
        [System.IO.File]::WriteAllText($configFile, $raw, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "upgraded legacy plugin entry to scope directory in $configFile"
    } elseif ($raw -match '("plugins?"\\s*:\\s*)\\[[\\s\\S]*?\\]') {
        $m2 = [regex]::Match($raw, '("plugins?"\\s*:\\s*)\\[[\\s\\S]*?\\]')
        $inner = ($m2.Groups[2].Value -replace ',\\s*$','').Trim()
        if ($inner.Length -eq 0) { $arr = '["' + $entrySpec + '"]' } else { $arr = '[' + $inner + ', "' + $entrySpec + '"]' }
        $raw = $raw.Substring(0, $m2.Index) + $m2.Groups[1].Value + $arr + $raw.Substring($m2.Index + $m2.Length)
        [System.IO.File]::WriteAllText($configFile, $raw, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "added local plugin entry in $configFile"
    } else {
        $idx = $raw.IndexOf('{')
        $raw = $raw.Substring(0, $idx + 1) + "\`n  \`"plugins\`": [\`"$entrySpec\`"]," + $raw.Substring($idx + 1)
        [System.IO.File]::WriteAllText($configFile, $raw, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "added local plugin entry in $configFile"
    }
} else {
    @{ '$schema' = 'https://opencode.ai/config.json'; plugins = @($entrySpec) } |
        ConvertTo-Json -Depth 5 | Set-Content (Join-Path $configDir "opencode.json") -Encoding UTF8
    $configFile = Join-Path $configDir "opencode.json"
    Write-Host "created $configFile with plugin enabled"
}

Write-Host "[3/3] verifying installed layout..." -ForegroundColor Yellow
$required = @(
    (Join-Path $target "index.js"),
    (Join-Path $target "package.json"),
    (Join-Path $target "dist\\index.js"),
    (Join-Path $target "node_modules\\@opencode-ai\\plugin\\package.json"),
    (Join-Path $target "node_modules\\zod\\package.json")
)
$missing = @($required | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
    foreach ($m in $missing) { Write-Host "[FAIL] missing: $m" -ForegroundColor Red }
    exit 1
}
if (Test-Path (Join-Path $target "node_modules\\${PLUGIN_ID}")) {
    Write-Host "[FAIL] legacy node_modules\\${PLUGIN_ID} layer still present" -ForegroundColor Red
    exit 1
}

Write-Host "" -ForegroundColor Cyan
Write-Host "=== INSTALL SUCCESS ===" -ForegroundColor Green
Write-Host "Plugin location: $target"
Write-Host "Config updated : $configFile"
Write-Host "Restart opencode (or open a fresh session) to load v${ver}." -ForegroundColor White
`
}

/** install.sh body — pure file copies, no npm needed. */
function offlineSh() {
    const ver = pkg.version
    return `#!/usr/bin/env bash
# ${PLUGIN_ID} ${ver} offline installer (Linux/macOS)
# Only requires Node.js >= 18; npm is NOT needed.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$HOME/.cache/opencode/packages"
CONFIG_DIR="$HOME/.config/opencode"
TARGET="$CACHE_DIR/${PLUGIN_ID}@latest"
PLUGIN_SRC="$SCRIPT_DIR/plugin"

echo "=== ${PLUGIN_ID} ${ver} offline installer ==="

test -d "$PLUGIN_SRC" || { echo "[ERROR] plugin/ not found: $PLUGIN_SRC"; exit 1; }

mkdir -p "$CACHE_DIR" "$CONFIG_DIR" "$TARGET"

echo "[1/3] copying plugin payload (dist/ + bundled node_modules)..."
# Upgrade path: drop remnants of the old nested layout first; the payload's
# node_modules replaces the target's wholesale.
rm -rf "$TARGET/node_modules" "$TARGET/package-lock.json"
for entry in "$PLUGIN_SRC"/*; do
    name=$(basename "$entry")
    rm -rf "$TARGET/$name"
    cp -a "$entry" "$TARGET/$name"
done

echo "[2/3] enabling plugin in opencode config..."
CONFIG="$CONFIG_DIR/opencode.json"
test -f "$CONFIG" || CONFIG="$CONFIG_DIR/opencode.jsonc"
# opencode 2.x loads a plugin from a directory (<dir>/index.js), so the config
# entry is the target directory itself.
ENTRY_SPEC="$TARGET"
node -e '
const fs = require("fs");
const path = process.argv[1];
const entry = process.argv[2];
try { var cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { var cfg = {}; }
const list = (Array.isArray(cfg.plugins) ? cfg.plugins : Array.isArray(cfg.plugin) ? cfg.plugin : []).filter(Boolean);
// opencode 2.x drops absolute file targets ("configured plugin path must be a
// directory") and re-fetches bare names from the npm registry on every start.
// Write the local directory and upgrade any legacy entry (bare name or old path).
const at = list.findIndex((x) => typeof x === "string" && (x === "dream-rsi-memory" || x.includes("dream-rsi-memory@latest")));
if (at >= 0) list[at] = entry; else list.push(entry);
delete cfg.plugin;
cfg.plugins = list;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
' "$CONFIG" "$ENTRY_SPEC"

echo "[3/3] verifying installed layout..."
missing=0
for f in index.js package.json dist/index.js node_modules/@opencode-ai/plugin/package.json node_modules/zod/package.json; do
    if [ ! -e "$TARGET/$f" ]; then echo "[FAIL] missing: $TARGET/$f"; missing=1; fi
done
if [ -e "$TARGET/node_modules/${PLUGIN_ID}" ]; then
    echo "[FAIL] legacy node_modules/${PLUGIN_ID} layer still present"
    missing=1
fi
if [ "$missing" -ne 0 ]; then exit 1; fi

echo ""
echo "=== INSTALL SUCCESS ==="
echo "Plugin location: $TARGET"
echo "Config updated : $CONFIG"
echo "Restart opencode (or open a fresh session) to load v${ver}."
`
}

/** Short readme inside the offline folder. */
function offlineReadme() {
    const ver = pkg.version
    return `dream-rsi-memory v${ver} — offline installer (${PLUGIN_ID})

Prerequisites: Node.js >= 18 (npm is NOT required).

Windows:
    powershell -ExecutionPolicy Bypass -File install.ps1

Linux / macOS:
    chmod +x install.sh && ./install.sh

What it does (fully offline, no network needed):
  1. copies the plugin payload (package.json + index.js shim + dist/ +
     bundled node_modules/@opencode-ai/plugin + node_modules/zod) into
     ~/.cache/opencode/packages/${PLUGIN_ID}@latest/  (scope root = the plugin)
  2. enables "${PLUGIN_ID}" in ~/.config/opencode/opencode.json (or .jsonc)
  3. verifies index.js / package.json / dist/index.js / the two bundled runtime
     packages are present and no legacy node_modules/${PLUGIN_ID} layer remains

Then restart opencode (or open a fresh session). Verify with: /dream status
Uninstall at any time from the source repo: npm run uninstall:opencode
`
}

/* ----------------------------------------------------- scope provisioning */
/**
 * Build the staging tree that becomes the entire scope root: package.json +
 * index.js shim + dist/ + node_modules/{@opencode-ai/plugin, zod}, copied
 * straight from this repo. No npm involved → works offline, needs no registry,
 * and is machine-independent (the two runtime packages travel with the plugin).
 */
function provision(staging) {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    copyPluginBody(staging)
}

/**
 * In-place upgrade: copy every staging file over the live tree, then delete
 * live-only files best-effort. A running opencode may hold files under `dist/`
 * — on Windows held files still accept overwrite, and deletions that hit a
 * lock are skipped (they belong to the old payload and are retried on the
 * next run). No file is removed before its replacement exists, so a crash
 * mid-way leaves a working (if mixed) install; the new code activates on the
 * next opencode restart.
 */
function mergeTree(src, dst) {
    const keep = new Set()
    // Windows file systems are case-insensitive: keep must be too, otherwise a
    // pre-existing file whose case differs from the new name would be swept
    // right after being overwritten (review P2 #8).
    const key = (p) => (isWin ? p.toLowerCase() : p)
    const copyFailures = []
    const copy = (s, d) => {
        mkdirSync(d, { recursive: true })
        for (const name of readdirSync(s)) {
            const sp = join(s, name)
            const dp = join(d, name)
            keep.add(key(dp))
            if (statSync(sp).isDirectory()) copy(sp, dp)
            else {
                try {
                    copyFileSync(sp, dp)
                } catch (e) {
                    // one held file must not abort the merge and masquerade as
                    // a total failure — collect and report after the sweep
                    copyFailures.push(`${dp} (${e.code || e.message})`)
                }
            }
        }
    }
    copy(src, dst)
    const sweep = (d) => {
        let names
        try {
            names = readdirSync(d)
        } catch {
            return
        }
        for (const name of names) {
            const p = join(d, name)
            let isDir = false
            try {
                isDir = statSync(p).isDirectory()
            } catch {
                continue
            }
            if (isDir) {
                sweep(p)
                if (keep.has(key(p))) continue // a kept empty dir must survive
                try {
                    rmdirSync(p)
                } catch {
                    // non-empty (held leftovers) → keep
                }
            } else if (!keep.has(key(p))) {
                try {
                    rmSync(p, { force: true })
                } catch {
                    // locked by a running process → retried on next upgrade
                }
            }
        }
    }
    sweep(dst)
    if (copyFailures.length > 0)
        log(`** warning: ${copyFailures.length} file(s) could not be merged (locked?): ${copyFailures.slice(0, 5).join(", ")}${copyFailures.length > 5 ? ", …" : ""}`)
    log(`upgraded in place → ${dst}`)
}

/**
 * Install the staging scope into the real cache location.
 *
 * opencode may have the plugin LOADED while we install (it hot-reloads when
 * the config changes), which locks `dist/` on Windows — renaming the live
 * directory then fails with EPERM. Strategy:
 *  1. Atomic rename dance (live → .bak, staging → live), up to 3 attempts with
 *     a short backoff for transient locks (antivirus scans). The OLD tree must
 *     never be touched before the swap succeeds: a failed swap has to leave
 *     the current install fully functional (the old nested-layout cleanup
 *     therefore happens on .bak / inside mergeTree, not before the swap).
 *  2. If the live dir stays locked, upgrade in place via mergeTree().
 * Both paths end with the same layout assertions below, and the OLD trees
 * (backup / staging) are only dropped afterwards by main() — deleting them
 * before the assertions could strand the machine on a broken payload with no
 * working install left to roll back to.
 */
const PENDING_CLEANUP = []
function installStagingInPlace(staging) {
    // sweep leftovers of earlier runs; never our own staging payload
    let siblings = []
    try {
        siblings = readdirSync(CACHE)
    } catch {}
    for (const name of siblings)
        if (/^\.dream-rsi-memory@latest\.(bak|staging)-\d+$/.test(name) && !name.endsWith(`-${process.pid}`)) {
            try {
                rmSync(join(CACHE, name), { recursive: true, force: true })
            } catch {
                // locked leftover → next run
            }
        }

    const backup = join(CACHE, `.dream-rsi-memory@latest.bak-${process.pid}`)
    let swapped = false
    if (existsSync(SCOPE_DIR)) {
        for (let attempt = 1; attempt <= 3 && !swapped; attempt++) {
            try {
                renameSync(SCOPE_DIR, backup)
                try {
                    renameSync(staging, SCOPE_DIR)
                } catch (e) {
                    try {
                        renameSync(backup, SCOPE_DIR) // roll back: live must stay intact
                    } catch {}
                    throw e
                }
                swapped = true
            } catch (e) {
                const locked = e && (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES")
                if (!locked || attempt === 3) break
                const wait = 400
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
            }
        }
        if (swapped) {
            log(`upgraded: replaced ${SCOPE_DIR}`)
            PENDING_CLEANUP.push(backup) // dropped in main() after verifyInstall()
        } else {
            log(`scope dir locked by a running process — upgrading in place (restart opencode to activate)`)
            mergeTree(staging, SCOPE_DIR)
            PENDING_CLEANUP.push(staging) // dropped in main() after verifyInstall()
        }
    } else {
        renameSync(staging, SCOPE_DIR) // fresh install: nothing to replace
    }

    const required = [
        join(SCOPE_DIR, "index.js"),
        join(SCOPE_DIR, "package.json"),
        join(SCOPE_DIR, "dist", "index.js"),
        join(SCOPE_DIR, "node_modules", "@opencode-ai", "plugin", "package.json"),
        join(SCOPE_DIR, "node_modules", "zod", "package.json"),
    ]
    for (const f of required) if (!existsSync(f)) fail(`installed but missing ${f}`)
    if (existsSync(join(SCOPE_DIR, "node_modules", "dream-rsi-memory")))
        fail(`legacy ${join(SCOPE_DIR, "node_modules", "dream-rsi-memory")} layer survived the upgrade`)
    log(`scope ready → ${SCOPE_DIR}`)
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

/**
 * True if a parsed plugins-array element (string value) names this plugin —
 * deliberately NARROW, because these values are also *replaced*, and a broad
 * test could rewrite unrelated entries that merely mention the string (e.g. an
 * mcp command path). Only two forms are recognised:
 *   - the bare package name (V1 style, exact): "dream-rsi-memory"
 *   - a path under this plugin's npm scope (V2 local directory or old path):
 *     anything containing "dream-rsi-memory@latest"
 * Matching happens on values INSIDE the plugins/plugin arrays only (see
 * findPluginArrays) — never on the whole file.
 */
function isDreamPluginEntry(v) {
    return typeof v === "string" && (v === pluginEntrySpec() || v === PLUGIN_ID || v.includes(`${PLUGIN_ID}@latest`))
}

/**
 * Remove the dream-rsi-memory plugin entries ONLY — surgically, from the
 * `plugin`/`plugins` array(s) alone. Each array's elements are split at
 * top-level commas, and only elements that are a bare string equal to (or
 * scoped under) this plugin get dropped. Anything else — mcp command paths,
 * unrelated plugins, comments/objects — is left untouched by design
 * ("宁可少删不可误删"). If no array or no removable entry is found, the file is
 * NOT modified and a warning is logged.
 */
function removeConfigPlugin(file) {
    const raw = readFileSync(file, "utf8")
    let removed = 0
    let noteLeft = false
    let next = raw
    // walk arrays back-to-front so earlier offsets stay valid as we rewrite
    const arrays = findPluginArrays(next)
    for (let k = arrays.length - 1; k >= 0; k--) {
        const a = arrays[k]
        const inner = next.slice(a.open + 1, a.close)
        const elems = splitTopLevel(inner)
        const kept = []
        let changed = false
        for (const e of elems) {
            const s = e.trim()
            const val = elemStringValue(s)
            if (typeof val === "string" && isDreamPluginEntry(val)) {
                removed++
                changed = true
            } else {
                if (/dream-rsi-memory/.test(s)) noteLeft = true
                kept.push(s)
            }
        }
        if (!changed) continue
        next = next.slice(0, a.open + 1) + kept.join(", ") + next.slice(a.close)
    }
    if (removed === 0) {
        log(`plugin entry not found in ${file} — nothing removed`)
        return
    }
    assertJsonc(file, next)
    writeFileSync(file, next, "utf8")
    log(`removed ${removed} dream-rsi-memory plugin entry/entries from ${file}`)
    if (noteLeft || /dream-rsi-memory/.test(next))
        log(`NOTE: ${file} still mentions dream-rsi-memory (e.g. an mcp command path) — kept on purpose, only plugins/plugin arrays are edited`)
}

/** Split a JSON array body into top-level element strings (comma at depth 0).
 * JSONC comments are copied through opaquely, so a comma or bracket inside a
 * comment never splits or truncates an element. */
function splitTopLevel(inner) {
    const parts = []
    let depth = 0
    let inStr = false
    let esc = false
    let cur = ""
    for (let i = 0; i < inner.length; i++) {
        const c = inner[i]
        if (esc) { cur += c; esc = false; continue }
        if (inStr) {
            cur += c
            if (c === "\\") esc = true
            else if (c === '"') inStr = false
            continue
        }
        if (c === '"') { inStr = true; cur += c; continue }
        if (c === "/" && inner[i + 1] === "/") {
            const nl = inner.indexOf("\n", i)
            const stop = nl < 0 ? inner.length : nl + 1
            cur += inner.slice(i, stop)
            i = stop - 1
            continue
        }
        if (c === "/" && inner[i + 1] === "*") {
            const end = inner.indexOf("*/", i + 2)
            const stop = end < 0 ? inner.length : end + 2
            cur += inner.slice(i, stop)
            i = stop - 1
            continue
        }
        if (c === "[" || c === "{" || c === "(") depth++
        if (c === "]" || c === "}" || c === ")") depth--
        if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue }
        cur += c
    }
    if (cur.trim().length > 0) parts.push(cur)
    return parts
}

/** Index just past the JSON string whose opening quote is at `i` (escapes honoured). */
function skipString(s, i) {
    i++
    while (i < s.length) {
        if (s[i] === "\\") { i += 2; continue }
        if (s[i] === '"') return i + 1
        i++
    }
    return s.length
}

/** Index of the next character that is neither whitespace nor a JSONC comment
 * (starting at `i`); returns s.length if there is none. Strings are NOT
 * skipped — callers start this scan where a structural token is expected. */
function nextSignificant(s, i) {
    while (i < s.length) {
        const c = s[i]
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue }
        if (c === "/" && s[i + 1] === "/") {
            const nl = s.indexOf("\n", i)
            if (nl < 0) return s.length
            i = nl + 1
            continue
        }
        if (c === "/" && s[i + 1] === "*") {
            const end = s.indexOf("*/", i + 2)
            if (end < 0) return s.length
            i = end + 2
            continue
        }
        return i
    }
    return s.length
}

/** Index of the `]` matching the `[` at `open`, honouring strings and JSONC
 * comments (a `]` inside a comment does not close the array); -1 if unclosed. */
function matchBracket(s, open) {
    let depth = 1
    let i = open + 1
    while (i < s.length) {
        const c = s[i]
        if (c === '"') { i = skipString(s, i); continue }
        if (c === "/" && s[i + 1] === "/") {
            const nl = s.indexOf("\n", i)
            if (nl < 0) return -1
            i = nl + 1
            continue
        }
        if (c === "/" && s[i + 1] === "*") {
            const end = s.indexOf("*/", i + 2)
            if (end < 0) return -1
            i = end + 2
            continue
        }
        if (c === "[") depth++
        else if (c === "]") {
            depth--
            if (depth === 0) return i
        }
        i++
    }
    return -1
}

/** Every `"plugins"?: [` (or `"plugin": [`) array in the document, located by a
 * JSONC-aware scan — NOT a non-greedy regex, which truncates on elements that
 * contain `]` (e.g. Windows paths like `D:\proj [old]\plugin`). */
function findPluginArrays(s) {
    const found = []
    let i = 0
    while (i < s.length) {
        const c = s[i]
        if (c === '"') {
            const end = skipString(s, i)
            const key = s.slice(i + 1, end - 1)
            const m = /^(\s*:\s*\[)/.exec(s.slice(end))
            if ((key === "plugins" || key === "plugin") && m) {
                const open = end + m[1].length - 1
                const close = matchBracket(s, open)
                if (close > open) {
                    found.push({ key, open, close })
                    i = close + 1
                    continue
                }
            }
            i = end
            continue
        }
        if (c === "/" && s[i + 1] === "/") {
            const nl = s.indexOf("\n", i)
            i = nl < 0 ? s.length : nl + 1
            continue
        }
        if (c === "/" && s[i + 1] === "*") {
            const end = s.indexOf("*/", i + 2)
            i = end < 0 ? s.length : end + 2
            continue
        }
        i++
    }
    return found
}

/** The string value of a plugins-array element, or undefined when the element
 * is anything other than (optionally leading comments +) a single JSON string. */
function elemStringValue(s) {
    const t = s.trim()
    const m = /^(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*"((?:[^"\\]|\\.)*)"/.exec(t)
    if (!m) return undefined
    const rest = t.slice(m[0].length)
    if (!/^(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*$/.test(rest)) return undefined
    return m[1].replace(/\\"/g, '"')
}

/** Strip JSONC comments and trailing commas (validation only — the file keeps
 * its original formatting), then require the result to parse. Every config
 * write goes through this gate: a malformed edit must never reach disk. */
function jsoncToJSON(s) {
    let out = ""
    // A UTF-8 BOM (Windows editors ship one) makes JSON.parse throw even though
    // the structure is fine — skip it for validation; the file keeps its bytes.
    let i = s.charCodeAt(0) === 0xfeff ? 1 : 0
    while (i < s.length) {
        const c = s[i]
        if (c === '"') {
            const end = skipString(s, i)
            out += s.slice(i, end)
            i = end
            continue
        }
        if (c === "/" && s[i + 1] === "/") {
            const nl = s.indexOf("\n", i)
            i = nl < 0 ? s.length : nl
            continue
        }
        if (c === "/" && s[i + 1] === "*") {
            const end = s.indexOf("*/", i + 2)
            i = end < 0 ? s.length : end + 2
            continue
        }
        if (c === ",") {
            const n = nextSignificant(s, i + 1)
            if (n >= s.length || s[n] === "]" || s[n] === "}") { i++; continue } // trailing comma
            out += c
            i++
            continue
        }
        out += c
        i++
    }
    return out
}

function assertJsonc(file, next) {
    try {
        JSON.parse(jsoncToJSON(next))
    } catch (e) {
        fail(`refusing to write ${file}: the edit would not parse (${e.message})`)
    }
}

/**
 * Insert the local **directory** plugin entry into a json/jsonc config.
 * A legacy entry found in place (bare V1 name or an old path under the
 * dream-rsi-memory@latest scope) is upgraded element-wise inside the
 * plugins/plugin array only — never by a whole-file replace, so an mcp command
 * path that merely mentions the scope can never be rewritten: opencode 2.x
 * drops file targets ("configured plugin path must be a directory") and
 * re-fetches bare names from the npm registry on every start, which blocks
 * session start when the registry is unreachable.
 * Every write is gated by assertJsonc — a malformed edit must not reach disk.
 */
function ensureConfigPlugin(file) {
    const entry = pluginEntrySpec()
    const quoted = JSON.stringify(entry)
    const raw = readFileSync(file, "utf8")
    const arrays = findPluginArrays(raw)
    const elementsOf = (a) =>
        splitTopLevel(raw.slice(a.open + 1, a.close)).map((e) => ({ text: e, value: elemStringValue(e) }))
    const isLegacy = (el) => typeof el.value === "string" && el.value !== entry && isDreamPluginEntry(el.value)

    // 1) already listed in a plugin array → nothing to do
    for (const a of arrays)
        for (const el of elementsOf(a))
            if (el.value === entry) {
                log(`plugin already listed in ${file}`)
                return
            }

    // 2) legacy entry inside an array → upgrade THAT element only
    for (const a of arrays) {
        const els = elementsOf(a)
        if (!els.some(isLegacy)) continue
        const rebuilt = els.map((el) => (isLegacy(el) ? quoted : el.text.trim()))
        const next = raw.slice(0, a.open + 1) + rebuilt.join(", ") + raw.slice(a.close)
        assertJsonc(file, next)
        writeFileSync(file, next, "utf8")
        log(`upgraded plugin entry to local directory in ${file}`)
        return
    }

    // 3) no entry anywhere: append to the first plugin array (prefer V2 spelling)
    const target = arrays.find((a) => a.key === "plugins") || arrays[0]
    if (target) {
        const inner = raw.slice(target.open + 1, target.close).trim()
        const newInner = inner.length === 0 ? quoted : `${inner.replace(/,\s*$/, "")}, ${quoted}`
        const next = raw.slice(0, target.open + 1) + newInner + raw.slice(target.close)
        assertJsonc(file, next)
        writeFileSync(file, next, "utf8")
        log(`added local plugin entry to ${target.key} list in ${file}`)
        return
    }

    // 4) no plugin array at all: insert a top-level V2 `plugins` key after the
    // opening brace. (opencode 2.0.24 accepts both `plugin` and `plugins`;
    // `plugins` is the documented V2 key.) An EMPTY object must get NO trailing
    // comma — that was a config-breaking bug on `{}`.
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
        if (c === "/" && raw[i + 1] === "/") {
            const nl = raw.indexOf("\n", i)
            i = nl < 0 ? raw.length : nl
            continue
        }
        if (c === "/" && raw[i + 1] === "*") {
            const end = raw.indexOf("*/", i + 2)
            i = end < 0 ? raw.length : end + 1
            continue
        }
        if (c === "{" && depth === 0) braceAt = i
        else if (c === "{") depth++
        else if (c === "}") depth--
    }
    if (braceAt < 0) fail(`cannot insert plugin key into ${file}: no top-level object found`)
    const indent = "  "
    const isEmpty = raw[nextSignificant(raw, braceAt + 1)] === "}"
    const insertion = isEmpty ? `\n${indent}"plugins": [${quoted}]` : `\n${indent}"plugins": [${quoted}],`
    const next = raw.slice(0, braceAt + 1) + insertion + raw.slice(braceAt + 1)
    assertJsonc(file, next)
    writeFileSync(file, next, "utf8")
    log(`added local plugin entry to plugin list in ${file}`)
}

/* ------------------------------------------------------------------ verify */
function verifyInstall() {
    // layout invariants first: the scope root IS the plugin dir, the two runtime
    // packages it imports are bundled, and no legacy nested layer remains.
    const bundled = [
        join(SCOPE_DIR, "node_modules", "@opencode-ai", "plugin", "package.json"),
        join(SCOPE_DIR, "node_modules", "zod", "package.json"),
    ]
    for (const f of bundled) if (!existsSync(f)) fail(`installed but missing bundled runtime package: ${f}`)
    if (existsSync(join(SCOPE_DIR, "node_modules", "dream-rsi-memory")))
        fail(`legacy nested layer still present: ${join(SCOPE_DIR, "node_modules", "dream-rsi-memory")}`)

    const entry = `file:///${join(SCOPE_DIR, "index.js").split("\\").join("/")}`
    const script = `import(${JSON.stringify(entry)}).then((m) => {
        console.log("default id:", m.default && m.default.id, "| named exports:", Object.keys(m).length)
        if (!m.default || m.default.id !== "dream-rsi-memory") { console.error("unexpected plugin default export"); process.exit(2) }
        if (typeof m.default.setup !== "function") { console.error("V2 plugin must export setup()"); process.exit(3) }
        console.log("smoke ok")
    }).catch((e) => { console.error(e); process.exit(1) })`
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: SCOPE_DIR, stdio: "inherit" })
    if (r.status !== 0) fail("installed plugin failed to import — check dist/ and the bundled node_modules")
}

function restartNag() {
    if (!isWin) return
    const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process opencode -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"], { encoding: "utf8" })
    const n = parseInt((r.stdout || "").trim(), 10)
    if (n > 0) log(`** ${n} opencode process(es) running — restart opencode (or open a fresh session) to load v${pkg.version}`)
    else log("no opencode process running — next opencode start will load the plugin")
}

/* ---------------------------------------------------------------------- main */
function uninstall() {
    const cfg = configPath(customCfg)
    // Delete the directory FIRST: a running opencode holds files under dist/
    // and rmSync then throws EPERM. Removing the config entry before that
    // would leave a half-deleted install still registered (and the failure
    // would look total while the config was already edited).
    if (existsSync(SCOPE_DIR)) {
        try {
            rmSync(SCOPE_DIR, { recursive: true, force: true })
            log(`removed ${SCOPE_DIR}`)
        } catch (e) {
            const locked = e && (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES")
            if (locked)
                fail(`${SCOPE_DIR} is locked by a running process — quit opencode and re-run --uninstall (config left untouched)`)
            throw e
        }
    }
    if (existsSync(cfg)) removeConfigPlugin(cfg)
    log("uninstall done. restart opencode to drop the plugin.")
}

function main() {
    // always print at least one line so a silent/dead environment is easy to spot
    log(`node ${process.version} @ ${process.cwd()}`)
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10)
    if (nodeMajor < 18)
        fail(`requires Node.js >= 18 (this host has ${process.version}) — install a current LTS and re-run`)

    if (FLAG.uninstall) {
        uninstall()
        return
    }

    if (FLAG.vendor) {
        makeVendor()
        log(`
vendor done (${pkg.version})
  assets: ${VENDOR}  (dist/ only — no bundled packages; the scope payload always
  carries node_modules/{@opencode-ai/plugin, zod} itself, see copyPluginBody)
On the intranet machine (Node >= 18 installed), extract the same dir and run:
  node scripts/install.mjs --offline
`)
        return
    }

    if (FLAG.offlinePackage) {
        makeOfflinePackage()
        return
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
        log(`offline mode picked up ${join(REPO, "package.json")}`)
    } else {
        buildDist()
    }

    // provision is copy-only (repo → staging), identical online and offline
    const staging = join(CACHE, `.dream-rsi-memory@latest.staging-${process.pid}`)
    provision(staging)
    installStagingInPlace(staging)

    const cfg = configPath(customCfg)
    if (existsSync(cfg)) ensureConfigPlugin(cfg)
    else fail(`no opencode config found at ${cfg}; create one with  "plugins": ["dream-rsi-memory"]  then re-run`)

    verifyInstall()
    // the new payload is asserted AND imports — only now drop the old trees.
    // Deleting them earlier would leave a broken payload unrollbackable.
    for (const p of PENDING_CLEANUP) {
        try {
            rmSync(p, { recursive: true, force: true })
        } catch {
            log(`note: kept ${p} (locked); swept on next run`)
        }
    }
    restartNag()

    log(`
install done (dream-rsi-memory v${pkg.version})
  scope dir : ${SCOPE_DIR}  (scope root = the plugin: index.js + package.json + dist/)
  runtime   : ${join(SCOPE_DIR, "node_modules")}  (@opencode-ai/plugin + zod bundled with the plugin)
  config    : ${cfg}
Uninstall: node scripts/install.mjs --uninstall
`)
}

try {
    main()
} catch (e) {
    const detail = e && e.stack ? e.stack : String(e)
    const logPath = join(REPO, "install.log")
    try {
        mkdirSync(REPO, { recursive: true })
        writeFileSync(logPath, `[${new Date().toISOString()}] FATAL:\n${detail}\n`, "utf8")
    } catch {}
    console.error(`[install] FATAL: ${detail}`)
    console.error(`[install] details also written to ${logPath}`)
    process.exit(1)
}