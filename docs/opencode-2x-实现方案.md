# dream-RSI-memory × opencode 集成实现方案（2.x 先行 · 1.x 对齐 · CLI）

> 目标（用户 m01133）：让 dream-RSI-memory 在 opencode 里，以与 billion-context 相同的形态安装 / 加载 / 调用；**先实现 opencode 2.x**。
> 参照系：billion-context 在本机（opencode 桌面 2.0.26）的实际用法。
> 本文只出方案，不动代码（用户 m01161「先给方案再动手」；m01173 追加 1.x 对齐与 CLI 设计）。
> 工程根：`D:\Downloads\dream-RSI-memory-2.0.0`（单层，含 `src/` `scripts/` `docs/` `test/` `index.js` `package.json` `tsconfig.json`）。
> **执行状态（v2.1.0 合并后）**：方案 Phase 0–5 已全部落地并随 `merge` 提交合入 `master`。
> **命名更正**：本文早期章节写的「插件 id 仍 `dream-memory`、数据目录仍 `…/plugin/dream-memory/`」已被发布口径推翻——v2.1.0 合并采纳远端 v2.0.1 更名，**id / 工具名 / 输出前缀 / 配置文件 / 数据目录统一为 `dream-rsi-memory`（`dream_rsi_memory_*`）**，旧名自动迁移（见 `CHANGELOG.md` v2.0.1 条目）；以 CHANGELOG 为准。

---

## 0. 结论先行

**2.0.0 在 opencode 2.x 的「能否被加载」这条链路上已经是正确的。**
它已经采用 opencode 2.x 唯一的目录解析机制：仓库根 `index.js` shim（`export { default } from "./dist/index.js"`），安装为
`~/.cache/opencode/packages/dream-rsi-memory@latest/` 下的**绝对目录条目**，并识别 `plugin` / `plugins` 两个键。

> opencode 2.x 解析插件目录时只试 `<dir>/server.*` 和 `<dir>/index.*`，**从不读 `package.json main`**（见 `scripts/install.mjs:69-86` 注释）。2.0.0 已对这个事实做了正确处理。

真正的差距是 **打包 / 入口 / 安装口径 / 调用方式**（D1–D4），都不影响「能否加载」。

**架构层面不建议照搬 billion-context 的「插件薄壳 + 独立长驻进程」**：billion 必须坐在模型请求路径上（改写 URL 做历史压缩），才需要独立代理进程；dream 是纯插件能力（工具 + 系统提示注入 + 回合菜单 + idle 归档），天然就是插件本体。照搬只会引入进程管理、健康探活、幻觉风险，无收益。

---

## 1. 参照系：billion-context 的 opencode 用法

| 维度 | billion-context |
|---|---|
| 入口文件 | `dist/agent/opencode-native.js` |
| 默认导出 | `{ id: "billion-context-opencode-native", setup, server }`（`src/agent/opencode-native.ts:777`）|
| V2（2.x） | `setup = createOpencodeV2Setup(...)`，返回 `(ctx) => Promise<() => void>`（`src/agent/opencode-v2.ts:254`）|
| V2 钩子 | `ctx.session.hook("http.request")`、`ctx.tool.transform(editor => editor.add({...}))`、`ctx.command.transform`、`experimental.ws.handshake` |
| V1（1.x） | `server(ctx)` 返回 `hooks.config` / `hooks["chat.headers"]` / `hooks.tool` / `hooks["command.execute.before"]`（`src/agent/opencode-native.ts:731` → `createV1ServerHooks` `:576`）|
| `package.json` exports | `"."`、`"./server"`、`"./dsh"`、`"./client"` |
| 安装脚本 | `src/plugin-install.ts:1219 opencodeInstall()` |
| 配置写法 | 1.x → `plugin` 键，2.x → `plugins` 键（`pickPluginKey(detectOpencodeMajor())`）|
| CLI | bin `bili` / `bili-proxy` → `dist/index.js`；命令面见 `src/cli.ts:41-153` |
| 本机实际 | `plugin: ["C:/Users/fbc/.cache/opencode/packages/billion-context@latest"]`；scope 根 `index.js` 再导出 dist 入口 |

---

## 2. 现状：dream-RSI-memory 2.0.0

