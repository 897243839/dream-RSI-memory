import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { FileCollector } from "./lib/capture.js"
import { resolveConfig } from "./lib/config.js"
import {
    createCommandExecuteHandler,
    createEventHandler,
    createMessagesTransformHandler,
    createSystemPromptHandler,
    createToolExecuteBeforeHandler,
} from "./lib/hooks.js"
import { Logger } from "./lib/logger.js"
import { GateRegistry } from "./lib/menu.js"
import { MetaLlm } from "./lib/meta-llm.js"
import { MemoryStore } from "./lib/store.js"
import { createTools } from "./lib/tools.js"
import { projectIdOf } from "./lib/utils.js"

const server: Plugin = async (input) => {
    const config = resolveConfig(input)
    if (!config.enabled) return {}

    const logger = new Logger(config.debug)
    const rootPath = input.worktree || input.directory
    const projectId = projectIdOf(rootPath)
    const store = await MemoryStore.load(projectId, rootPath, config.dataDir, logger)
    logger.info("loaded", { projectId, nodes: store.count(), policy: store.activePolicy().policyId })

    const gate = new GateRegistry()
    const collector = new FileCollector()
    const meta = new MetaLlm(input.client, config, logger, input.directory)

    const hooks: Hooks = {
        event: createEventHandler(input.client, store, config, collector, logger),
        config: async (opencodeConfig) => {
            const cfg = opencodeConfig as { command?: Record<string, { template: string; description?: string }>; experimental?: { primary_tools?: string[] } }
            cfg.command ??= {}
            cfg.command.dream = { template: "", description: "Dream-Memory：做梦引擎（status / run）" }
            cfg.command.memory = { template: "", description: "Dream-Memory：记忆库（stats / policy / show <nodeId>）" }
            cfg.experimental ??= {}
            cfg.experimental.primary_tools ??= []
            if (!cfg.experimental.primary_tools.includes("search_history_experience")) {
                cfg.experimental.primary_tools.push("search_history_experience")
            }
        },
        tool: createTools({ client: input.client, store, config, logger, collector, meta }),
        "command.execute.before": createCommandExecuteHandler(input.client, store, config, { logger, meta, collector }),
        "tool.execute.before": createToolExecuteBeforeHandler(collector),
        "experimental.chat.messages.transform": createMessagesTransformHandler(store, gate, config, collector),
        "experimental.chat.system.transform": createSystemPromptHandler(config),
    }
    return hooks
}

export default {
    id: "dream-memory",
    server,
} satisfies PluginModule