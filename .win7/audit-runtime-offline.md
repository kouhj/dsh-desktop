# DSH Desktop × Windows 7 SP1：运行期组件链 / 联网点 / 离线自包含 审计

- 审计人：runtime-offline-auditor（Team Lead: lead）
- 仓库：`/home/james/src/dsh_win7`（fork of kouhj/dsh-desktop，子模块 `deepseek-harness` pin f3803c9）
- 基线事实：工作树已有改动 `dsh-plugin-desktop/package.json`（devDependency `electron` 44.7.0 → **22.3.27**）+ `yarn.lock`。本审计**不改源码**，只写 `.win7/`。
- 取证方式：本会话的 `read`/`glob`/`grep` 工具被映射到 Windows 锚点目录（无法访问远端仓库），全部取证改为 `pwsh --workdir C:\Users\kouhj` + `ssh router` + `cat/sed/rg/node -e` 完成；行号均来自远端实际文件。
- 版本事实（已核对 release 页）：Electron **44.7.0 → Chromium 152 / Node 24.21.0**；Electron **22.3.27 → Chromium 108.0.5359.215 / Node 16.17.1**（<https://releases.electronjs.org/release/v44.7.0>、<https://releases.electronjs.org/release/v22.3.27>）。

---

## 0. 结论速览（TL;DR）

1. **运行期只有一个 JS 引擎**：`dsh-plugin-desktop` 的 Electron 主进程用 `utilityProcess.fork()` 启动 DSH Host，**Host 跑在 Electron 自带的 Node 里**；`dsh` CLI、`pnpm`、所有包操作也都是“同一个 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1`”。真正的独立 `node.exe`（primary-runtime 的 Node 24.21.0）**只**服务于 Office skills 与 workspace 依赖工具。
2. 因此 Win7 的硬约束不是“选哪个 node 可执行文件”，而是**“哪个 Electron”**：Electron 22.3.27 是最后支持 Win7 的版本，它只带 Node **16.17.1**；而 harness 声明并要求 Node **≥24.9.0**（`engines`、`.agents/notes/.../2026-10-15-node-24-runtime-floor.md`），且代码里大量使用 Node 20+/22+ 才有的 API（`import.meta.dirname` 227 处、`node:sqlite` 10 个文件、`node:sea`、`import.meta.main`）。
3. **于是“只把 electron 降到 22.3.27”在当前工作树里是一个必然崩溃的中间状态**：连壳自己的 `lib/` 也在 Node 16 上跑不起来（`import.meta.resolve` 4 处、`structuredClone` 8 处、`AbortSignal.timeout` 1 处）。这条必须让 Lead 明确处理。
4. 方案 B（Win7 可用 runtime：Node 16.20.2 + pnpm 8.15.9 + 去 office）**不现实**：它不是“换解释器 + 换 pnpm”，而是把 58 个包的 harness 降级到 Node 16（持久层重写 + 全仓 API 改写 + 全部 lockfile/vendored tarball 重建 + 每次上游升级重做）。见 §4。
5. 可行路线只有两条：**A′ 窄壳**（Electron 22 只画窗口，Agent 运行时明确不可用 / 或干脆不发布 Win7 版 Agent 能力）与 **C 远程前端**（Win7 壳 + 远端 Win10+ Host，中等改造，唯一“保功能”路线）。
6. 离线自包含**构建期**完全可做（下载点少且都有 sha256 锁/缓存目录）；**运行期**离线也基本成立（更新检查静默失败、market 默认 disabled、telemetry 默认已关），真正需要“联网才有意义”的只有模型 API / 账号登录 / 插件安装。

---

## 1. 运行期组件链

### 1.1 总图（打包后形态）

```
DSH Desktop.exe  (= Electron 44.7.0 / Node 24.21.0；Win7 分支改为 22.3.27 / Node 16.17.1)
└─ <resources>/app/lib/main.js                         Electron main（tsdown target es2024）
   ├─ installDesktopPnpmRuntime()            主进程自带 pnpm 命令环境（generations/<sha256>-<uuid>/bin/pnpm.cmd）
   │   pnpm.cmd ─► "<app exe>" --require <private>/clear-env.cjs <app>/node_modules/pnpm/bin/pnpm.mjs
   │               env: ELECTRON_RUN_AS_NODE=1
   │                    npm_config_runtime=electron
   │                    npm_config_target=<electron version>
   │                    npm_config_disturl=https://electronjs.org/headers
   ├─ installDesktopDshRuntime()             Windows 才装：dsh.cmd ─► "<app exe>" --expose-internals <app>/lib/desktop-cli.js
   │                                          env: ELECTRON_RUN_AS_NODE=1, DSH_DESKTOP_DEFAULT_PROFILE, DSH_HOME
   └─ startIsolatedDesktopHost()             utilityProcess.fork(<app>/lib/host-process-entry.js)   ← DSH Host 本体
        └─ bootDesktopHost()                host-bootstrap.ts:135 → @deepseek-ai/dsh-app-boot 的 boot()
             ├─ Cordis profile loader（profile-context.ts，注入 packageManager = Electron+pnpm）
             ├─ desktop-pnpm 服务            pnpm.ts:206 ctx.subprocess.spawn(spec)（argv[0] = appExecutable）
             ├─ desktop-office               desktop-office.ts → skill-office + tool-workspace-dependencies
             │    └─ python: <runtime>/primary-runtime/dependencies/python/bin/python.exe
             │       node  : <runtime>/primary-runtime/dependencies/node/bin/node.exe
             │       cli   : @deepseek-ai/libreoffice-kit/lib/cli.js
             └─ profile 插件安装/移除        runPlugin → "<app exe>" --expose-internals lib/desktop-cli.js
                                              → @deepseek-ai/dsh/lib/bin.js（dsh CLI，ESM bundle）
