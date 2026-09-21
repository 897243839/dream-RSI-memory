import { test } from "node:test"
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function loadEntry() {
    const require = createRequire(import.meta.url)
    const entry = pathToFileURL(require.resolve("../dist/index.js")).href
    return import(entry)
}

test("plugin entry exports V1 PluginModule with id", async () => {
    const mod = await loadEntry()

    assert.equal(typeof mod.default, "object")
    assert.equal(mod.default.id, "dream-memory")
    assert.equal(typeof mod.default.server, "function")
    assert.ok(!("tui" in mod.default), "should not declare a tui surface")
})

test("plugin server wires up hooks under an isolated project", async () => {
    const mod = await loadEntry()

    const proj = mkdtempSync(join(tmpdir(), "dm-entry-"))
    const data = mkdtempSync(join(tmpdir(), "dm-entry-data-"))
    try {
        mkdirSync(join(proj, ".opencode"))
        writeFileSync(
            join(proj, ".opencode", "dream-memory.jsonc"),
            JSON.stringify({ enabled: true, dataDir: data, distill: { enabled: false } }),
        )

        const hooks = await mod.default.server({
            client: {},
            directory: proj,
            worktree: proj,
        })

        for (const key of ["event", "config", "command.execute.before", "tool.execute.before", "experimental.chat.messages.transform"]) {
            assert.equal(typeof hooks[key], "function", `hooks.${key} should be a function`)
        }
        assert.equal(typeof hooks.tool, "object", "hooks.tool should be the tool registry")
        assert.ok(hooks.tool, "tool hooks present")
    } finally {
        rmSync(proj, { recursive: true, force: true })
        rmSync(data, { recursive: true, force: true })
    }
})

test("plugin server still wires up hooks when worktree is root (desktop GUI)", async () => {
    const mod = await loadEntry()

    const data = mkdtempSync(join(tmpdir(), "dm-entry-data-"))
    try {
        const home = mkdtempSync(join(tmpdir(), "dm-entry-home-"))
        try {
            const hooks = await mod.default.server({
                client: {},
                directory: "/",
                worktree: "/",
                config: { dataDir: data },
            })

            assert.equal(typeof hooks.tool, "object", "hooks.tool should be present even for root worktree")
            assert.equal(typeof hooks["command.execute.before"], "function", "command handler should be present")
        } finally {
            rmSync(home, { recursive: true, force: true })
        }
    } finally {
        rmSync(data, { recursive: true, force: true })
    }
})