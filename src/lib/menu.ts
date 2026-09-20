import type { MemoryConfig } from "./types.js"

interface GateEntry {
    lastInjectionNodeCount: number
    userTurnsSinceInjection: number
}

/**
 * Cooldown/force gating for the end-of-turn menu (design §9.3):
 * - inject at most once per user turn
 * - never before cooldownTurns user turns since last injection
 * - inject when a new node was recorded OR forceEveryTurns elapsed
 */
export class GateRegistry {
    private gate = new Map<string, GateEntry>()

    noteUserTurn(sessionID: string): void {
        const current = this.gate.get(sessionID)
        this.gate.set(sessionID, {
            lastInjectionNodeCount: current?.lastInjectionNodeCount ?? -1,
            userTurnsSinceInjection: (current?.userTurnsSinceInjection ?? 0) + 1,
        })
    }

    shouldInject(sessionID: string, nodeCount: number, config: MemoryConfig["menu"]): boolean {
        const current = this.gate.get(sessionID)
        if (!current) return false
        if (current.userTurnsSinceInjection < config.cooldownTurns) return false
        const addedSinceLast = current.lastInjectionNodeCount < 0 ? nodeCount : nodeCount - current.lastInjectionNodeCount
        return addedSinceLast >= 1 || current.userTurnsSinceInjection >= config.forceEveryTurns
    }

    markInjected(sessionID: string, nodeCount: number): void {
        this.gate.set(sessionID, {
            lastInjectionNodeCount: nodeCount,
            userTurnsSinceInjection: 0,
        })
    }
}