```

要点：**没有任何环节调用 primary-runtime 的 Node 去跑 Harness**。`primaryRuntime` 在 `main.ts:1628` 解析后只进 `host-bootstrap.ts:63`，最终被 `resolveDesktopOfficeConfig()`（`desktop-office.ts:71`）消费。

### 1.2 逐环节事实

| 环节 | 位置 | 事实 |
|---|---|---|
| Host 启动方式 | `src/host-process.ts:49` | `utilityProcess.fork(host-process-entry.js)`，`serviceName:'DSH Host'`、`stdio:'pipe'`、`env:{...process.env}` |
| Host 进程隔离 | `src/host-process-entry.ts:18-27` | 只依赖 `process.parentPort`（Electron utilityProcess 专有），无 BrowserWindow |
| Host 组装 | `src/host-bootstrap.ts:135-315` | `boot(BIN_NAME, rootConfig, patches, …)`；挂 `desktop-office`、`DesktopPluginsService`、`desktopPnpmBootstrap` 等 |
| pnpm 执行器 | `src/pnpm.ts:153-166, 206-224` | `argv = [appExecutable, '--import', clear-env, pnpmBinPath, ...]`；env 见上；**pnpm 永远由 Electron 执行** |
| pnpm 入口定位 | `src/main.ts:801` | `packagedDependencyPath(import.meta.url,'pnpm/bin/pnpm.mjs')` → `<app>/node_modules/pnpm/bin/pnpm.mjs` |
| dsh CLI 入口 | `src/main.ts:810`、`src/desktop-cli.ts:15-17` | `lib/desktop-cli.js` → 动态 import `@deepseek-ai/dsh/lib/bin.js` |
| 命令 shim 生成 | `src/desktop-runtime-environment.ts:432-465`（`windowsPnpmShim`/`windowsDshShim`） | 纯 batch 文件，全部指向 `options.appExecutable` + `ELECTRON_RUN_AS_NODE=1` |
| primary-runtime 定位 | `src/desktop-office.ts:55-62` | packaged → `<resourcesPath>/runtime/<arch>/primary-runtime`；dev → `<pkg>/.desktop-build/runtime/<arch>/primary-runtime`；可被 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` 覆盖 |
| primary-runtime 强制 | `src/desktop-office.ts:71-78` | packaged 时 `required:true`：`runtime.json` 缺失 → 抛错，Host 启动失败 |
| office skills 资源 | `src/desktop-office.ts:85-93` | `assetRoot = <runtime 同级>/office-skills`；`node`/`cli` 绝对路径传给 `skill-office` |
| 内联 Host 逃生门 | `src/main.ts:1646` | `DSH_DESKTOP_ISOLATED_HOST=0` 时改用进程内 boot（不 fork） |
| 打包资源映射 | `package.json` → `build.win.extraResources` | `.desktop-build/runtime` → `resources/runtime`；`asar:false`；`electronFuses.runAsNode:true` |
| `ELECTRON_RUN_AS_NODE` 使用点 | `pnpm.ts:217`、`profile-context.ts:67`、`desktop-runtime-environment.ts:18/364/386/423/442/458`、`desktop-cli.ts:13`、`profile-materializer.ts:104/248`、`windows-acl-runner.ts:6`、`desktop-terminal.ts:18/423`、`recovery-plugin-uninstall.ts:87`、`main.ts:4` | 覆盖 pnpm、dsh CLI、pnpm 生命周期 node shim、插件安装、terminal、recovery |

### 1.3 profile 包管理器契约（对 pnpm 降级至关重要）

- `src/profile-context.ts:57-70`：把 `packageManager.command = appExecutable`、`args=[--import <clear-env>, pnpmBinPath, --config.minimumReleaseAge=0]`、`env` 带上 `ELECTRON_RUN_AS_NODE/npm_config_runtime/npm_config_target/npm_config_disturl` 交给 app-boot。
- `src/profile.ts:969-976`：`compatiblePnpmPackageManager()` **要求 profile 的 `packageManager` major ≥ 10**，否则触发依赖迁移（重装）。→ 降级到 pnpm 8 必须同时改这个闸门。
- `src/profile.ts:950-968`：profile 的 `pnpm-workspace.yaml` 由壳写成 `packages:['.'], nodeLinker: hoisted, autoInstallPeers: false`，并读取 `virtualStoreDirMaxLength`。
- `src/pnpm-policy.ts:7`：全局注入 `--config.minimumReleaseAge=0`（pnpm 10/11 的配置键；pnpm 8 不认识）。

---

## 2. Windows 7 运行期可行性结论表

判定口径：**“能在 Win7 SP1 x64 上解压/安装后实际跑起来”**，不是“代码里没写 Win10 API”。

