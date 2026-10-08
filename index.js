// opencode 2.x 用 Bun.resolveSync 只试 `<目录>/server.*` 和 `<目录>/index.*`，
// 不读 package.json 的 main（core 的 r0({directory}) 解析）。
// 这个 shim 让包根目录本身可以直接作为配置里的插件条目（本地开发指向仓库根，
// scripts/install.mjs 安装后指向 scope 目录）。
export { default } from "./dist/index.js"
