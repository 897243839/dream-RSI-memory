import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { resolveConfig } from "../dist/lib/config.js"

/**
 * 同时沙箱 `OPENCODE_CONFIG_DIR` 与 `XDG_DATA_HOME`：resolveConfig 会在默认
 * 数据目录上跑旧名迁移，测试绝不能碰真实用户目录（`…/storage/plugin/dream-memory`）。
 */
function withConfigDir(body) {
    const dir = mkdtempSync(join(tmpdir(), "dm-cfg-"))
    const xdg = mkdtempSync(join(tmpdir(), "dm-xdg-"))
    const prev = process.env.OPENCODE_CONFIG_DIR
    const prevXdg = process.env.XDG_DATA_HOME
    process.env.OPENCODE_CONFIG_DIR = dir
    process.env.XDG_DATA_HOME = xdg
    try {
        body(dir, xdg)
    } finally {
        if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = prev
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = prevXdg
        rmSync(dir, { recursive: true, force: true })
        rmSync(xdg, { recursive: true, force: true })
    }
}

const pluginStorage = (xdg, name) => join(xdg, "opencode", "storage", "plugin", name)

test("default capture/curator values apply without config", () => {
    withConfigDir(() => {
        const cfg = resolveConfig()
        assert.equal(cfg.capture.maxMaterialChars, 6000)
        // v2.1.0（P1）：curator LLM 候选生成默认开，默认用 opencode 免费模型
        assert.equal(cfg.curator.enabled, true)
        assert.equal(cfg.curator.providerID, "opencode")
        assert.equal(cfg.curator.modelID, "mimo-v2.6-flash-free")
        assert.equal(cfg.curator.timeoutMs, 120000)
        assert.equal("distill" in cfg, false)
    })
})

test("v2.1.0 dream 三阶段/queryLog 默认值", () => {
    withConfigDir(() => {
        const cfg = resolveConfig()
        assert.equal(cfg.dream.enabled, true)
        assert.equal(cfg.dream.minNodesProvisional, 5)
        assert.equal(cfg.dream.minNodes, 20)
        assert.equal(cfg.dream.minValidNodes, 3)
        assert.equal(cfg.dream.seedCount, 5)
        assert.equal(cfg.dream.seed, undefined)
        assert.equal(cfg.dream.queryWindowTurns, 50)
        assert.equal(cfg.dream.replayMinRealQueries, 10)
        assert.equal(cfg.queryLogMax, 1000)
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
        writeFileSync(join(dir, "dream-rsi-memory.json"), JSON.stringify(legacy))
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
        writeFileSync(join(dir, "dream-rsi-memory.json"), JSON.stringify(both))
        const cfg = resolveConfig()
        assert.equal(cfg.capture.maxMaterialChars, 2000)
        assert.equal(cfg.curator.enabled, true)
        assert.equal(cfg.curator.providerID, "openai")
        assert.equal(cfg.curator.timeoutMs, 7000)
    })
})

/* ------------------------------------------------------------------ v2.0.1 改名迁移 */

test("legacy dream-memory.json config file still loads (renamed-file fallback)", () => {
    withConfigDir((dir) => {
        writeFileSync(
            join(dir, "dream-memory.json"),
            JSON.stringify({ debug: true, capture: { maxMaterialChars: 4321 } }),
        )
        const cfg = resolveConfig()
        assert.equal(cfg.debug, true)
        assert.equal(cfg.capture.maxMaterialChars, 4321)
    })
})

test("startup renames legacy dream-memory data dir to dream-rsi-memory", () => {
    withConfigDir((_dir, xdg) => {
        const legacy = pluginStorage(xdg, "dream-memory")
        const current = pluginStorage(xdg, "dream-rsi-memory")
        mkdirSync(legacy, { recursive: true })
        writeFileSync(join(legacy, "index.json"), "{}")

        const cfg = resolveConfig()
        assert.equal(cfg.dataDir, current, "解析结果应指向新目录")
        assert.equal(existsSync(legacy), false, "旧目录应被移走")
        assert.equal(existsSync(current), true, "新目录应出现")
        assert.equal(existsSync(join(current, "index.json")), true, "文件应随目录整体迁移")
    })
})

test("when both data dirs exist the new one wins and the legacy one stays untouched", () => {
    withConfigDir((_dir, xdg) => {
        const legacy = pluginStorage(xdg, "dream-memory")
        const current = pluginStorage(xdg, "dream-rsi-memory")
        mkdirSync(legacy, { recursive: true })
        mkdirSync(current, { recursive: true })
        writeFileSync(join(legacy, "old.json"), "{}")
        writeFileSync(join(current, "new.json"), "{}")

        const cfg = resolveConfig()
        assert.equal(cfg.dataDir, current)
        assert.equal(existsSync(join(legacy, "old.json")), true, "旧目录不得被合并/覆盖/删除")
        assert.equal(existsSync(join(current, "new.json")), true, "新目录原样保留")
    })
})

test("explicit dataDir disables legacy data-dir migration", () => {
    withConfigDir((dir, xdg) => {
        const legacy = pluginStorage(xdg, "dream-memory")
        mkdirSync(legacy, { recursive: true })
        writeFileSync(join(legacy, "keep.json"), "{}")
        const custom = mkdtempSync(join(tmpdir(), "dm-custom-"))
        writeFileSync(join(dir, "dream-rsi-memory.json"), JSON.stringify({ dataDir: custom }))
        try {
            const cfg = resolveConfig()
            assert.equal(cfg.dataDir, custom)
            assert.equal(existsSync(legacy), true, "用户显式配置 dataDir 时不得迁移")
        } finally {
            rmSync(custom, { recursive: true, force: true })
        }
    })
})