| 组件 | Win7 原生可用？ | 依据 / 阻断原因 | 若不可用的替代与损失 |
|---|---|---|---|
| Electron 22.3.27（Chromium 108.0.5359.215 / 内置 Node 16.17.1） | ✅ 是（最后一个支持 Win7 的 Electron 大版本） | release 页版本表；E23 起放弃 Win7/8/8.1 | — |
| **DSH Host（`host-process-entry.js`，跑在 Electron 的 Node 里）** | ❌ **否** | harness `engines.node >= 24.9.0`（root/`apps/cli`）；`.agents/notes/implemented/process/2026-10-15-node-24-runtime-floor.md` 明确“Node 24.9 为最低”；代码用 `import.meta.dirname`（227 处）、`node:sqlite`（10 文件）、`node:sea`（`packages/skill/skill-office/src/index.ts:7`）、`import.meta.main`；tsdown/tsc `target: es2024` | 无替代：Host 的引擎被 Electron 版本钉死。见 §4 |
| `dsh` CLI（`desktop-cli.js` → `@deepseek-ai/dsh/lib/bin.js`） | ❌ 否 | 与 Host 同一份 harness 代码，同样要求 Node ≥24.9 | 无 |
| 壳自身 `app/lib/*.js`（`main.js` / `host-process-entry.js` …） | ❌ 否（当前工作树） | tsdown `target:'es2024'` + 运行期 API：`import.meta.resolve` ×4（`module-resolution.ts:21`、`desktop-office.ts:88`、`windows-acl-runner.ts:19`、`windows-pwsh-sandbox.ts:11`；Node 20.6+ 才同步可用）、`structuredClone` ×8（Node 17+）、`AbortSignal.timeout` ×1（Node 17.3+） | 需做 Win7 兼容分叉/降级编译（可行但需持续维护） |
| 内置 pnpm 11.28.5（经 `ELECTRON_RUN_AS_NODE` 用 Electron 的 Node 执行 `bin/pnpm.mjs`） | ❌ 否 | pnpm 11 engines `node >=22.13`；入口文件名 `bin/pnpm.mjs`（pnpm 10/11 布局）；`--config.minimumReleaseAge=0` 为 pnpm 10+ 配置；`pnpm-workspace.yaml` 的 `allowBuilds:` 为 pnpm 10.16+ 语法 | 降到 pnpm 8.15.9（engines ≥16.14）：需改 `bin/pnpm.cjs` 路径、去掉/降级 `minimumReleaseAge` 策略、把 profile 的 `packageManager>=10` 闸门（`profile.ts:969`）放宽、重生成 profile 锁、处理 `allowBuilds`→`onlyBuiltDependencies` 语义 |
| primary-runtime **Node 24.21.0**（`runtime/<arch>/primary-runtime/dependencies/node/bin/node.exe`） | ❌ 否 | 官方 Node 22/24 BUILDING.md 平台下限为 Win10（Node 16 亦为 Win8.1+）；无官方 Win7 构建 | 若仅为 Office 的 CLI 载体，可用 Node 16.20.2 顶替（libreoffice-kit CLI 是纯 JS）——但 `skill-office` 自身 import `node:sea` 也会崩 |
| primary-runtime **Python 3.12.14**（cpython-build-standalone `x86_64-pc-windows-msvc`） | ❌ 否 | Python 官方：3.9 是最后支持 Win7 的版本，3.10+ 要求 Win8.1+，3.12 更高 | 降到 Python 3.9 + 重新锁定 numpy/pandas/lxml/Pillow 的 cp39 wheel（numpy 2.3/pandas 3.0 均无 cp39 轮子 → 需降版本，功能与 API 有差异） |
| Office skills（`skill-office` + `tool-workspace-dependencies`） | ❌ 否（如上两行） | `desktop-office.ts:85-93`；`skill-office/src/index.ts:7` `import { isSea } from 'node:sea'`（Node 16 直接 `ERR_UNKNOWN_BUILTIN_MODULE`） | 可整体不挂载：把 `resolveDesktopOfficeConfig()` 的 `required` 改 false 或整段跳过；损失 Office 文档技能 + `load_workspace_dependencies` 工具（UI 无对应页面，仅工具/技能缺失，见 §4.4） |
| `koffi` 3.1.1（FFI） | ✅ 是 | package.json 声明 `"napi": 8`（Node-API）→ ABI 稳定，Electron 22 的 Node 16 可直接加载同一二进制 | — |
| `node-pty` 1.2.0-beta.15 | ❌ 否（需要 PTY 的功能） | `node-addon-api`（N-API，二进制兼容✅），但 **win32 预编译只有 `conpty.node`/`conpty_console_list.node`，包内无任何 winpty 二进制**；`lib/windowsPtyAgent.js` 只走 ConPTY。ConPTY 需 Windows 10 1809+ | 影响：内嵌终端、`desktop-terminal.ts`、`subprocess-local` 的 terminal 模式。**不影响** agent 的 pwsh/bash 工具（pipe 模式） |
| `fs-ext` 2.1.1 | ✅（需按 ABI 重建） | 仓库 patch 已把 Electron 分支指向 `prebuilds/win32-x64/electron.abi<modules>.node`；`scripts/prepare-fs-ext.ts` 在打包前重建 | Electron 22 的 `process.versions.modules = 110` → 需重新生成该 ABI 的预编译产物 |
| `@vscode/ripgrep` 1.18.0（grep 工具后端） | ⚠️ 待实测 | 仓库只有 asar 路径 patch；裸 `rg.exe` 对 Win7 的支持需在实机验证（本机 Windows 10 自动下载的是当前平台二进制） | 若不可用：grep 工具退化 |
| Chromium 108 渲染层（Web 客户端 / native-ui） | ⚠️ 风险 | 客户端 `vite` target 为 `es2022`（OK），但 Tailwind v4 产物常用 `oklch()`/`color-mix()`（Chromium 111+）、`@scope`（118+，且 `vite.client.config.ts:21` 显式生成 `@scope` 包装 onboarding 样式 → 108 上整块被丢弃） | 需 Win7 实机截图验收 + 降级样式分支 |
| NSIS 安装器（electron-builder 26.15.7，`toolsets.nsis: 1.2.1`） | ⚠️ 待实测 | NSIS 3.x 本体支持 Win7；`installer.nsh` 仅用 builder 宏（`IS_POWERSHELL_AVAILABLE`/`FIND_PROCESS`/`KILL_PROCESS`），自带 tasklist 回退 | 安装器生成脚本可能用到 `WinVer.nsh` 判定，需实机跑一遍 |

### 2.1 一句话判定

> **Win7 上“Electron 22 壳 + 本地 DSH Host”在架构上不可能**：Host 的 JS 引擎 = Electron 的 Node，而支持 Win7 的最后一个 Electron 只带 Node 16.17.1，harness 的最低要求是 Node 24.9。这与“装不装 VC++ 运行库”“有没有独立 node.exe”无关。

---

## 3. 联网点清单

### 3.1 运行期（应用启动 + 常用功能）

