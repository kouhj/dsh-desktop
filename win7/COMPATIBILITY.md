# Windows 7 SP1 兼容构建说明

本分支 `win7-sp1` 为 **Windows 7 SP1** 目标提供可构建、可验证的安装产物，并记录当前架构下无法在 Win7 上运行的部分。

> 一句话结论：**能构建出 Win7 目标的安装包（Electron 22.3.27 + Chromium 108 渲染层降级 + 自包含离线 runtime），已修复所有 Electron 侧的 Win10+ 依赖；但 DSH 运行时本身要求 Node ≥ 24.9 / Chromium 侧 ESM 主进程，Electron 22 无法承载，完整功能在 Win7 上不可运行。** 证据与路线见下文。

## 1. 版本矩阵

| 组件 | 主线（Win10+） | 本分支（Win7 SP1） | 依据 |
| --- | --- | --- | --- |
| Electron | 44.7.0（Chromium ~140 / Node 22） | **22.3.27**（Chromium 108.0.5359.215 / Node 16.17.1） | [Electron 官方弃用公告](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice)：23+ 不支持 Win7/8/8.1 |
| Renderer 构建目标 | `es2022` / Vite 默认 | `chrome108` + `esbuild` 目标同步 | `dsh-plugin-desktop/vite.client.config.ts`、`vite.native-ui.config.ts` |
| 主进程产物 | ESM | **仍为 ESM**（未改，见 §4 阻断 1） | `tsdown.config.ts: format 'esm'` |
| 内置 pnpm | 11.28.5（要求 Node ≥22.13） | 未替换（见 §4 阻断 2） | pnpm 11 engines |
| 随包 runtime | Node 24.21.0 + Python 3.12 | 未替换（Win7 无法运行 Node 18+ 官方二进制） | `deepseek-harness/scripts/primary-runtime/lock.json` |

## 2. 本分支已完成的修复（Electron 44 → 22）

| 修复 | 位置 | 说明 |
| --- | --- | --- |
| `WebContentsView` / `window.contentView`（Electron 30+）→ `BrowserView` 双实现 | `src/electron-view.ts`、`src/compatibility-shell.ts` | 运行时探测 `WebContentsView`，Electron 22 走 `BrowserView` + `addBrowserView`/`setTopBrowserView`，层级、透明、销毁语义对齐 |
| `net.fetch` / `session.fetch`（Electron 25+）→ `net.request` 适配层 | `src/electron-compat.ts`、`src/electron-runtime.ts`、`src/electron-shell-generation.ts` | 保留 Cookie、重定向、abort、session 绑定、代理栈；返回 fetch 形状的缓冲响应 |
| `webUtils.getPathForFile`（Electron 32+）→ `File.path` 回退 | `src/preload.ts` | 沙箱 preload 不引入 Node 内置模块 |
| `safeStorage.getSelectedStorageBackend`（>22）守卫 | `src/main.ts`、`src/electron-compat.ts` | 22 返回 `unknown`，避免 CA 私钥保护逻辑抛错 |
| `WebFrameMain.detached`（>22）守卫 | `src/electron-shell-generation.ts` | 22 视为未分离 |
| `will-frame-navigate`（>22）→ `will-navigate` 回退 | `src/electron-shell-generation.ts` | 22 上仅主 frame 导航守卫生效 |
| `module.registerHooks`（Node 22.15+）运行时探测 | `src/module-resolution.ts` | Node 16 保留 CJS `_resolveFilename` 覆盖；ESM 解析降级（见 §4） |
| `import.meta.resolve`（Node 20.6+）兼容助手 | `src/electron-compat.ts` + 4 个调用点 | Node 16 经 `createRequire().resolve` → 文件 URL |
| `MessageBox` / `console-message` / `Event` 泛型的 Electron 22 类型差异 | `src/desktop-dialog-window.ts`、`src/renderer-logging.ts` | 22 的 `console-message` 仍是位置参数（legacy） |
| 打包 fuse 配置 | `dsh-plugin-desktop/package.json` | 删除 Electron 22 不存在的 `resetAdHocDarwinSignature`；保留 `runAsNode`（必需） |
| Electron peer 版本 | `dsh-plugin-desktop/package.json` | `peerDependencies.electron = 22.3.27` |
| Chromium 108 CSS 降级 | `scripts/win7/css-compat.mjs`、`vite.client.config.ts`、`vite.native-ui.config.ts` | 展开 `@scope`（Chrome 118+）、`oklch()`（111+）转 sRGB、`color-mix()`（111+）插入静态回退声明 |
| Chromium 108 启动 polyfill | `src/win7-boot-polyfills.ts`、`src/index.ts` | `Promise.withResolvers`(119)、`AbortSignal.any`(116)/`timeout`、`toSorted/toReversed/toSpliced/with`(110)、`Object/Map.groupBy`(117)、`Array.fromAsync`(121)、`Set` 方法(122)、`String.isWellFormed`(111) 以内联 head script 在应用模块之前注入 |
| 打包期 runtime smoke 跳过开关 | `scripts/verify-packaged-runtime.ts`、`.github/workflows/win7-build.yml` | `DSH_WIN7_COMPAT=1` 时跳过的只是“在 Electron 22 内执行 Node 24 runtime”的 smoke，结构校验仍执行 |
| Win7 产物静态闸门 | `scripts/win7/verify-win7-artifacts.mjs` | PE 子系统 ≤6.1、Electron 22.3.27、离线 runtime 在包内、无 `@scope`/`oklch()`、每个 `color-mix()` 有静态回退 |

