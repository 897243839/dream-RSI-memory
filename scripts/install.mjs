#!/usr/bin/env node
/**
 * Install / uninstall dream-rsi-memory for opencode.
 *
 * Strategy — mirrors how `opencode-acp` is installed on this machine
 * (see ~/.cache/opencode/packages/opencode-acp@latest): opencode loads npm
 * plugins from ~/.cache/opencode/packages/<name>@latest/ and resolves the
 * plugin entry through that scope's node_modules/<name>. Instead of fragile
 * junctions back into this repo (which die on `npm ci`, cache rebuilds or
 * opencode upgrades), we produce a fully self-contained install there:
 *
 *   packages/dream-rsi-memory@latest/
 *     package.json                  private placeholder manifest
 *     node_modules/dream-rsi-memory/    real copy of package.json + dist/
 *     node_modules/@opencode-ai/plugin + runtime closure   (npm-managed)
 *
 * The placeholder manifest is named "*-offline-installed" and marked private,
 * so opencode never tries to re-fetch the plugin from the npm registry (this
 * package is NOT published); the `file:` dependency keeps any later
 * `npm install` / `bun install` reproducible from this repo instead of failing
 * with a 404.
 *
 * Two installation paths:
 *
 *  dev  (default) — networked machine:
 *      + npm install && npm run install:opencode
 *      1. builds dist/  (needs local typescript)
 *      2. provisions ~/.cache/opencode/packages/dream-rsi-memory@latest/
 *         via a staging dir + `npm install --install-links` (real copies,
 *         no junctions) and swaps it in atomically
 *      3. adds `dream-rsi-memory` to the opencode config plugin array
 *
 *  offline (intranet / no npm next) — no network, npm, or Node build needed:
 *      + On the networked machine:  npm run vendor
 *         -> produces ./vendor/{dist/,node_modules/} (self-contained assets)
 *      + Copy the repo (including vendor/) to the intranet machine, then:
 *           node scripts/install.mjs --offline
 *      1. restores dist from vendor if missing
 *      2. builds the scope node_modules closure by copying from ./vendor (no npm)
 *      3. adds `dream-rsi-memory` to the opencode config plugin array
 *
 * Idempotent: safe to re-run after every code change; the scope's
 * node_modules/dream-rsi-memory is a snapshot, so RE-RUN after each build.
 * Only a restart of opencode (or a fresh session) picks up a rebuilt dist.
 *
 * Usage:
 *   node scripts/install.mjs [--offline] [--config PATH]
 *   node scripts/install.mjs --vendor          # build offline assets into vendor/
 *   node scripts/install.mjs --uninstall       # remove plugin entry + scope dir
 */
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, copyFileSync, statSync, renameSync, writeFileSync } from "node:fs"
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

const VENDOR = join(REPO, "vendor")
const VENDOR_DIST = join(VENDOR, "dist")
const VENDOR_NM = join(VENDOR, "node_modules")

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
    if (!readFileSync(entry, "utf8").includes("dream-memory")) fail("dist/index.js does not look like the plugin (no magic string)")
    log(`dist ok (${pkg.version})`)
}

/** Runtime closure of a package: itself + transitive deps, resolved from a hoisted node_modules. */
function closureOf(nodeModulesRoot, seed, acc = new Set()) {
    for (const name of seed) {
        if (!name || acc.has(name)) continue
        acc.add(name)
        const parts = name.split("/")
        const metaPath = join(nodeModulesRoot, ...parts, "package.json")
        if (!existsSync(metaPath)) continue
        const meta = JSON.parse(readFileSync(metaPath, "utf8"))
        const deps = meta.dependencies ? Object.keys(meta.dependencies) : []
        closureOf(nodeModulesRoot, deps, acc)
    }
    return acc
}

/** Copy each top-level package of `set` from src node_modules into dst node_modules (flat). */
function copyClosure(srcNmRoot, dstNmRoot, set, label) {
    for (const name of set) {
        const parts = name.split("/")
        const srcPath = join(srcNmRoot, ...parts)
        if (!existsSync(srcPath)) continue
        const dstPath = join(dstNmRoot, ...parts)
        mkdirSync(dirname(dstPath), { recursive: true })
        cpSync(srcPath, dstPath, { recursive: true })
    }
    log(`${label}: ${dstNmRoot} (${set.size} tops)`)
}