| # | 触发时机 | 目标 / 代码 | 离线表现 | 代码里已有的开关 |
|---|---|---|---|---|
| 1 | Host 启动后约 60s，此后每 6h | `https://www.dshdesktop.cn/api/desktop/version`（`src/update-checker.ts:10`；`src/updates.ts:33-38`：`enabled` 默认 true、`initialDelayMs:60000`、`intervalMs:6h`、`requestTimeoutMs:15s`） | **静默失败**：`checkForUpdates()` 任何失败返回 null，不阻塞启动；用户手动“检查更新…”会弹错误 | 插件 config `enabled:false`；profile patch 禁用 `desktop-updates` 行 |
| 2 | 用户确认更新后 | `https://www.dshdesktop.cn/api/downloads/windows`（`src/update-download.ts:21-22`） | 只在用户点“下载”时触发 | 同 #1 |
| 3 | 每次启动（代理解析） | `session.resolveProxy` 探测 `https://api.deepseek.com/`、`https://registry.npmjs.org/`、`http://api.deepseek.com/`（`src/system-proxy.ts:53-57`） | 探测本身不发网络请求；但**若系统配置了 PAC，Chromium 会去拉 PAC 脚本 URL** → 企业环境是启动期网络点 | 用户显式设置 `http_proxy/https_proxy/all_proxy` 时不做系统探测 |
| 4 | 应用市场 | `desktop-market.ts` 的 `DEFAULT_SNAPSHOT = {provider:'disabled'}`（`desktop-market.ts:58-62`） | **默认不联网**；启用 `community-market`/`dsh-market` 后才由插件发起（vendor 内已带 tgz） | `market:disabled`（默认） |
| 5 | 插件安装/移除/`dsh plugin add` | pnpm → registry（`registry.npmjs.org` 或用户配置）+ 原生依赖重建时 `npm_config_disturl=https://electronjs.org/headers`（`pnpm.ts:220-222`、`profile-context.ts:69`） | 离线必然失败（pnpm ERR_PNPM_/网络错误），UI 报错但不影响已装插件 | 无离线开关；只能“不装插件” |
| 6 | 模型调用 | DeepSeek API（业务必需） | 离线即不可用（这正是“联机产品”的本质） | — |
| 7 | 账号登录 | Platform 登录页（`platform-login*.ts`） | 离线打不开登录页；未登录时部分功能不可用 | — |
| 8 | Office / Python | **无网络**：wheel 已在包内，`tool-workspace-dependencies` 只是把 payload 复制到 `$DSH_HOME/dsh-runtimes/...` | ✅ 完全离线 | — |
| 9 | 遥测 | 上游 `product-analytics` / `desktop-product-telemetry` 行已被本壳**默认禁用**（`src/profile.ts:105,1946-1952`）；`DSH_TELEMETRY_DISABLED` 还会禁用 `session-telemetry-otel`（`profile.ts:1944-1946`） | ✅ 默认不联网 | `DSH_TELEMETRY_DISABLED=1` |
| 10 | 代理策略安装 | `host-process-entry.ts:60-64` `installProxyFromEnvironment(...)`（`@deepseek-ai/dsh-http-proxy`） | 只安装本进程内策略，不探测 | — |
| 11 | Agents Anywhere | vendor 内置（`vendor/agents-anywhere`）；connector 是否外联取决于是否启用 AA 运行时 | 未启用时无网络 | AA 默认关闭（`aaEnabled`） |

**对照代码后的“离线模式”最小改动集**（不改 harness，只改壳/profile）：

1. `desktop-updates` 插件 config `enabled:false`（或 profile patch 里 disable 该 row）→ 消灭 #1/#2。
2. 保持 `market: disabled`（当前默认即是），并在 Setup 向导/设置页不提供“在线市场”入口。
3. 发布包里预设 `DSH_TELEMETRY_DISABLED=1`（当前默认已禁用产品分析，双保险）。
4. 文档/首启提示声明：“插件安装需要网络”；不提供离线 registry。
5. 若目标环境有 PAC：优先让用户导出 `http_proxy/https_proxy`，避免启动期拉 PAC。
6. 代码里**没有**全局 `offline` / `airgap` 开关（`grep -rni "offline|airgap" dsh-plugin-desktop/src` 仅命中 `desktop-office.ts:81` 的注释），因此“离线模式”= 上述配置项组合，不是单一 feature flag。**建议新增**一个 `DSH_DESKTOP_OFFLINE=1`，在 `main.ts` 里统一短路 #1/#2/#4 并把市场设置页置灰（属于新增功能，非现有能力）。

### 3.2 构建期（`yarn dist:win` / `dist:win-portable` 全链）

| # | 阶段 / 触发 | 外部来源 | 落盘缓存 | 离线方案 |
|---|---|---|---|---|
| 1 | `prepare:runtime` → `prepareDesktopRuntime()` | `https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip`（`scripts/primary-runtime.ts:151`） | `.desktop-build/downloads/<sha256>`（`prepare-runtime.ts:45-47`） | 预置该目录（按 sha256 命名）即命中缓存，不再下载 |
| 2 | 同上 | `https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`（`primary-runtime.ts:168-169`） | 同上 | 同上 |
| 3 | 同上 | 13 个 wheel（`https://files.pythonhosted.org/...`）：win_amd64 cp312 ×4（numpy 2.3.5 / pandas 3.0.1 / pillow 12.3.0 / lxml 6.1.3）+ 纯 Python ×9（docx/pptx/openpyxl/xlsxwriter/dateutil/six/tzdata/typing_extensions/et_xmlfile）（`deepseek-harness/scripts/primary-runtime/lock.json`） | 同上 | 同上 |
| 4 | 同上 | pnpm 分发包本身来自 `node_modules/pnpm`（`primary-runtime.ts:255-257`），无额外下载 | yarn install | — |
| 5 | `electron-builder`（`scripts/package-win.ts:187-207`） | Electron **22.3.27** 发行包（`@electron/get` → `github.com/electron/electron/releases`） | `%LOCALAPPDATA%\electron\Cache`；`node_modules/electron/dist`（已存在） | 预置缓存目录 / 预置 `electronDist`（`package-dir.mjs:14` 已支持 `--config.electronDist=`） |
| 6 | 同上 | `electron-builder-binaries`（`nsis-3.x`、`winCodeSign-2.6.0`，`app-builder-lib/out/binDownload.js:54` 指向 `github.com/electron-userland/electron-builder-binaries`） | `%LOCALAPPDATA%\electron-builder\Cache` | 预置目录（签名关掉也仍可能需要 winCodeSign 的资源包，见 `windowsSignToolManager.js:203` 的 legacy 判定） |
| 7 | `yarn market:prepare`（所有 `dist:*` 前置） | `https://registry.npmjs.org/dshmarket/latest`（`scripts/prepare-dsh-market.mjs:11`） | yarn cache | **离线直接报错**（非 2xx / 版本不一致都 throw）→ 需改成读本地版本或跳过 |
| 8 | `yarn aa:prepare-release`（所有 `dist:win*` 前置） | `git clone https://github.com/anywhere-labs/Agents-Anywhere.git` + 其 `corepack yarn install`（`scripts/prepare-agents-anywhere-release.mjs:6,11-12`；`agents-anywhere-release-policy.mjs:6`） | `vendor/agents-anywhere` + yarn cache | 预置 `vendor/agents-anywhere`；`DSH_AA_SOURCE_REPOSITORY`/`DSH_AA_SOURCE_REF` 可指向本地镜像 |
| 9 | harness 构建（`yarn upstream:prepare-runtime`：`pnpm install` + `build` + `release:pack`） | registry.npmjs.org（pnpm store） | pnpm store | 预置 store / `--offline` |
| 10 | `prepare:electron-native`（`prepare-fs-ext.ts`） | 无下载，但需本机 **MSVC + Python + node-gyp** 编译 fs-ext | `prebuilds/win32-x64/electron.abi110.node` | 构建机预装工具链（非网络） |
| 11 | 应用依赖（yarn install） | registry.npmjs.org（`vendor/dsh-runtime` 已把 200+ `@deepseek-ai/*` 变成 `file:vendor/...tgz`，见根 `package.json` resolutions） | yarn berry cache（当前 `.yarn/` 仅 5.6MB，不含 cache） | 预置 `.yarn/cache` 或 `enableGlobalCache:false + cacheFolder` |

