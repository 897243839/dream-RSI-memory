export const DREAM_NUDGE_NODE_THRESHOLD = `
<system-reminder>
⚠️ 记忆库节点已达 N 条（≥20），检索策略已过时——现在应调用 dream_memory_dream 进化策略。这会自动测试候选参数并切换到更优策略，提升后续检索质量。

直接调用 dream_memory_dream（无参数），不需要等用户指令。
</system-reminder>
`

export const DREAM_NUDGE_LOW_QUALITY = `
<system-reminder>
⚠️ 连续检索质量低（top score < 0.15），当前检索策略不适合当前任务——应调用 dream_memory_dream 进化策略以改善匹配。

直接调用 dream_memory_dream（无参数），不需要等用户指令。
</system-reminder>
`

export const DREAM_NUDGE_STALE = `
<system-reminder>
⚠️ 距上次进化已超过 10 个节点，检索策略可能已退化——应调用 dream_memory_dream 重新评估。

直接调用 dream_memory_dream（无参数），不需要等用户指令。
</system-reminder>
`
