#!/usr/bin/env node
/**
 * dreamrsimem — install / diagnostics CLI (方案 §9, C2 子集)。
 *
 * 安装/卸载只做一件事：spawn `scripts/install.mjs`（继承 stdio、透传退出码），
 * 保证 CLI 与脚本共用同一实现。只读检查（doctor / status / memory）在
 * src/lib/opencode-install.ts。
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
    type DoctorReport,
    type InstallStatus,
    PACKAGE_ROOT,
    PLUGIN_ID,
    type ScopeInfo,
    doctorOpenCode,
    exportProjectMarkdown,
    listMemoryProjects,
    memoryDataDir,
    readPackageVersion,
    statusOpenCode,
} from "./lib/opencode-install.js"

const HELP = `dreamrsimem — dream-RSI-memory install/diagnostics

Usage:
  dreamrsimem                          same as \`doctor\`
  dreamrsimem doctor [--json]          health check: build / scope / config / data dir / processes
  dreamrsimem plugin install opencode [--offline]
                                       install the plugin (delegates to scripts/install.mjs)
  dreamrsimem plugin remove opencode   uninstall (delegates to scripts/install.mjs --uninstall)
  dreamrsimem plugin status [--json]   install state + disk version + config entry + scope layout
  dreamrsimem memory list [--json]     list memory projects in the data dir
  dreamrsimem memory export <projectId>
                                       export one project's nodes as Markdown to stdout
  dreamrsimem --version                print CLI version
  dreamrsimem --help                   this help

Notes:
  doctor is a diagnostic, not an assertion: problems are listed but exit code stays 0.
  install/remove run \`node scripts/install.mjs\` in a child process and pass its
  exit code through unchanged.`

function hasFlag(args: string[], flag: string): boolean {
    return args.includes(flag)
}

/* --------------------------------------------------------------- output */

function describeScope(scope: ScopeInfo): string {
    const parts = [`layout=${scope.layout}`]
    if (scope.diskVersion) parts.push(`disk version ${scope.diskVersion}`)
    return parts.join(", ")
}

function printStatus(status: InstallStatus): void {
    console.log(`installed:  ${status.installed ? "yes" : "no"}`)
    console.log(`version:    CLI ${status.cliVersion} / disk ${status.diskVersion ?? "(none)"}`)
    console.log(`scope:      ${status.scope.dir}`)
    console.log(`            ${describeScope(status.scope)}`)
    if (status.scope.pluginDir) console.log(`plugin dir: ${status.scope.pluginDir}`)
    console.log(`config:     ${status.config.file}${status.config.exists ? "" : " (not created yet)"}`)
    for (const entry of status.config.entries) console.log(`            - ${entry}`)
    if (status.config.entries.length === 0) console.log(`            (no ${PLUGIN_ID} entry)`)
}

function printDoctor(report: DoctorReport): void {
    console.log(`dreamrsimem doctor — CLI version ${report.cliVersion}`)
    console.log()
    console.log(`build artifacts   ${report.dist.ok ? "ok" : "MISSING"}  ${report.dist.indexJs}`)
    console.log(`                                ${report.dist.cliJs}`)
    console.log(`scope dir         ${report.scope.exists ? "ok" : "MISSING"}  ${report.scope.dir}`)
    console.log(`                  ${describeScope(report.scope)}`)
    if (report.scope.pluginDir) console.log(`plugin dir        ${report.scope.pluginDir}`)
    console.log(`config entry      ${report.config.file}${report.config.exists ? "" : " (not created yet)"}`)
    for (const entry of report.config.entries) console.log(`                  - ${entry}`)
    if (report.config.entries.length === 0) console.log(`                  (no ${PLUGIN_ID} entry)`)
    console.log(
        `data dir          ${report.dataDir.exists ? "ok" : "MISSING"}  ${report.dataDir.dir}` +
            `  (${report.dataDir.projects} project(s), ${report.dataDir.nodes} node(s))`,
    )
    console.log(`opencode process  ${report.opencodeProcesses === "unknown" ? "unknown" : report.opencodeProcesses}`)
    console.log()
    if (report.problems.length === 0) {
        console.log("problems: none")
    } else {
        console.log(`problems (${report.problems.length}):`)
        for (const problem of report.problems) console.log(`  - ${problem}`)
    }
}