**结论**：构建期离线“基本可行”，需要一次性预置 4 类缓存（`.desktop-build/downloads`、electron cache、electron-builder cache、yarn/pnpm store）+ 处理 2 个硬联网脚本（`market:prepare`、`aa:prepare-release`）。

> 顺序提示（有利于离线排错）：`scripts/package-win.ts:227` 在长 preflight 之前先 `prepareDesktopInterpreters()`，`package-win-portable.ts:14` 同理——下载失败会**先于** 30 分钟门禁暴露。

---

## 4. 方案对比：A（保留 DSH runtime）/ B（替换为 Win7 可用 runtime）/ C（远程前端）

### 4.0 先厘清一个前提（否则 A/B 都算错）

Lead 的口径是“Host 跑在 Electron 的 Node 16 里，primary-runtime 的 Node 24 主要给 pnpm/office”——**前半句正确，后半句需要修正**：

- Host（`utilityProcess.fork(host-process-entry.js)`）确实在 Electron 的 Node 里；
- 但 **pnpm 不是用 primary-runtime 的 Node 跑的**：`pnpm.ts:157-166` 的 argv[0] 是 `appExecutable`，即同样是 Electron 的 Node（`ELECTRON_RUN_AS_NODE=1`）；
- primary-runtime 的 Node 24 **只**出现在 `desktop-office.ts:91`（`skill-office` 的 `node` 参数）。
- 因此“把 primary-runtime 的 Node 换掉”**不会**让 Host 或 pnpm 变得 Win7 可用——Host 的引擎被 Electron 版本钉死。

### 4.1 方案 A：保留 DSH runtime，标注 Win7 不可用

| 项 | 内容 |
|---|---|
| 做法 | 沿用 Electron 22.3.27 打包，但**不承诺 Agent 功能**：启动后直接展示“此版本不支持当前 Windows 版本”的阻断页，只保留诊断导出/设置查看 |
| 实际改动面 | ① 回退/分叉壳的 Node-API 使用（`import.meta.resolve`×4 → `createRequire().resolve`；`structuredClone`×8 → `structuredClone` polyfill 或 `JSON` 深拷贝；`AbortSignal.timeout`×1 → 手写 `setTimeout+AbortController`）；② tsdown `target` 降到 `es2022`；③ Host 启动前插入 Windows 版本闸门（`process.getSystemVersion()` 或 `os.release()`）短路到阻断页；④ 打包时跳过 primary-runtime（`prepare:runtime` 仍会下载但无意义 → 可省） |
| 工作量 | 1～2 人周（仅壳降级 + 闸门 + 打包裁剪），无需碰 harness |
| 风险 | 低技术风险；**产品价值≈0**（Win7 用户拿不到 Agent）。且要长期维护一条与主线分叉的壳 |
| 结论 | 只适合“先把 Win7 安装包/壳发出去占位”的过渡目标 |

### 4.2 方案 B：替换为 Win7 可用 runtime（Node 16.20.2 + pnpm 8.15.9 + 去掉 office）

**结论：不现实。** 不是“改多少行”的问题，而是“把 58 个包的 harness 降级回 Node 16”的工程。

改动面清单（每一项都有硬证据）：

| # | 阻塞项 | 规模 / 证据 | 处理代价 |
|---|---|---|---|
| B1 | Host 引擎不可替换 | Host 只能是 Electron 的 Node（`host-process.ts:49`）。要换 Node 16.20.2 就得把 Host 改成**独立进程 + 自定义 IPC**（现在用 `process.parentPort`，`host-process-entry.ts:18`），`host-rpc.ts`/启动注入/退出协议全部重做 | 架构级 fork，≥ 数人周，且与上游彻底分叉 |
| B2 | `import.meta.dirname` | **227 处**（`deepseek-harness/packages|apps/**/*.ts`）；Node 20.11+ 才有 | 全仓 AST 改写为 `fileURLToPath(new URL('.', import.meta.url))`，并保证产物同步 |
| B3 | `node:sqlite` | `packages/storage/storage-sqlite`（index/schema/unit）与 `packages/session-query/session-query-sqlite`，共 **10 个源文件**；Node 22.5+ 才有 | 持久层换 `better-sqlite3`（原生模块，需为 Electron ABI 110 交叉编译）或换 JSON 存储（性能/功能回退），并迁移既有 session 数据格式 |
| B4 | `node:sea` | `packages/skill/skill-office/src/index.ts:7`；Node 20.12+ | 去掉 office 时仍需改 import（否则桌面插件静态 import 时即崩） |
| B5 | 其它 Node 18/20+ API | `import.meta.main`（node-24 note 明确依赖）、`structuredClone`、`Array.prototype.findLast`、`fs.globSync`（harness `tsdown.config.ts:1`，构建期）等，需逐包审计 | 中～大 |
| B6 | 构建产物 target | harness `tsdown.config.ts:31` `target:'es2024'`；`tsconfig` ES2024 | 全仓重建；且 `vendor/dsh-runtime/*.tgz` 是**预构建 tarball**（200+ 包），要从源码重打一套 Node 16 版 |
| B7 | pnpm 11 → 8.15.9 | 见 §2 表格 pnpm 行 + §1.3：`bin/pnpm.mjs`→`bin/pnpm.cjs`；`minimumReleaseAge`（pnpm 10+）策略删除/降级；profile `packageManager>=10` 闸门（`profile.ts:969`）；`allowBuilds`（pnpm 10.16+）→`onlyBuiltDependencies`；已提交 lock 全部重生成；`patches/pnpm@11.28.5.patch`（只改 `minimumReleaseAge` 的健壮性，161 行上下文）作废 | 中，且每个用户 profile 都要迁移 |
| B8 | Office / Python | Python 3.12→3.9，numpy/pandas 无 cp39 轮子（numpy 2.3/pandas 3.0 均是 cp312）→ 降级到 numpy 1.26/pandas 2.2 并重打 wheel 锁 | 中；Office 技能行为需重测 |
| B9 | 维护成本 | 每次上游发版都要把上面全部重做一遍 | **这是真正的杀手**：B 等于永久维护一个 harness 分叉 |

