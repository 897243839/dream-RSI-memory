import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url))

function runCli(args, env = {}) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } })
}

test("--help prints usage and exits 0", () => {
    const r = runCli(["--help"])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /dreamrsimem/)
    assert.match(r.stdout, /plugin install opencode/)
    assert.match(r.stdout, /memory list/)
})

test("no args = doctor, exits 0", () => {
    const r = runCli([])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /dreamrsimem doctor/)
})

test("unknown command prints help to stderr and exits 2", () => {
    const r = runCli(["frobnicate"])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown command: frobnicate/)
    assert.match(r.stderr, /Usage:/)
})

test("unknown plugin subcommand exits 2", () => {
    const r = runCli(["plugin", "explode", "opencode"])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown plugin command/)
})

test("doctor --json emits a machine-readable report", () => {
    const r = runCli(["doctor", "--json"])
    assert.equal(r.status, 0)
    const report = JSON.parse(r.stdout)
    assert.ok(typeof report.cliVersion === "string" && report.cliVersion.length > 0)
    assert.ok(report.dist && typeof report.dist.ok === "boolean")
    assert.ok(report.scope && typeof report.scope.dir === "string")
    assert.ok(["root", "nested", "missing", "unknown"].includes(report.scope.layout))
    assert.ok(report.config && typeof report.config.file === "string")
    assert.ok(Array.isArray(report.config.entries))
    assert.ok(report.dataDir && typeof report.dataDir.dir === "string")
    assert.ok(Array.isArray(report.problems))
    // doctor 是诊断：发现问题也必须 exit 0
    assert.equal(r.status, 0)
})

test("--version prints the package.json version", () => {
    const r = runCli(["--version"])
    assert.equal(r.status, 0)
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/)
})

test("memory list parses the data dir (XDG_DATA_HOME temp dir)", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "dm-cli-xdg-"))
    const projectDir = join(dataHome, "opencode", "storage", "plugin", "dream-rsi-memory", "proj-abc")
    const sessionsDir = join(projectDir, "sessions")
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
        join(projectDir, "index.json"),
        JSON.stringify({
            version: 2,
            projectId: "proj-abc",
            rootPath: "C:/work/proj-abc",
            createdAt: "2026-01-01T00:00:00.000Z",
            activePolicyId: "p1",
            policies: {},
            dreamRuns: {},
        }),
    )
    writeFileSync(
        join(sessionsDir, "sess-1.json"),
        JSON.stringify({
            version: 2,
            sessionId: "sess-1",
            nodes: [
                { nodeId: "n1", projectId: "proj-abc", sessionId: "sess-1", agentName: "build", summary: "did a thing", outcome: "success", files: ["a.ts"], turnIndex: 0, createdAt: "2026-01-02T00:00:00.000Z" },
                { nodeId: "n2", projectId: "proj-abc", sessionId: "sess-1", agentName: "build", summary: "did another thing", outcome: "partial", files: ["b.ts"], turnIndex: 1, createdAt: "2026-01-03T00:00:00.000Z" },
            ],
        }),
    )

    const r = runCli(["memory", "list", "--json"], { XDG_DATA_HOME: dataHome })
    assert.equal(r.status, 0)
    const parsed = JSON.parse(r.stdout)
    assert.ok(parsed.dataDir.startsWith(dataHome))
    assert.equal(parsed.projects.length, 1)
    const p = parsed.projects[0]
    assert.equal(p.projectId, "proj-abc")
    assert.equal(p.rootPath, "C:/work/proj-abc")
    assert.equal(p.nodes, 2)
    assert.equal(p.sessions, 1)
    assert.equal(p.lastUpdated, "2026-01-03T00:00:00.000Z")
})

test("memory export renders project nodes as Markdown", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "dm-cli-exp-"))
    const projectDir = join(dataHome, "opencode", "storage", "plugin", "dream-rsi-memory", "proj-x")
    const sessionsDir = join(projectDir, "sessions")
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
        join(projectDir, "index.json"),
        JSON.stringify({ version: 2, projectId: "proj-x", rootPath: "D:/proj-x", createdAt: "2026-01-01T00:00:00.000Z", activePolicyId: "p1", policies: {}, dreamRuns: {} }),
    )
    writeFileSync(
        join(sessionsDir, "sess-9.json"),
        JSON.stringify({
            version: 2,
            sessionId: "sess-9",
            nodes: [
                { nodeId: "nA", projectId: "proj-x", sessionId: "sess-9", agentName: "build", summary: "fixed the bug", outcome: "success", files: ["src/x.ts"], turnIndex: 0, createdAt: "2026-01-02T00:00:00.000Z", why: "because" },
            ],
        }),
    )

    const r = runCli(["memory", "export", "proj-x"], { XDG_DATA_HOME: dataHome })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /# dream-rsi-memory — proj-x/)
    assert.match(r.stdout, /fixed the bug/)
    assert.match(r.stdout, /because/)
    assert.match(r.stdout, /D:\/proj-x/)
})

test("memory export of unknown project exits 1", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "dm-cli-exp404-"))
    const r = runCli(["memory", "export", "nope"], { XDG_DATA_HOME: dataHome })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /project not found/)
})

test("plugin status --json reports install state without writing anything", () => {
    const r = runCli(["plugin", "status", "--json"])
    assert.equal(r.status, 0)
    const status = JSON.parse(r.stdout)
    assert.ok(typeof status.installed === "boolean")
    assert.ok(status.scope && typeof status.scope.dir === "string")
    assert.ok(status.config && typeof status.config.file === "string")
})