/** Real plugin body (package.json + dist/) mirroring the published layout. */
function copyPluginBody(dstNodeModulesRoot) {
    const dmDir = join(dstNodeModulesRoot, "dream-rsi-memory")
    rmSync(dmDir, { recursive: true, force: true })
    mkdirSync(dmDir, { recursive: true })
    cpSync(join(REPO, "package.json"), join(dmDir, "package.json"))
    copyTree(join(REPO, "dist"), join(dmDir, "dist"), `plugin dist → ${join(dmDir, "dist")}`)
    return dmDir
}

/** Bundle runtime deps into vendor/ for offline/intranet transfer. */
function makeVendor() {
    if (!FLAG.offline) buildDist()
    else if (!existsSync(join(REPO, "dist", "index.js"))) fail(`--offline needs dist/ — run without --offline (or --vendor) on a networked machine first`)
    if (!existsSync(join(REPO, "node_modules", "@opencode-ai", "plugin", "package.json")))
        fail("missing node_modules/@opencode-ai/plugin — run `npm install` once on the networked machine")

    // dist
    copyTree(join(REPO, "dist"), VENDOR_DIST, `vendor dist → ${VENDOR_DIST}`)
    // runtime closure: @opencode-ai/plugin + everything the built code loads
    const runtimeDeps = closureOf(join(REPO, "node_modules"), ["@opencode-ai/plugin"])

    rmSync(VENDOR_NM, { recursive: true, force: true })
    mkdirSync(VENDOR_NM, { recursive: true })
    copyClosure(join(REPO, "node_modules"), VENDOR_NM, runtimeDeps, "vendor node_modules")
    // package deps of vendored tree are self-contained (already inside each copy if nested)

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
 *     plugin/                         the plugin body (package.json + dist/)
 *     closure/                        runtime deps (flat node_modules layout)
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
    const closureDir = join(offlineRoot, "closure")
    rmSync(offlineRoot, { recursive: true, force: true })

    buildDist()

    // 1) plugin body (package.json + dist/)
    mkdirSync(pluginDir, { recursive: true })
    copyFileSync(join(REPO, "package.json"), join(pluginDir, "package.json"))
    copyTree(join(REPO, "dist"), join(pluginDir, "dist"), "offline plugin dist")

    // 2) runtime closure: @opencode-ai/plugin + everything the built code loads
    const runtimeDeps = closureOf(join(REPO, "node_modules"), ["@opencode-ai/plugin"])
    rmSync(closureDir, { recursive: true, force: true })
    mkdirSync(closureDir, { recursive: true })
    copyClosure(join(REPO, "node_modules"), closureDir, runtimeDeps, "offline closure")

    // 3) assemble the installer folder
    mkdirSync(offlineRoot, { recursive: true })
    copyFileSync(join(REPO, "package.json"), join(offlineRoot, "package.json"))
    writeFileSync(join(offlineRoot, "install.ps1"), offlinePs1(), "utf8")
    writeFileSync(join(offlineRoot, "install.sh"), offlineSh(), "utf8")
    writeFileSync(join(offlineRoot, "README-offline.txt"), offlineReadme(), "utf8")

    // 4) single-file archive
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
$closureSrc = Join-Path $scriptDir "closure"
$scopeNm    = Join-Path $target "node_modules"
$pluginDst  = Join-Path $scopeNm "${PLUGIN_ID}"

Write-Host "=== ${PLUGIN_ID} ${ver} offline installer ===" -ForegroundColor Cyan

if (-not (Test-Path $pluginSrc))  { Write-Host "[ERROR] plugin/ not found: $pluginSrc";  exit 1 }
if (-not (Test-Path $closureSrc)) { Write-Host "[ERROR] closure/ not found: $closureSrc"; exit 1 }

New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
New-Item -ItemType Directory -Path $target -Force | Out-Null
if (Test-Path $scopeNm) { Remove-Item $scopeNm -Recurse -Force }
New-Item -ItemType Directory -Path $scopeNm -Force | Out-Null

Write-Host "[1/3] copying runtime closure..." -ForegroundColor Yellow
Get-ChildItem -Path $closureSrc -Directory | ForEach-Object {
    $dest = Join-Path $scopeNm $_.Name
    if ($_.Name.StartsWith("@")) {
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Get-ChildItem -Path $_.FullName -Directory | ForEach-Object {
            $destScoped = Join-Path $dest $_.Name
            if (Test-Path $destScoped) { Remove-Item $destScoped -Recurse -Force }
            Copy-Item $_.FullName $destScoped -Recurse -Force
        }
    } else {
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        Copy-Item $_.FullName $dest -Recurse -Force
    }
}

Write-Host "[2/3] copying plugin..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $pluginDst -Force | Out-Null
Copy-Item (Join-Path $pluginSrc "package.json") (Join-Path $pluginDst "package.json") -Force
Copy-Item (Join-Path $pluginSrc "dist") (Join-Path $pluginDst "dist") -Recurse -Force

$wrapper = @{ name = "${PLUGIN_ID}-offline-installed"; version = "${ver}"; private = $true; dependencies = @{ "${PLUGIN_ID}" = "${ver}" } }
[System.IO.File]::WriteAllText((Join-Path $target "package.json"), ($wrapper | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[3/3] enabling plugin in opencode config..." -ForegroundColor Yellow
$configFile = Join-Path $configDir "opencode.json"
if (-not (Test-Path $configFile)) { $configFile = Join-Path $configDir "opencode.jsonc" }
if (Test-Path $configFile) {
    $raw = [System.IO.File]::ReadAllText($configFile)
    if ($raw -match '"${PLUGIN_ID}"') {
        Write-Host "plugin already listed in $configFile"
    } elseif ($raw -match '("plugin"\\s*:\\s*)\\[[\\s\\S]*?\\]') {
        $raw = [regex]::Replace($raw, '("plugin"\\s*:\\s*)\\[[\\s\\S]*?\\]', {
            param($m)
            $inner = ($m.Groups[2].Value -replace ',\\s*$', '').Trim()
            if ($inner.Length -eq 0) { return $m.Groups[1].Value + '["${PLUGIN_ID}"]' }
            return $m.Groups[1].Value + '[$inner, "${PLUGIN_ID}"]'
        })
        [System.IO.File]::WriteAllText($configFile, $raw, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "added plugin in $configFile"
    } else {
        $idx = $raw.IndexOf('{')
        $raw = $raw.Substring(0, $idx + 1) + "\`n  \`"plugin\`": [\`"${PLUGIN_ID}\`"]," + $raw.Substring($idx + 1)
        [System.IO.File]::WriteAllText($configFile, $raw, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "added plugin in $configFile"
    }
} else {
    @{ '$schema' = 'https://opencode.ai/config.json'; plugin = @("${PLUGIN_ID}") } |
        ConvertTo-Json -Depth 5 | Set-Content (Join-Path $configDir "opencode.json") -Encoding UTF8
    $configFile = Join-Path $configDir "opencode.json"
    Write-Host "created $configFile with plugin enabled"
}

$entry = Join-Path $pluginDst "dist\\index.js"
if (Test-Path $entry) {
    Write-Host "" -ForegroundColor Cyan
    Write-Host "=== INSTALL SUCCESS ===" -ForegroundColor Green
    Write-Host "Plugin location: $target"
    Write-Host "Config updated : $configFile"
    Write-Host "Restart opencode (or open a fresh session) to load v${ver}." -ForegroundColor White
} else {
    Write-Host "[FAIL] plugin entry missing: $entry" -ForegroundColor Red
    exit 1
}
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
CLOSURE_SRC="$SCRIPT_DIR/closure"
SCOPE_NM="$TARGET/node_modules"
PLUGIN_DST="$SCOPE_NM/${PLUGIN_ID}"

echo "=== ${PLUGIN_ID} ${ver} offline installer ==="

test -d "$PLUGIN_SRC"  || { echo "[ERROR] plugin/ not found: $PLUGIN_SRC";  exit 1; }
test -d "$CLOSURE_SRC" || { echo "[ERROR] closure/ not found: $CLOSURE_SRC"; exit 1; }

mkdir -p "$CACHE_DIR" "$CONFIG_DIR" "$TARGET"
rm -rf "$SCOPE_NM"
mkdir -p "$SCOPE_NM"

echo "[1/3] copying runtime closure..."
for entry in "$CLOSURE_SRC"/*; do
    name=$(basename "$entry")
    dest="$SCOPE_NM/$name"
    if [[ "$name" == @* ]]; then
        mkdir -p "$dest"
        for sub in "$entry"/*; do
            subname=$(basename "$sub")
            rm -rf "$dest/$subname"
            cp -a "$sub" "$dest/$subname"
        done
    else
        rm -rf "$dest"
        cp -a "$entry" "$dest"
    fi
done

echo "[2/3] copying plugin..."
mkdir -p "$PLUGIN_DST"
cp "$PLUGIN_SRC/package.json" "$PLUGIN_DST/package.json"
cp -a "$PLUGIN_SRC/dist" "$PLUGIN_DST/dist"

printf '%s\\n' '{"name":"${PLUGIN_ID}-offline-installed","version":"${ver}","private":true,"dependencies":{"${PLUGIN_ID}":"${ver}"}}' > "$TARGET/package.json"

echo "[3/3] enabling plugin in opencode config..."
CONFIG="$CONFIG_DIR/opencode.json"
test -f "$CONFIG" || CONFIG="$CONFIG_DIR/opencode.jsonc"
node -e '
const fs = require("fs");
const path = process.argv[1];
try { var cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { var cfg = {}; }
const list = Array.isArray(cfg.plugin) ? cfg.plugin.filter(Boolean) : [];
if (!list.includes("${PLUGIN_ID}")) { list.push("${PLUGIN_ID}"); }
cfg.plugin = list;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
' "$CONFIG"

if [ -f "$PLUGIN_DST/dist/index.js" ]; then
    echo ""
    echo "=== INSTALL SUCCESS ==="
    echo "Plugin location: $TARGET"
    echo "Config updated : $CONFIG"
    echo "Restart opencode (or open a fresh session) to load v${ver}."
else
    echo "[FAIL] plugin entry missing"
    exit 1
fi
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
  1. copies runtime closure into ~/.cache/opencode/packages/${PLUGIN_ID}@latest/node_modules/
  2. copies plugin dist/ and package.json into the scope
  3. enables "${PLUGIN_ID}" in ~/.config/opencode/opencode.json (or .jsonc)

Then restart opencode (or open a fresh session). Verify with: /dream status
Uninstall at any time from the source repo: npm run uninstall:opencode
`
}

/* ----------------------------------------------------- scope provisioning */
/**
 * Placeholder manifest for the installed scope. Name is intentionally different
 * from the real plugin and `private: true` so opencode's plugin manager treats
 * the scope as already-installed and never tries the npm registry (which 404s
 * for this unpublished package). The `file:` dep guarantees a re-run of
 * `npm install`/`bun install` inside the scope still resolves, and the
 * `@opencode-ai/plugin` dep lets the runtime closure rebuild from the registry.
 */
function manifestText() {
    // pin the plugin peer to the version actually installed in this repo, so
    // `npm install` inside the scope never picks a newer registry release.
    const pluginMeta = join(REPO, "node_modules", "@opencode-ai", "plugin", "package.json")
    const pluginVer = existsSync(pluginMeta) ? JSON.parse(readFileSync(pluginMeta, "utf8")).version : undefined
    const peerdep = pluginVer ?? pkg.peerDependencies?.["@opencode-ai/plugin"] ?? ">=1.4.3"
    const absRepo = REPO.split(sep).join("/")
    return JSON.stringify(
        {
            name: "dream-rsi-memory-offline-installed",
            version: pkg.version,
            private: true,
            dependencies: {
                "@opencode-ai/plugin": peerdep,
                "dream-rsi-memory": `file:${absRepo}`,
            },
        },
        null,
        2
    ) + "\n"
}

function writeManifest(dir) {
    writeFileSync(join(dir, "package.json"), manifestText(), "utf8")
}

/** Write a stub .package-lock.json so opencode's package manager sees a settled scope. */
function stubLock(dir) {
    // npm writes node_modules/.package-lock.json on install; offline builds don't
    // run npm, so emit a minimal vanity lock so the scope looks non-dirty.
    const lockPath = join(dir, "node_modules", ".package-lock.json")
    const payload = {
        name: "dream-rsi-memory-offline-installed",
        version: pkg.version,
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "dream-rsi-memory-offline-installed", version: pkg.version, private: true } },
    }
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify(payload, null, 2) + "\n", "utf8")
}

/** Provision via `npm install --install-links`: real copies, no junctions. */
function provisionByNpm() {
    const staging = join(CACHE, `.dream-rsi-memory@latest.staging-${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    writeManifest(staging)
    try {
        run(npmCmd, ["install", "--install-links", "--no-audit", "--no-fund"], { cwd: staging })
        copyPluginBody(join(staging, "node_modules"))
    } catch (e) {
        // registry unreachable — fall back to copying the closure from the repo's
        // already-installed node_modules (works fully offline).
        log(`npm install failed (${e?.message}); falling back to closure copy from repo node_modules`)
        provisionByCopy(staging)
    }
    rmSync(join(staging, "package-lock.json"), { force: true })
    installStagingInPlace(staging)
}

/** Provision without npm: copy plugin body + @opencode-ai/plugin closure from the repo/vendor. */
function provisionByCopy(staging) {
    const nm = join(staging, "node_modules")
    mkdirSync(nm, { recursive: true })
    writeManifest(staging)

    copyPluginBody(nm)

    // runtime closure for @opencode-ai/plugin, from vendor/ if present else repo
    let src = VENDOR_NM
    if (!existsSync(join(src, "@opencode-ai", "plugin"))) src = join(REPO, "node_modules")
    if (!existsSync(join(src, "@opencode-ai", "plugin")))
        fail("missing @opencode-ai/plugin in both vendor/ and repo node_modules — run `npm install` once on a networked machine")
    const runtimeDeps = closureOf(src, ["@opencode-ai/plugin"])
    copyClosure(src, nm, runtimeDeps, "scope node_modules")
    stubLock(staging)
}

/** Atomically swap the staging scope into the real cache location. */
function installStagingInPlace(staging) {
    const backup = join(CACHE, `.dream-rsi-memory@latest.bak-${process.pid}`)
    if (existsSync(SCOPE_DIR)) {
        rmSync(backup, { recursive: true, force: true })
        renameSync(SCOPE_DIR, backup)
    }
    try {
        renameSync(staging, SCOPE_DIR)
    } catch (e) {
        if (existsSync(backup)) renameSync(backup, SCOPE_DIR)
        fail(`move ${staging} → ${SCOPE_DIR} failed: ${e?.message}`)
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
    if (!existsSync(join(NM_DM, "package.json"))) fail(`installed but missing ${join(NM_DM, "package.json")}`)
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

/* ------------------------------------------------------------------ verify */
function verifyInstall() {
    const entry = `file:///${join(NM_DM, "dist", "index.js").split("\\").join("/")}`
    const script = `import(${JSON.stringify(entry)}).then((m) => {
        console.log("default id:", m.default && m.default.id, "| named exports:", Object.keys(m).length)
        if (!m.default || m.default.id !== "dream-memory") { console.error("unexpected plugin default export"); process.exit(2) }
        console.log("smoke ok")
    }).catch((e) => { console.error(e); process.exit(1) })`
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: SCOPE_DIR, stdio: "inherit" })
    if (r.status !== 0) fail("installed plugin failed to import — check node_modules closure")
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
    if (existsSync(cfg)) removeConfigPlugin(cfg)
    if (existsSync(SCOPE_DIR)) {
        rmSync(SCOPE_DIR, { recursive: true, force: true })
        log(`removed ${SCOPE_DIR}`)
    }
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
  assets: ${VENDOR}  (dist/ + node_modules/)
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

    const staging = join(CACHE, `.dream-rsi-memory@latest.staging-${process.pid}`)
    if (FLAG.offline) {
        provisionByCopy(staging)
        installStagingInPlace(staging)
    } else {
        provisionByNpm()
    }

    const cfg = configPath(customCfg)
    if (existsSync(cfg)) ensureConfigPlugin(cfg)
    else fail(`no opencode config found at ${cfg}; create one with  "plugin": ["dream-rsi-memory"]  then re-run`)

    verifyInstall()
    restartNag()

    const sourceNote = FLAG.offline ? `copied from ${join(VENDOR_NM)}` : `npm-managed (file: → ${REPO})`
    log(`
install done (dream-rsi-memory v${pkg.version})
  scope dir : ${SCOPE_DIR}
  plugin    : ${NM_DM}  ${sourceNote}
  config    : ${cfg}
  NOTE: node_modules/dream-rsi-memory is a SNAPSHOT — re-run
        \`npm run install:opencode\` after building new dist, then restart opencode.
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