**最小 Node 版本判定（若只回答“能不能只换 pnpm”）**：不能。即使把 pnpm 降到 8.15.9，Host/CLI 仍在 Node 16.17.1 上因 B2/B3/B4 直接崩溃。**harness 的最小可用 Node ≈ 22.5（`node:sqlite`）+ 20.11（`import.meta.dirname`）**，取其高并叠加官方声明 = **Node 24.9**。

**B 的功能损失**：Office 全部技能、`load_workspace_dependencies` 工具、SQLite 持久层特性（session-query 全文检索等）、内嵌终端（ConPTY）、插件市场安装（pnpm 8 与现代 lockfile 组合基本不可用）。

### 4.3 方案 C（推荐，若“Win7 上要能用 Agent”是硬需求）

**Win7 只做前端壳，Host 跑在 Win10+ 上。**

- 现有资产可直接复用：Host 已经是一个本地 Web 服务（`webServer.port`）+ LAN HTTPS ingress（`lan-https-runtime.ts` / `lan-https-ingress.ts` / `lan-https-certificate.ts`）+ 浏览器访问模式（`compatibility` shell mode、`desktop-browser-access.ts`）。
- 改造点：新增 “remote host” 启动路径——`main.ts:1646` 处已有 `DSH_DESKTOP_ISOLATED_HOST=0` 的内联分支，可再加一个 `DSH_DESKTOP_REMOTE_HOST=<url>`：跳过 `utilityProcess.fork` 与 `bootDesktopHost`，直接把 `DesktopShellSpec.url` 指向远端（认证复用 `connection.authenticatedUrl` / LAN token）。
- 工作量：2～4 人周（壳 + 认证 + Setup 向导 + 离线诊断），**不碰 harness**。
- 风险：中（跨机认证、证书信任、版本兼容窗口）；但这是唯一既保功能又可持续的路线。
- 前置：需要一台 Win10+ 机器或一个远端 DSH Web 实例。

### 4.4 补充：Office / workspace-dependencies 能否整体禁用（Lead 问题 b）

- **能，而且不影响 UI**：`desktop-office.ts` 是 Host 里唯一挂载点（`host-bootstrap.ts:179-185`、`main.ts:1767-1772`）。客户端 `src/client` 里**没有任何 office 相关引用**（`grep -rn office src/client` 为空），设置页/向导也不依赖它。
- 三种禁用姿势（从轻到重）：
  1. **不打包 payload** 并把 `desktopPrimaryRuntime()` 的 `required` 从 `packaged` 改为 `false` → `resolveDesktopOfficeConfig` 返回 undefined，Host 只打一条 warn（`host-bootstrap.ts:180-182`），启动继续。
  2. 打包 payload 但不挂载：在 `host-bootstrap.ts` 直接跳过 `hostCtx.plugin(desktopOffice, office)`。
  3. 保留挂载但 `skill-office` 传 `cli:false`（`skill-office/src/index.ts:26` 支持 `cli: false`，会在技能文本里写“LibreOffice Kit is disabled”）→ 只损失导出/渲染，保留 docx/xlsx 结构化编辑。
- **风险**：`desktop-office.ts:6` 在模块顶层 `import * as officeSkills from '@deepseek-ai/dsh-skill-office'` → 即使不挂载，`node:sea` 的 import 也会在 Host 启动时炸。**所以 Node 16 方案下“只禁用 office”救不了 Host**（这条是 B 方案的重要反证）。

---

## 5. 安装器 / 离线自包含

### 5.1 安装器现状（`dsh-plugin-desktop/package.json` → `build`）

```json
"asar": false,
"electronFuses": { "runAsNode": true, "onlyLoadAppFromAsar": false,
                   "enableEmbeddedAsarIntegrityValidation": false, "resetAdHocDarwinSignature": true },
"win": { "asar": false, "compression": "normal",
         "target": [{ "target": "nsis", "arch": ["x64"] }],
         "extraResources": [{ "from": ".desktop-build/runtime", "to": "runtime" }] },
"nsis": { "include": "installer.nsh", "oneClick": false, "perMachine": false,
          "allowElevation": true, "allowToChangeInstallationDirectory": true,
          "differentialPackage": false, "useZip": false, "license": "THIRD_PARTY_NOTICES.md" },
"npmRebuild": false,
"toolsets": { "nsis": "1.2.1" }
```

