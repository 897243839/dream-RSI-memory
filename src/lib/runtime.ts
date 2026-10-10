/**
 * 宿主无关的启动逻辑：config 解析 → 项目根归一 → MemoryStore 加载 → deps 组装。
 *
 * 1.x（V1 server）与 2.x（V2 setup）唯一的差别是「怎么把 ctx 变成 client」和
 * 「往哪些 seam 注册」；这部分两边完全一致，抽出来避免两套启动代码漂移。
 */
import type { ToolDefinition } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { FileCollector } from "./capture.js"
import { resolveConfig } from "./config.js"
import { Logger } from "./logger.js"
import { GateRegistry } from "./menu.js"
import { MetaLlm } from "./meta-llm.js"
import { MemoryStore } from "./store.js"
import { createTools } from "./tools.js"
import type { MemoryConfig } from "./types.js"
import { isRootPath, projectIdOf } from "./utils.js"

export interface DreamRuntime {
    /** 会话/项目目录（原样保留，用于 MetaLlm 的 query.directory）。 */
    directory: string
    /** 归一后的项目根（无效目录回退 home）。 */
    rootPath: string
    projectId: string
    config: MemoryConfig
    logger: Logger
    store: MemoryStore
    gate: GateRegistry
    collector: FileCollector
    client: unknown
    meta: MetaLlm
    tools: Record<string, ToolDefinition>
}

/**
 * 返回 `null` 表示插件被配置关闭（`enabled:false`），调用方应保持 inert。
 */
export async function createRuntime(directory: string, client: unknown): Promise<DreamRuntime | null> {
    const config = resolveConfig({ directory })
    if (!config.enabled) return null

    const logger = new Logger(config.debug)
    let rootPath = directory
    if (!rootPath || isRootPath(rootPath)) {
        // Desktop opencode (GUI) can start without a real project cwd, passing
        // "/" or similar as the worktree. That is not a usable project root,
        // but skipping registration silently leaves the GUI with no tools.
        // Fall back to the user's home directory so the plugin still works.
        const home = homedir()
        logger.warn("invalid rootPath; falling back to home", { rootPath, home })
        rootPath = home
    }

    const projectId = projectIdOf(rootPath)
    const store = await MemoryStore.load(projectId, rootPath, config.dataDir, logger)
    logger.info("loaded", { projectId, nodes: store.count(), policy: store.activePolicy().policyId })

    const gate = new GateRegistry()
    const collector = new FileCollector()
    const meta = new MetaLlm(client, config, logger, directory)
    const tools = createTools({ client, store, config, logger, collector, meta })

    return { directory, rootPath, projectId, config, logger, store, gate, collector, client, meta, tools }
}