/* ------------------------------------------------------------- commands */

function cmdDoctor(args: string[]): number {
    const report = doctorOpenCode()
    if (hasFlag(args, "--json")) console.log(JSON.stringify(report, null, 2))
    else printDoctor(report)
    // doctor 是诊断工具不是断言：发现问题仍 exit 0。
    return 0
}

function cmdPlugin(args: string[]): number {
    const [sub, target, ...rest] = args
    if (sub === "status") {
        const status = statusOpenCode()
        if (hasFlag(rest, "--json") || hasFlag(target ? [target] : [], "--json")) {
            console.log(JSON.stringify(status, null, 2))
        } else {
            printStatus(status)
        }
        return 0
    }
    if (sub === "install" && target === "opencode") {
        const scriptArgs = ["scripts/install.mjs"]
        if (hasFlag(rest, "--offline")) scriptArgs.push("--offline")
        return runInstallScript(scriptArgs)
    }
    if (sub === "remove" && target === "opencode") {
        return runInstallScript(["scripts/install.mjs", "--uninstall"])
    }
    console.error(`unknown plugin command: plugin ${args.join(" ").trim()}`)
    console.error()
    console.error(HELP)
    return 2
}

function cmdMemory(args: string[]): number {
    const [sub, ...rest] = args
    if (sub === "list") {
        const dataDir = memoryDataDir()
        const projects = listMemoryProjects(dataDir)
        if (hasFlag(rest, "--json")) {
            console.log(JSON.stringify({ dataDir, projects }, null, 2))
        } else {
            console.log(`data dir: ${dataDir}`)
            if (projects.length === 0) {
                console.log("(no memory projects)")
            } else {
                for (const p of projects) {
                    console.log(
                        `${p.projectId}  nodes=${p.nodes}  sessions=${p.sessions}` +
                            `  updated=${p.lastUpdated ?? "-"}  root=${p.rootPath ?? "-"}`,
                    )
                }
            }
        }
        return 0
    }
    if (sub === "export") {
        const projectId = rest.find((a) => !a.startsWith("--"))
        if (!projectId) {
            console.error("usage: dreamrsimem memory export <projectId>")
            return 2
        }
        const markdown = exportProjectMarkdown(memoryDataDir(), projectId)
        if (markdown === null) {
            console.error(`project not found: ${projectId}`)
            return 1
        }
        process.stdout.write(markdown)
        return 0
    }
    console.error(`unknown memory command: memory ${args.join(" ").trim()}`)
    console.error()
    console.error(HELP)
    return 2
}

/** spawn scripts/install.mjs，继承 stdio，透传退出码。 */
function runInstallScript(scriptArgs: string[]): number {
    const script = resolve(PACKAGE_ROOT, scriptArgs[0])
    if (!existsSync(script)) {
        console.error(`install script not found: ${script}`)
        return 1
    }
    const result = spawnSync(process.execPath, [script, ...scriptArgs.slice(1)], {
        stdio: "inherit",
        cwd: PACKAGE_ROOT,
    })
    if (result.error) {
        console.error(`failed to run ${script}: ${result.error.message}`)
        return 1
    }
    return result.status ?? 1
}

/* ---------------------------------------------------------------- main */

function main(argv: string[]): number {
    const [command, ...rest] = argv
    switch (command) {
        case undefined:
            return cmdDoctor([])
        case "doctor":
            return cmdDoctor(rest)
        case "plugin":
            return cmdPlugin(rest)
        case "memory":
            return cmdMemory(rest)
        case "--version":
        case "-v":
            console.log(readPackageVersion())
            return 0
        case "--help":
        case "-h":
        case "help":
            console.log(HELP)
            return 0
        default: {
            console.error(`unknown command: ${command}`)
            console.error()
            console.error(HELP)
            return 2
        }
    }
}

process.exitCode = main(process.argv.slice(2))