- **portable**：`scripts/package-win-portable.ts` 走同一 electron-builder 流程，`target='zip'`（产物名 `DSH-Desktop-<ver>-x64-Portable.zip`），解压即用，无安装步骤、不写注册表（除单实例/托盘状态）。
- **`build/installer.nsh` 审查（111 行）**：只用 electron-builder 提供的宏与 `StdUtils`：
  - `customCheckAppRunning`：`IS_POWERSHELL_AVAILABLE` + `FIND_PROCESS` + `KILL_PROCESS`（builder 宏，PowerShell 不可用时回退 tasklist）；
  - `customInit` / `customInstallMode`：`${isUpdated}` / `${isForceRun}` 时跳过安装模式向导页；
  - `customInstall`：`--updated --force-run` 时 `HideWindow` + `StdUtils.ExecShellAsUser` 重启应用；
  - **没有**任何自研下载、注册表探测、外部 exe 释放。→ Win7 上不会因为 installer.nsh 引入额外依赖。
- **`runAsNode:true` 是必需的**：Host/pnpm/dsh CLI 全靠 `ELECTRON_RUN_AS_NODE`，关掉 fuse 会整体失效（`scripts/verify-electron-fuses.ts` 在 `afterAllArtifactBuild` 里校验）。

### 5.2 Win7 运行库依赖（需实机确认，按优先级）

| 依赖 | 说明 | 建议动作 |
|---|---|---|
| Windows 7 **SP1** x64 | Chromium 108 的最低要求 | 安装器/文档前置声明 |
| SHA-2 代码签名支持（KB4474419 + KB4490628） | Win7 无 SHA-2 支持则无法验证签名二进制 | 文档前置；或对 Win7 版本不使用 SHA-256 签名（未签名 exe 在 Win7 上可运行） |
| **Universal C Runtime (UCRT)**：`api-ms-win-crt-*.dll` / `ucrtbase.dll` | Chromium/Electron 动态链接 UCRT。Win7 SP1 需 KB2999226 或已安装 VC++ 2015+ redist | **P0 实机验证**：干净 Win7 SP1 上直接跑 `DSH Desktop.exe`；若失败→在安装器里静默装 `vc_redist.x64.exe`，或把 UCRT DLL 随应用分发 |
| VC++ 2015-2022 Redistributable | Electron 官方分发依赖系统 UCRT；本仓库的 `fs-ext` 等原生模块由 MSVC 构建 | 与上一行合并处理：安装器预检 + 内嵌 redist |
| PowerShell 2.0 | Win7 自带；安装器宏与 `windows-pwsh-sandbox` 需要 | 无需动作（PowerShell 5.1 需 WMF 5.1，可选升级） |
| WebView2 | **不需要**：本应用用 Electron 自带 Chromium，不用 WebView2 | 无需动作（这点与很多“Win7 兼容”项目不同，是好消息） |

### 5.3 自包含（离线可运行）清单

运行期（安装后不再联网即可启动/使用核心功能）：

- [x] Electron + 全部前端资源（`asar:false`，`lib/**` + `build/*` 图标）
- [x] `.desktop-build/runtime/<arch>/primary-runtime`（Node + Python + pnpm + wheels）、`office-skills`
- [x] `node_modules` 生产依赖（含 `node-pty` 预编译、`koffi`、`fs-ext` ABI 预编译、`pnpm` 分发包）
- [x] vendor 化的 `@deepseek-ai/*` 运行时（`app.asar/dsh` 携带完整生产依赖树）
- [ ] UCRT / VC++（若系统缺）→ 安装器内嵌
- [ ] 更新检查（默认开启）→ 发布 Win7 版时建议关掉，避免每次启动一次静默外联

合规（离线分发二进制会放大义务）：

- `nsis.license` 指向 `THIRD_PARTY_NOTICES.md`；仓库有 `verify-licenses.mjs` 门禁（`yarn verify:notices`）。
- 若方案 A′/B 去掉 Office：需同步移除 Node 24 / Python 3.12 / 13 个 wheel 的许可条目，否则 notice 与实际分发不符。
- 若内嵌 `vc_redist.x64.exe`：需附带 Microsoft 的可分发条款说明。

---

## 6. 分级清单（P0 / P1 / P2）

| 级别 | 组件或文件 | 改动 | 依据 |
|---|---|---|---|
| **P0** | 产品决策（Lead） | 明确 Win7 交付物：A′ 窄壳 / C 远程前端 / 不发布。这是所有后续工作的前提 | §2、§4 |
| **P0** | `dsh-plugin-desktop/package.json`（工作树已改 `electron: 22.3.27`） | 该改动**单独存在时是坏状态**：壳与 harness 都需要 Node ≥20.11/≥24.9。要么回退，要么与 §4.1 的壳降级一起提交 | §1、§2 表格；`import.meta.resolve`×4 等 |
| **P0** | 设计文档/发布说明 | 写明“Electron 22 = Node 16.17.1 = 不支持本地 DSH Host”；禁止“降个 Electron 就兼容 Win7”的错误预期 | Electron release 页 + harness engines + node-24 note |
| **P0** | 主线保护 | Win7 必须走独立分支/独立 package（禁止在 `dsh-plugin-desktop` 主链上做 Node16 兼容分叉），否则每次同步上游都会冲突 | 仓库有 Stable/Beta/Next 三变体 + `verify-desktop-variants.mjs` 门禁 |
| **P1** | `src/main.ts`（Host 启动前） | 新增 Windows 版本闸门：<Win10 时直接进阻断页并给出 C 方案指引（或 `DSH_DESKTOP_REMOTE_HOST`） | `main.ts:1646` 已有类似分支可直接挂 |
| **P1** | `src/desktop-office.ts:61` / `host-bootstrap.ts:179` | 方案 A′ 下把 `required` 置 false 并跳过挂载；同时打包裁剪 `.desktop-build/runtime`（省 ~200MB） | `desktop-office.ts:71-78` |
| **P1** | `src/update-checker.ts` / `src/updates.ts` | Win7 版禁用后台更新检查（config `enabled:false` 或 profile patch 禁 row），避免无意义外联与失败日志 | `updates.ts:33-38` |
| **P1** | 构建脚本 `scripts/prepare-dsh-market.mjs`、`scripts/prepare-agents-anywhere-release.mjs` | 离线构建必改：支持本地版本/本地 vendor 跳过 npm latest 与 git clone | `prepare-dsh-market.mjs:11,60`；`agents-anywhere-release-policy.mjs:6` |
| **P1** | CI 缓存 | 缓存 `.desktop-build/downloads`、`%LOCALAPPDATA%\electron\Cache`、`%LOCALAPPDATA%\electron-builder\Cache`、`.yarn/cache`（或 pnpm store） | §3.2 |
| **P1** | 安装器 | 预检并静默安装 VC++/UCRT（或随包分发 UCRT DLL）；Win7 前置 KB 文档 | §5.2（**需实机验证**） |
| **P2** | 前端样式 | Chromium 108 不认 `@scope`/`oklch()`/`color-mix()`；`vite.client.config.ts:21` 的 `@scope` 包装会让 onboarding 样式整块失效 → 增加 108 降级路径 | `vite.client.config.ts:19-26` |
| **P2** | `node-pty` | Win7 无 ConPTY：内嵌终端/`subprocess-local` terminal 模式不可用（agent 的 pwsh/bash 工具不受影响）。若需要，换回带 winpty 的 node-pty 1.0 或自建 winpty 后端 | `node_modules/node-pty/prebuilds/win32-x64`（仅 conpty）；`windowsPtyAgent.js` |
| **P2** | `@vscode/ripgrep` | 实机验证 `rg.exe` 能否在 Win7 运行；否则 grep 工具退化 | `patches/vscode-ripgrep@1.18.0.patch` |
| **P2** | `installer.nsh` | 实机跑一遍安装/升级/卸载（`IS_POWERSHELL_AVAILABLE` 在 Win7 中文系统上的行为） | §5.1 |
| **P2** | 许可证 | 按最终组件集重生成 `THIRD_PARTY_NOTICES.md` | `verify-licenses.mjs` |

