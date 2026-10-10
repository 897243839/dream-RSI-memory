import type { MemoryConfig } from "./types.js"

/**
 * 三阶段门槛（v2.1.0，P0）—— 替代旧的单一 `n < minNodes` 硬闸：
 *
 * | 阶段 | 条件 | dream 行为 |
 * | --- | --- | --- |
 * | S 播种期 | n < minNodesProvisional (N1=5) | 不评估不切换，但写一条"证据不足"的 DreamRunRecord |
 * | M 试用期 | N1 ≤ n < minNodes (N2=20) | 正常评估；valid 样本不足时放宽门槛，切换出的策略带 provisional |
 * | F 正式期 | n ≥ minNodes | 现状门槛；dream 后处理 active 的 provisional（转正/交接） |
 *
 * 所有消费方（dream / hooks nudge / 菜单文案 / tools 低分提示）都必须经由
 * `getStage` 取阶段，不允许再散落 `n < 20` 之类的字面判断。
 */
export type DreamStage = "S" | "M" | "F"

export function getStage(
    n: number,
    dream: Pick<MemoryConfig["dream"], "minNodesProvisional" | "minNodes">,
): DreamStage {
    if (n < dream.minNodesProvisional) return "S"
    if (n < dream.minNodes) return "M"
    return "F"
}

/** 阶段的中文名（展示用）。 */
export function stageName(stage: DreamStage): string {
    return stage === "S" ? "播种期" : stage === "M" ? "试用期" : "正式期"
}
