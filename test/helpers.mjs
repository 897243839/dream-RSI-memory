import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "../dist/lib/store.js"

export const fakeLogger = { debug() {}, info() {}, warn() {}, error() {} }

export function baseConfig(overrides = {}) {
    return {
        enabled: true,
        dataDir: mkdtempSync(join(tmpdir(), "dm-test-")),
        debug: false,
        distill: { enabled: false, maxMaterialChars: 6000, timeoutMs: 5000 },
        menu: { enabled: true, cooldownTurns: 2, forceEveryTurns: 5, maxTokensHint: 200 },
        dream: { enabled: true, minNodes: 20, trainRatio: 0.8, epsilon: 0.005, candidateCount: 3 },
        replayWeights: { fileHitRate: 0.35, failureAvoidRate: 0.25, precision: 0.25, recallBudget: 0.15 },
        autoCommitOnIdle: true,
        autoCommitIdleGapMs: 5 * 60_000,
        ...overrides,
    }
}

export async function loadStore(config = baseConfig()) {
    return MemoryStore.load("tproj", "C:/proj", config.dataDir, fakeLogger)
}

export function commitN(store, n, overrides = {}) {
    const out = []
    for (let i = 0; i < n; i++) {
        out.push(
            store.commit({
                summary: overrides.summary ?? `task ${i}: fix billing amount`,
                outcome: overrides.outcome ?? (i % 3 === 0 ? "success" : "partial"),
                files: overrides.files ?? ["src/billing.ts"],
                sessionId: overrides.sessionId ?? "sess-a",
                agentName: "build",
            }),
        )
    }
    return out
}