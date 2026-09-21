import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { resolveConfig } from "../dist/lib/config.js"

function withConfigDir(body) {
    const dir = mkdtempSync(join(tmpdir(), "dm-cfg-"))
    const prev = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = dir
    try {
        body(dir)
    } finally {
        if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = prev
        rmSync(dir, { recursive: true, force: true })
    }
}

test("default capture/curator values apply without config", () => {
    withConfigDir(() => {
        const cfg = resolveConfig()
        assert.equal(cfg.capture.maxMaterialChars, 6000)
        assert.equal(cfg.curator.enabled, false)
        assert.equal(cfg.curator.timeoutMs, 120000)
        assert.equal("distill" in cfg, false)
    })
})

test("legacy distill config migrates to capture + curator", () => {
    withConfigDir((dir) => {
        const legacy = {
            distill: {
                enabled: true,
                providerID: "anthropic",
                modelID: "claude-test",
                maxMaterialChars: 1234,
                timeoutMs: 5000,
            },
        }
        writeFileSync(join(dir, "dream-memory.json"), JSON.stringify(legacy))
        const cfg = resolveConfig()
        assert.equal(cfg.capture.maxMaterialChars, 1234)
        assert.equal(cfg.curator.enabled, true)
        assert.equal(cfg.curator.providerID, "anthropic")
        assert.equal(cfg.curator.modelID, "claude-test")
        assert.equal(cfg.curator.timeoutMs, 5000)
        assert.equal("distill" in cfg, false)
    })
})

test("new capture/curator config wins over legacy distill", () => {
    withConfigDir((dir) => {
        const both = {
            distill: { maxMaterialChars: 999, enabled: true },
            capture: { maxMaterialChars: 2000 },
            curator: { enabled: true, providerID: "openai", modelID: "gpt-x", timeoutMs: 7000 },
        }
        writeFileSync(join(dir, "dream-memory.json"), JSON.stringify(both))
        const cfg = resolveConfig()
        assert.equal(cfg.capture.maxMaterialChars, 2000)
        assert.equal(cfg.curator.enabled, true)
        assert.equal(cfg.curator.providerID, "openai")
        assert.equal(cfg.curator.timeoutMs, 7000)
    })
})