---

## 7. 待实机验证（本次审计无法闭环）

1. 干净 **Win7 SP1 x64**（无 KB2999226）上直接运行 `DSH Desktop.exe` 是否报 `api-ms-win-crt-*` 缺失。→ 决定是否内嵌 UCRT/VC++。
2. Electron 22.3.27 在 Win7 上 `chrome-sandbox`/GPU 进程的降级行为（是否需要 `--disable-gpu` / `--no-sandbox`）。
3. `rg.exe`（`@vscode/ripgrep@1.18.0` 对应的 ripgrep 版本）在 Win7 的启动兼容性。
4. electron-builder 26.15.7 生成的 NSIS 安装器在 Win7 的实际行为（`WinVer.nsh` 差异、`StdUtils` 插件、长路径）。
5. Chromium 108 下 Web 客户端的实际渲染（Tailwind v4 产物）。
6. 方案 C 的跨机认证/证书细节（LAN HTTPS CA 在 Win7 证书存储的导入行为）。

## 8. 证据索引（文件:行）

- `dsh-plugin-desktop/src/host-process.ts:49` — `utilityProcess.fork('host-process-entry.js')`
- `dsh-plugin-desktop/src/host-process-entry.ts:18,60-64` — `process.parentPort`；`installProxyFromEnvironment`
- `dsh-plugin-desktop/src/host-bootstrap.ts:135,179-185` — `boot()`；office 挂载
- `dsh-plugin-desktop/src/desktop-office.ts:55-62,71-78,85-93` — primary-runtime 定位/强制/office 配置
- `dsh-plugin-desktop/src/pnpm.ts:153-166,206-224` — pnpm 由 Electron 执行 + env
- `dsh-plugin-desktop/src/profile-context.ts:57-70` — profile 的 packageManager 契约
- `dsh-plugin-desktop/src/profile.ts:950-976` — profile `pnpm-workspace.yaml` 契约 + `packageManager>=10` 闸门
- `dsh-plugin-desktop/src/desktop-runtime-environment.ts:432-465` — Windows `pnpm.cmd`/`dsh.cmd` 内容
- `dsh-plugin-desktop/src/main.ts:801,810,1539-1560,1628,1646` — pnpm/dsh 入口、runtime 装配、隔离 Host 开关
- `dsh-plugin-desktop/src/update-checker.ts:10` / `src/update-download.ts:21-22` / `src/updates.ts:33-38` — 更新端点与节奏
- `dsh-plugin-desktop/src/system-proxy.ts:53-57` — 代理探测 URL
- `dsh-plugin-desktop/src/profile.ts:105,1944-1952` — 遥测行默认禁用
- `dsh-plugin-desktop/scripts/primary-runtime.ts:111-138,151,168-169,240-285` — 下载/缓存/装配
- `dsh-plugin-desktop/scripts/prepare-runtime.ts:45-47,93-109,200-220` — 构建路径与门禁
- `dsh-plugin-desktop/scripts/package-win.ts:187-207,227` — electron-builder 调用与下载顺序
- `dsh-plugin-desktop/package.json` → `build.*` — 打包配置
- `deepseek-harness/package.json`（`engines.node >=24.9.0`, `packageManager pnpm@11.28.5`）
- `deepseek-harness/apps/cli/package.json:179-181` — `engines.node >=24.9.0`
- `deepseek-harness/tsdown.config.ts:31` — `target:'es2024'`
- `deepseek-harness/scripts/primary-runtime/lock.json` — Node 24.21.0 / Python 3.12.14 / wheels
- `deepseek-harness/.agents/notes/implemented/process/2026-10-15-node-24-runtime-floor.md` — Node 24.9 下限的依据
- `deepseek-harness/packages/skill/skill-office/src/index.ts:7` — `import { isSea } from 'node:sea'`
- `deepseek-harness/packages/storage/storage-sqlite/src/*.ts`、`packages/session-query/session-query-sqlite/src/*.ts` — `node:sqlite`
- `patches/pnpm@11.28.5.patch` — 仅改 `minimumReleaseAge` 健壮性（与 Node 兼容无关）
- `patches/fs-ext@2.1.1.patch` — Electron ABI 预编译路由
- `patches/node-pty@1.2.0-beta.15.patch` — spawn-helper 路径 + conout 释放（非 Win7 相关）
- `patches/vscode-ripgrep@1.18.0.patch` — asar→unpacked 路径

> 备注：`aigc-proof` skill 在本会话不可用（`skill` 返回 unknown），本报告按“结论先行 + 证据可追”的普通技术报告体例撰写。