## 3. 构建与离线说明

- CI：`.github/workflows/win7-build.yml`，`windows-2022`（固定，不用 `windows-latest`，后者已是 Server 2025），Node 22.23.2 仅作构建宿主。
- 产物：`DSH-Desktop-<version>-x64-Setup.exe`（NSIS）、`DSH-Desktop-<version>-x64-Portable.zip`、`win7-verification.json`。
- 离线自包含：安装包内包含 `resources/runtime/x64/primary-runtime`（Node + Python + office 库），安装后无需联网下载；但主进程仍会在启动时做更新检查（静默失败）。
- 构建期网络：Electron 22 zip、electron-builder 的 NSIS/winCodeSign、primary runtime 下载都走 `actions/cache` 预热（见 workflow 的 `Restore packaging downloads`）；离线 runner 复跑需要预先填充这些缓存目录。
- 本地构建离线化：把上述缓存目录拷贝到对应位置后，`yarn install --immutable` + `yarn workspace dsh-plugin-desktop dist:win` 可在无外网环境完成（Yarn 4 需 `YARN_ENABLE_NETWORK=0` 且本地缓存完整）。

## 4. 架构级阻断（无法在 Win7 上运行完整功能的原因）

1. **Electron 22 不支持主进程 ESM。** 桌面主进程产物是 ESM（`"type": "module"`、`"main": "lib/main.js"`、tsdown `format: 'esm'`），Electron 主进程 ESM 支持从 Electron 28 才开始。产物在 Win7 上启动即失败。要解决必须把主进程切到 CJS 并处理所有 ESM-only 依赖与动态 Loader（审计估算 20+ 文件、6–7 人日，且未含渲染/上游）。
2. **DSH Host 要求 Node ≥ 24.9，而它跑在 Electron 自带的 Node 里。** Host 由 `utilityProcess.fork(host-process-entry.js)` 启动（`src/host-process.ts`），即 Electron 22 的 Node 16.17；haul 代码使用 `node:sqlite`（10 个文件）、`import.meta.dirname`（227 处）、`node:sea`、`import.meta.main`，Node 16 无法加载。把 primary runtime 的 Node 24 换成 Node 16 也救不了：那套 Node 只服务 office skills，不参与 Host/pnpm（`.win7/audit-runtime-offline.md`）。
3. **内置 pnpm 11.28.5 要求 Node ≥22.13**，通过 `ELECTRON_RUN_AS_NODE` 在 Electron 22 的 Node 16 里执行 `pnpm.mjs`，必然失败；降 pnpm 到 8.15.9 也需重打 200+ vendored tarball 与 lockfile，且 Host 本身仍是阻断。
4. 其他降级项（不致命但影响体验）：node-pty 1.2 在 Windows 仅 ConPTY（Win10 1809+），Win7 内嵌终端不可用；Tailwind 4 基线 Chrome 111，`color-mix()` 只能做静态回退，部分半透明层次会与设计稿有差异；上游预构建 `@deepseek-ai/dsh-web-frontend` 的 CSS/JS 不受本仓库构建控制。

完整审计证据（含逐条 file:line、P0/P1/P2 清单）：
- `win7/evidence/audit-electron22.md`（主进程/Node 侧，21 条 P0）
- `win7/evidence/audit-renderer108.md`（渲染层/Chromium 108，6 条 P0）
- `win7/evidence/audit-runtime-offline.md`（runtime/离线链路）

## 5. 可行路线（按成本排序）

- **A′（本分支现状）**：Win7 目标安装包 + 静态验证；壳不能启动，作为发布前的打包/兼容性原型与后续移植基线。
- **C（推荐，保功能）**：Win7 上只跑“薄壳 + Web 客户端”，DSH Host 跑在局域网/内网的 Win10+/Linux 机器，复用现有 LAN HTTPS 与 remote access 能力；审计估算 2–4 人周。
- **B（全量本地化，成本最高）**：主进程 ESM→CJS + Node 16 适配（6–7 人日），再把 Host 改成本地独立进程并移植 harness 到 Node 16/兼容层（node:sqlite 替换、200+ tarball 重打、每轮上游升级重做）；不建议。
- **上游路线**：向 anywhere-labs/deepseek-harness 提议官方 Win7 兼容档（如提供 Node 16/18 的 harness 构建目标），从根上消除阻断 1/2/3。

## 6. 验证记录

- 本地（Linux，Node 22.23.2）：`yarn workspace dsh-plugin-desktop build` 通过；产物扫描 `@scope`=0、`oklch(`=0、`color-mix()` 均带静态回退。
- 构建成功 run（分支推送）：<https://github.com/kouhj/dsh-desktop/actions/runs/41444207411>
- 发布 run 与产物（tag `win7-v2.0.18`）：<https://github.com/kouhj/dsh-desktop/releases/tag/win7-v2.0.18>
  - `DSH-Desktop-2.0.18-x64-Setup.exe`（NSIS 安装包，含离线 runtime）
  - `DSH-Desktop-2.0.18-x64-Portable.zip`
  - `win7-verification.json`（12 项产物闸门全部 PASS：PE 子系统 5.2、Electron 22.3.x 资源串、离线 runtime、CSS 降级、boot polyfill）