| 维度 | 现状 |
|---|---|
| 入口文件 | `dist/index.js`（根 `index.js` 为其 shim）|
| 默认导出 | `{ id: "dream-memory", async setup(ctx) }`（`src/index.ts:57-217`）|
| 2.x 注册面 | `ctx.tool.transform`（6 工具）、`ctx.tool.hook("execute.before")`、`ctx.command.transform`（`/dream`、`/memory`）、`ctx.session.hook("context")`（系统提示 + 回合菜单注入）、`ctx.event.subscribe`（`session.idle` 自动归档）|
| 兼容层 | `src/lib/v2-compat.ts` 把 V2 ctx 包成 V1 形状 client；`src/lib/v2-types.ts` 手写窄类型 |
| `exports` | 只有 `"."` |
| 安装 | `scripts/install.mjs`：scope 根放 placeholder manifest，插件埋在 `node_modules/dream-rsi-memory/` |
| 数据 | `$XDG_DATA_HOME|~/.local/share/opencode/storage/plugin/dream-memory/<projectId>/`（index.json + sessions/*.json）|
| 调用方式 | npm script `install:opencode` |
| V1 | 不支持（2.0.0 破坏性移除 1.x）|

---

## 3. 差距清单

| # | 维度 | billion | dream 2.0.0 | 影响加载 |
|---|---|---|---|---|
| D1 | 默认导出 | `{ id, setup, server }` | `{ id, setup }` | 否（2.x 只用 setup）|
| D2 | `exports` | `"."` + `"./server"` | 只有 `"."` | 否（目录形态不经过 exports）|
| D3 | 安装布局 | scope 根即插件目录 | 插件埋 `node_modules/<name>/` | 否，口径不同 |
| D4 | 调用方式 | CLI `bili plugin install opencode` | npm script | 否 |
| D5 | 架构 | 薄壳 + 独立代理 | 全部在插件进程内 | **不照搬** |
| D6 | `compaction.auto=false` | 需要 | 不需要 | 否 |
| D7 | V1（1.x）支持 | 有 `server` | 无 | 否（1.x 加载用 `.server`/`index`）|

---

## 4. 分阶段实现（2.x）

### Phase 0 — 基线诊断（必须先做）

目的：确定「之前插件不行」的真因，是**加载失败**还是**加载成功但工具/命令不可用**。

步骤：
1. `npm run build`（= clean + tsc），确认 `dist/index.js` 存在且含 magic string `dream-rsi-memory`。
2. `node scripts/install.mjs`，确认输出 `scope ready → ...\dream-rsi-memory@latest` 且 smoke ok。
3. 检查 `~/.config/opencode/opencode.json` 是否写入 `plugins: [".../dream-rsi-memory@latest"]`（scope 根即插件目录，无嵌套层）。
4. **完全退出并重启** opencode 2.0.26（插件目录型条目只在启动时加载）。
5. 看启动日志是否出现插件 ready；在 2.x 会话里试 `/dream status`、调 `dream_rsi_memory_status`。

产出：加载日志 + 一次工具/命令实测。**若此步已全绿，则 Phase 1/2 只是口径对齐，不是修 bug。**

### Phase 1 — 入口 / 导出对齐（代码）

1. `package.json` 的 `exports` 增补 `./server`：
   ```json
   "exports": {
     ".": { "import": "./dist/index.js" },
     "./server": { "import": "./dist/index.js" }
   }
   ```
   作用：为「npm 包名形态」铺路（billion 靠 `exports["./server"]` 让 opencode 从裸名解析到插件入口）；目录形态不受影响。
2. `src/index.ts:57` 默认导出改为与 billion 同构：
   ```ts
   export default { id: "dream-memory", setup, server };
   ```
   - `setup`：沿用现有实现（2.x）。
   - `server`：V1 入口，见 §8。若本阶段不做 1.x，则保持 `{ id, setup }`，只做 D2。
3. 根 `index.js` shim 保持不变。

### Phase 2 — 安装布局对齐（脚本）

**前提修正（2026-10-10 实测）**：原设想「dream 零 runtime 依赖、`@opencode-ai/plugin` 由 opencode 注入」**不成立**——opencode loader 是纯 `await import(entry)`，无 alias/注入；而 `dist/lib/tools.js:1`、`dist/lib/v2-compat.js:17` 是对该 SDK 的值导入（`tool.schema` 即 zod 的 `z`，SDK 自身还需 zod）。机器缓存根 `~/.cache/opencode/node_modules/@opencode-ai/plugin` 虽存在，但是 v1.1.47 且 `dist/index.js` 为无扩展名 `export * from "./tool";`（Node 必挂，仅 Bun 容忍），不可依赖。故布局改为**scope 根铺平 + 最小 `node_modules`（仅 `@opencode-ai/plugin@1.18.31` + `zod`）**，与 opencode-acp 等已装插件通行做法一致，纯 Node smoke 可真实验证。对齐成与 billion 相同的「scope 根即插件目录」：

1. `scripts/install.mjs:84-86` `pluginEntrySpec()` 由 `NM_DM` 改为返回 `SCOPE_DIR`（反斜杠转正斜杠）。
2. `installStagingInPlace()`（`scripts/install.mjs:609`）改为把 `index.js` + `package.json` + `dist/` 直接铺在 `SCOPE_DIR` 根。
3. `verifyInstall()` 的导入路径由 `<NM_DM>/index.js` 改为 `<SCOPE_DIR>/index.js`。
4. 离线包（`makeOfflinePackage` / `offlinePs1` / `offlineSh`，`scripts/install.mjs:251-520`）同步改布局与校验路径。

> 备选：**保持现有嵌套布局不动**。它同样能被 2.x 加载，只是与 billion 不同形。若「同样方式」只指入口/导出，Phase 2 可跳过（见 §6 决策点 B）。

### Phase 3 — 验收（必须实测，不接受仅单测）

| 项 | 命令 / 观察 | 期望 |
|---|---|---|
| 类型 | `npm run typecheck` | EXIT 0 |
| 单测 | `npm test` | 全绿（现 63 个）|
| 构建 | `npm run build` | EXIT 0，`dist/index.js` 更新 |
| 安装 | `node scripts/install.mjs` | scope ready + smoke ok |
| 配置 | 检查 `opencode.json` | `plugins` 条目指向新路径 |
| 加载 | 重启 opencode 2.0.26 后看日志 | 插件 ready，无 load error |
| 命令 | `/dream status`、`/memory stats` | 返回中文简报，无 500 |
| 工具 | 会话内 tools/list | 6 工具（commit/search/node/status/policy/dream）可见 |
| 注入 | 新会话系统提示 / 回合菜单 | 见 dream 菜单注入 |
| 归档 | 会话 idle | 自动归档被触发 |

---

## 5. 建议的实施顺序

```
Phase 0（诊断，无需改码）
   └─ 若全绿 → Phase 1（导出 ./server）→ Phase 3 验收
   └─ 若可加载但不工作 → 先修该问题，再走 Phase 1/2
Phase 2（安装布局对齐）按 §6 决策点 B 决定是否做
Phase 4（1.x 对齐）见 §8 —— 2.x 验收全绿后再做
Phase 5（CLI）见 §9 —— 最后做，先做 doctor 子集
```

---

## 6. 需要你拍板的决策点

**A. V1（opencode 1.x）现在做还是只留骨架？**
- A1：现在只做 2.x，默认导出保持 `{ id, setup }`，`server` 留到 Phase 4。
- A2：现在就加 `server` 骨架（`server(_ctx){ return {} }`），入口形状与 billion 一致，但 1.x 实际不可用。
- A3（推荐，若你确认 1.x 也要用）：按 §8 直接做可用的 1.x。

**B. 安装布局要不要对齐成「scope 根即插件目录」？**
- B1（推荐）：对齐（Phase 2）。与 billion 同形，去掉「插件埋在 `node_modules/<name>/`」的嵌套层；因 SDK 值导入（见前提修正），scope 根带最小 `node_modules`（`@opencode-ai/plugin` + `zod` 两包），不再 vendor 整个闭包。
- B2：保持现有嵌套布局，只做 Phase 1。

**C. 调用方式要不要做成 `bili` 式 CLI？**
- C1：沿用 npm script（`npm run install:opencode`）。
- C2（推荐）：新增 bin `dreamrsimem`，做**安装/诊断子集**（`plugin install|remove|status` + `doctor` + `--version/--help`），详见 §9。
- C3：完整对齐 billion 的 CLI 面（含启动器 / export / acp-cache）——**不建议**，dream 没有代理与压缩会话，这些子命令无对应物。

**D. 是否需要在安装时也写 `compaction.auto`？**
- 结论：**不需要**。dream 不参与上下文压缩，不存在「双压缩主」问题。

---

## 7. 风险与注意

- **重启才生效**：opencode 在启动时加载插件目录条目；改完必须完全退出再启动。
- **`removeConfigPlugin` 正则过宽**：`scripts/install.mjs` 用 `/"[^"]*dream-rsi-memory[^"]*"/` 全文删除，若配置里其它条目含同名字符串会被误删（对齐布局时一并收窄）。
- **Bun vs Node 解析差异**：opencode 用 Bun 的 `resolveSync`；smoke 测试用 node import，只能验证导出形状，不能替代真实加载验证。
- **工程根路径**：实际为单层 `D:\Downloads\dream-RSI-memory-2.0.0`（此前的「双层嵌套」记录有误，已更正）。

---

## 8. 1.x（opencode 1.x）对齐设计

### 8.1 思路

billion 的双入口 = `{ id, setup, server }`：2.x 调 `setup()`，1.x 调 `server(ctx)`（`src/agent/opencode-native.ts:731`）。dream 支持 1.x 的方式就是给 `src/index.ts` 加一个 `server` 导出，把 2.0.0 的 V2 注册面**逐一映射到 V1 hooks**。

**核心库零改动**：`store` / `tools` / `hooks` / `menu` / `dream` / `meta-llm` / `scoring` / `prompt` 全部宿主无关，1.x 与 2.x 共用；只新增一个 V1 宿主适配层。

### 8.2 API 映射表（V2 → V1）

| dream 能力 | 2.x API（现状） | 1.x 等价物 | 说明 |
|---|---|---|---|
| 6 工具 | `ctx.tool.transform(editor => editor.add(...))` | `hooks.tool = { [name]: { description, args, execute } }` | V1 宿主在启动时**静态**读 hooks.tool，一个名字进程内只有一个定义 |
| 工具执行前 | `ctx.tool.hook("execute.before")` | `hooks["tool.execute.before"]` | |
| 命令 `/dream`、`/memory` | `ctx.command.transform(editor.add(...))` | **不能用 `command.execute.before`**（其抛错会让命令 HTTP 500）；改为在 `hooks.config` 注册**非空命令模板** | 2.1.0 实测：空模板 + `command.execute.before` 抛错→500；非空模板方案 EXIT 0 |
| 系统提示注入 | `ctx.session.hook("context")` → push `event.system` | `experimental.chat.system.transform` | 逐个往 system parts push text |
| 消息注入（回合菜单） | 同上 → push `event.messages[i].content` | `experimental.chat.messages.transform` | |
| `session.idle` 自动归档 | `ctx.event.subscribe` | `hooks.event` | 载荷形状不同，需归一 |
| 会话域（读历史 / 建会话 / 隐藏 curator 会话） | `ctx.session.context/create/remove/synthetic` | V1 `client`：`client.session.messages` / `create` / `delete` / `prompt({ noReply: true })` | |
| 项目根 / 工作目录 | `ctx.directory` / `ctx.worktree` | `ctx.directory` / `ctx.worktree` | 同名 |
| 工具 schema | `tool.schema`（`@opencode-ai/plugin`） | 同（V1 也是这张 zod 表） | |

### 8.3 交付物

1. **新文件** `src/lib/v1-host.ts`：`export function createV1Hooks(ctx): V1Hooks` —— 组装上表所有 hook；事件/消息载荷做 V2 形状归一，让 `src/lib/hooks.ts` 与 `src/lib/menu.ts` 无需分支。
2. **`src/index.ts`**：默认导出 `{ id: "dream-memory", setup, server }`，`server = createV1Hooks`。
3. **`src/lib/v2-compat.ts` 不动**（它只服务 `setup`）。
4. **命令模板**：在 `v1-host.ts` 内定义 `DREAM_COMMAND_TEMPLATE`（无参 / `status` → `dream_rsi_memory_status`；`run` → `dream_rsi_memory_dream`）与 `MEMORY_COMMAND_TEMPLATE`（`stats` → status；`policy [id]` → policy；`show <nodeId>` → node），经 `hooks.config` 注册；模板要求模型先调对应工具再输出中文简报。
5. **测试** `test/v1-host.test.mjs`：假 V1 宿主 `fakeV1Host(directory)`，断言 `hooks.tool` 键集 = 6 工具、`hooks.config` 注册了 `dream`/`memory` 且模板长度 > 0、`event` / `tool.execute.before` / `experimental.chat.system.transform` / `experimental.chat.messages.transform` 均为 function、`hooks["command.execute.before"] === undefined`。

### 8.4 降级与风险

- **可选链 inert-safe**：1.x 宿主缺某个 seam 时只关掉该能力，其余照常；插件绝不因缺 seam 抛错。
- **工具定义必须真实**：V1 宿主静态加载工具定义，`args` 直接给 `definition.args`（真实 zod 表），不要包一层（否则 args 解析失效）。
- **`command.execute.before` 禁用**：仅注册模板，不挂该 hook（2.1.0 的 500 根因）。
- **`experimental.primary_tools` 无等价物**：不需要。
  - **2026-10 更正（见 CHANGELOG Unreleased）**：V2 下存在等价物——注册时
    `options: { codemode: false }` 可让工具留在宿主顶层工具表，否则缺省折进
    Code Mode catalog（只能经 `execute` 间接调用）。
- **双版本共存**：V1 与 V2 可同时存在于同一入口对象；opencode 按版本各取所需，数据目录共用。

---

## 9. `bili` 式 CLI 设计

### 9.1 参照：billion 的 CLI 面

`package.json bin: { bili, bili-proxy } → dist/index.js`；命令定义在 `src/cli.ts:41-153`（HELP）：

```
bili [start]                     启动代理
bili <client>                    代理 + 启动某客户端（cert-MITM / /bili/ 重写）
bili export [id] [--full]        导出持久化会话
bili acp-cache diff <dir>        离线前缀差分归因
bili update                      检查并安装新版本
bili doctor                      审计所有安装 lane（版本 / 归属 / 新鲜度 / 进程）
bili plugin install <agent>      --with-mcp（仅 opencode）附带 mcp.bili
bili plugin remove <agent>
bili plugin update [agent]
bili plugin list
bili mcp                         独立运行 MCP stdio 服务器
bili plugin-register <id>        预绑定会话到插件模式
```

### 9.2 dream 的 CLI 子集（去掉代理/启动器/压缩会话）

dream 没有代理，也没有被压缩的会话，因此**只保留与「装/卸/诊」相关的子命令**：

```
dreamrsimem                             默认 = doctor
dreamrsimem doctor                      体检：构建产物 / scope / 配置条目 / 数据目录 / opencode 版本 / 进程
dreamrsimem plugin install opencode     装（= 现 scripts/install.mjs 联网路径）
    --offline                               离线
    --scope                                 强制 scope 目录形态（默认，2.x）
    --dev                                   指向当前 checkout（开发用）
dreamrsimem plugin remove opencode      卸载（配置条目 + scope）
dreamrsimem plugin status               安装状态 + 磁盘版本 + 配置条目 + 是否已被加载
dreamrsimem memory list                 列出记忆库项目 / 节点（可选）
dreamrsimem memory export <id>          导出为 Markdown（可选）
dreamrsimem --version / --help
```

**明确不做**（无对应物）：`start` / `<client>` 启动器 / `export`（压缩会话）/ `acp-cache diff` / `plugin update`（billion #991 的 owner lane）/ `plugin-register`。

### 9.3 实现路径

1. `package.json` 增 `bin: { "dreamrsimem": "./dist/cli.js" }`；构建增加 `src/cli.ts` → `dist/cli.js`。
2. 把 `scripts/install.mjs` 的安装逻辑抽成 `src/lib/opencode-install.ts`（typed；导出 `installOpenCode` / `removeOpenCode` / `statusOpenCode` / `doctorOpenCode`）。
3. `scripts/install.mjs` 变薄包装（保持 `npm run install:opencode` 兼容），CLI 与脚本共用同一实现，避免路径规则漂移。
4. CLI 与插件共用 `resolveConfig`（`src/lib/config.ts`）与数据目录解析。
5. `doctor` 输出人类可读表格 + `--json`（对齐 billion 的 `doctor`），能一眼看出「scope 在不在、配置条目指哪、版本对不对、有没有在跑」。

### 9.4 建议

**建议做 C2（安装/诊断子集），不做 C3。** 理由：
- 用户感知的「与 billion 一样」主要就是 `plugin install opencode` 这一条；
- `doctor` 是排查「插件静默死亡」的关键工具（billion 的 `doctor` 正是为此而设），dream 目前缺它，每次都要手工查 scope/配置；
- 启动器 / export / acp-cache 依赖代理或压缩会话，dream 无对应物，做了是负担。

---

## 10. 建议汇总（待你确认）

- **A**：先只做 2.x（A1）；若确认 1.x 也要用则做 A3（§8）。
- **B**：对齐成「scope 根即插件目录」（B1，§4 Phase 2）。
- **C**：加 `dreamrsimem` CLI 的安装/诊断子集（C2，§9）。
- **D**：不写 `compaction.auto`。
