# DSH Desktop → Electron 22.3.x 主进程/Node 侧移植审计

审计对象：`dsh-plugin-desktop`（Stable，主战场）、`dsh-plugin-desktop-beta`（共享变体）
基线：Electron **22.3.27**（Chromium 108 / Node **16.17.1** / ABI **110**）；当前代码基线 Electron **44.7.0**
范围：`src/` 下运行在主进程 / utilityProcess / preload 的代码（忽略 `src/client/`、`src/**/*.tsx`、CSS）
本报告只做只读审计与方案设计，**未改动任何源码**。

## 判据来源

- Electron 22 可用性以仓库内已装的 `dsh-plugin-desktop/node_modules/electron/electron.d.ts`（`version: 22.3.27`）为**唯一权威**，逐符号 grep 核对，不依赖记忆。
- 代码位置来自当前 commit 的真实文件，行号与 Lead 实测的 21 条 `tsc` 报错一一对应。
- Lead 已实测：pin `electron@22.3.27` 后主进程/预加载仅 **21 个 TS 错误**，说明 Electron API 面确实很窄。本报告在此基础上补上 **tsc 看不见的运行时 / 构建形态 / 进程架构** 三类问题——它们才是真正的阻塞点。

## 结论（三条最重要的）

1. **真正的阻塞项不是那 21 个 TS 错误，而是构建形态与进程架构**，三者 tsc 全部看不见：
   - **主进程产物是 ESM**（`package.json` 的 `type=module`、`main=lib/main.js`、`tsdown format:'esm'`）。Electron 22 **不支持主进程 ESM**；产物首行就是 `import { app, ... } from "electron"`，在 22 上启动即失败。必须切 CJS。
   - **整个 DSH Host 跑在 `utilityProcess` 里**（`src/host-process.ts:49`），Electron 22 的 utilityProcess 用的是 **Node 16.17.1**，而它装载的是 `engines.node: ^22.19` 的整棵 harness。这是**项目级阻塞**，绕法是改用随包分发的 Node 22 primary-runtime 起子进程（见 §八）。
   - **主进程直接使用 Node 18+ 全局与 API**（`Readable.toWeb`、`new Headers` / `new Response`、`structuredClone`、`AbortSignal.timeout`、`import.meta.resolve`），在 Node 16 上运行时直接抛错；其中 `import.meta.resolve` 位于 `main.ts` 的 import 链上，**模块加载期**就会炸。
2. **Electron API 侧确实可控**：唯一真正“无等价物”的是 `WebContentsView` / `contentView`（Electron 30+）。改用 22 完整支持的 `BrowserView`（`addBrowserView` / `setTopBrowserView` / `removeBrowserView`）可等价实现双 surface 结构；`net.fetch` / `session.fetch` 需自建 fetch 风格适配层，仓库里已有 `net.request` 适配先例可直接复用。
3. **好消息（可省掉大量工作）**：`webContents.ipc`、`app.getPath('sessionData')`、`utilityProcess`、`setDisplayMediaRequestHandler`、`setDevicePermissionHandler`、`titleBarOverlay`、`roundedCorners`、`thickFrame`、`webContents.close(opts)`、`webContents.invalidate()`、`BrowserView.setBackgroundColor` 在 22 **全部存在**，无需改动或改动极小。Windows 打包也**不依赖 ABI 绑定的原生模块**（Windows 不用 fs-ext；node-pty 走 N-API 预编译），所以 ABI 110 在 Windows 侧几乎无痛。
## 一、Electron API > 22 的用法清单

图例：**22可用** —— `✔` 存在可用、`✘` 不存在、`△` 存在但语义/平台不同。“引入版本”为参考值（以 22 d.ts 的 grep 结果为准）。

| # | API | 22可用 | 引入版本 | 代码位置 | 22 上的最小替代方案 |
|---|---|---|---|---|---|
| 1 | `WebContentsView` | ✘ | 30 | `compatibility-shell.ts:1,16,20,41,48`；`beta/platform-view.ts:8,46,152` | `BrowserView`，见 §3 |
| 2 | `BrowserWindow.contentView` / `addChildView` / `removeChildView` | ✘ | 30 | `compatibility-shell.ts:62,63,213,214`；`beta/platform-view.ts:34,179,234` | `window.addBrowserView` / `setTopBrowserView` / `removeBrowserView` |
| 3 | `BaseWindow` / `View` | ✘ | 30 | `beta/platform-view.ts:8,34` | 不需要：保留 `BrowserWindow` + `BrowserView` |
| 4 | `WebContents.ipc` | ✔ | 22 已有 | `compatibility-shell.ts:74,207`；`electron-shell-generation.ts:359,369,379,653-655` | **无需改动**（22 d.ts 已有 `readonly ipc: IpcMain`，`:11897`） |
| 5 | `Net.fetch` | ✘ | 24+ | `electron-runtime.ts:243` | 复用已有 `net.request` 适配器（`electron-runtime.ts:113-181`）扩展为通用 fetch 层，见 §2.3 |
| 6 | `Session.fetch` | ✘ | 24+ | `electron-shell-generation.ts:81,88,90,93` | `net.request({ session, credentials:'include', useSessionCookies:true, redirect:'follow' })`（22 的 `ClientRequestConstructorOptions` 支持这四个字段，核对自 d.ts:13570-13630） |
| 7 | `WebFrameMain.detached` | ✘ | 22 无 | `electron-shell-generation.ts:130,132` | 探针函数（22 有 `origin`/`top`/`parent`/`processId`/`routingId`，仅缺 `detached`），见 §1.2 |
| 8 | `Event<T>` 泛型 + `WebContentsWillFrameNavigateEventParams` | ✘ | 22 无 | `electron-shell-generation.ts:516` | 改签名 `(event: Electron.Event & { url: string; isMainFrame: boolean })` |
| 9 | `will-frame-navigate` 事件 | ✘ | 28+ | `electron-shell-generation.ts:598,646` | 改用 `will-navigate`：22 只在主 frame 触发，与原代码 `if (!event.isMainFrame) return` 分支等价，行为不损失 |
| 10 | `SafeStorage.getSelectedStorageBackend()` | ✘ | 29+ | `main.ts:333` | Linux 后端判定降级，见 §1.2(c) |
| 11 | `webUtils.getPathForFile` | ✘ | 29 | `preload.ts:3,19`；`beta/preload-app.ts:2,65` | 22 的 `File` 仍带 `.path`（Electron 32 才移除）：特性探测 + 回退，见 §1.2(d) |
| 12 | `navigationHistory` | ✘ | 32 | 未使用 | 无影响 |
| 13 | `backgroundMaterial` | ✘ | 27+（Win11） | 未直接使用 | 无影响（Win7 本就没有材质） |
| 14 | `titleBarOverlay` | ✔ | 13+ | `window-options.ts:140`；`auxiliary-window-options.ts:36` | 存在，但**仅 Win10+ 生效**；Win7 无原生覆盖层，见 §七 降级清单 |
| 15 | `roundedCorners` | ✔ | 13+（macOS 语义） | `window-options.ts:146`；`auxiliary-window-options.ts:42` | Win7 无效果，纯外观损失 |
| 16 | `thickFrame` / `hasShadow` / `autoHideMenuBar` | ✔ | 早期 | `window-options.ts:138,145,147` | 无需改动 |
| 17 | `utilityProcess` | ✔ | 22.0 | `host-process.ts:4,49` | 存在，但其 Node 版本是 **16**，见 §八 |
| 18 | `setDisplayMediaRequestHandler` | ✔ | 22 已有 | `platform-login-window.ts:191` | 无需改动（d.ts:8159） |
| 19 | `setDevicePermissionHandler` | ✔ | 22 已有 | `platform-login-window.ts:190` | 无需改动（d.ts:8148） |
| 20 | `app.getPath('sessionData')` | ✔ | 22 已有 | 未使用（仅 `userData`/`logs`/`crashDumps`/`downloads`/`home`/`appData`） | 无需改动（d.ts:961） |
| 21 | `protocol.handle` / `registerSchemesAsPrivileged` | ✘ / ✔ | 25 / 早期 | **仅 beta**：`beta/main.ts:115,1211` | beta 若要 22：退回 `registerFileProtocol` / `registerStreamProtocol`，并把返回 `Response` 改成 Node 流，见 §九 |
| 22 | `webContents.close(opts)` / `invalidate()` | ✔ | 22 已有 | `compatibility-shell.ts:158,159,216,217` | 无需改动（d.ts:11259 / 11479） |
### 1.1 两个被 tsc 掩盖的运行时风险（必读）

- `webContents.ipc`（`compatibility-shell.ts:74` 和 `electron-shell-generation.ts:359/369/379`）**在 22 上完全可用**，不需要像常见移植那样退回全局 `ipcMain`。但要注意 22 的语义：`webContents.ipc` 只收该 WebContents 主 frame 的消息，代码里额外的 `event.senderFrame !== renderer.mainFrame` 校验仍然成立，可原样保留。
- `titleBarOverlay` 在 22 存在但**只在 Windows 10/11 生效**；Windows 7 上 `titleBarStyle:'hidden'` + `titleBarOverlay` 不会画出任何原生最小化/最大化/关闭按钮，必须由 chrome surface 自绘（见 §七 降级项 D3）。

### 1.2 逐项最小改法（可直接落地的骨架）

**(a) `WebFrameMain.detached` → 探针函数**（`electron-shell-generation.ts:124-133`）

```ts
type MaybeDetached = { detached?: boolean }
function frameAlive(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  if (!frame) return false
  if ((frame as unknown as MaybeDetached).detached === true) return false   // 30+ 直接读
  try { void frame.origin; void frame.url } catch { return false }          // 22：detached frame 访问会抛
  return true
}
// requestComesFromRendererOrigin 内：
if (!frameAlive(details.frame) || details.frame.origin !== origin) return false
const top = details.frame.top ?? (details.frame.parent === null ? details.frame : undefined)
return top !== undefined && frameAlive(top) && top.origin === origin
```

**(b) `will-frame-navigate` → `will-navigate`**（`electron-shell-generation.ts:504-525, 598, 646`）

```ts
const navigate = (event: Electron.Event, url: string): void => {
  let target: string | undefined
  try { target = new URL(url).origin } catch { target = undefined }
  if (target !== origin) event.preventDefault()
}
renderer.on('will-navigate', navigate)      // 22：仅主 frame 触发，等价原逻辑
renderer.off('will-navigate', navigate)
```

**(c) `safeStorage.getSelectedStorageBackend()` → 平台降级判定**（`main.ts:328-339`）

```ts
available: () => {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform !== 'linux') return true          // Windows 7：DPAPI，可用
  // 22 无法读后端名：改用「存在 keyring 才有资格」的保守判定，
  // 宁可拒绝保存 CA 私钥，也不落到 basic_text 明文。
  return process.env.DBUS_SESSION_BUS_ADDRESS !== undefined
    && app.commandLine.hasSwitch('password-store') === false
}
```
说明：22 上 `isEncryptionAvailable()` 在 Linux basic_text 情况也可能返回 true（这正是 29+ 引入 `getSelectedStorageBackend` 的原因），因此 22 必须**保守判定**；最坏结果是 Linux 每次启动重建 CA（可接受的功能降级，Windows 目标不受影响）。

**(d) `webUtils.getPathForFile` → `.path` 回退**（`preload.ts:17-21`）

```ts
import { contextBridge, ipcRenderer } from 'electron'
// 22 无 webUtils：不要写命名 import（CJS 下是 undefined、ESM 下是链接错误）
const electron = require('electron') as typeof import('electron') & {
  webUtils?: { getPathForFile(file: File): string }
}
function pathFor(file: File): string {
  const viaWebUtils = electron.webUtils?.getPathForFile
  if (typeof viaWebUtils === 'function') return viaWebUtils.call(electron.webUtils, file)
  return (file as File & { path?: string }).path ?? ''      // Electron ≤31 的 File.path
}
contextBridge.exposeInMainWorld(DESKTOP_HOST_PATHS_BRIDGE, { pathFor })
```
注意：preload 已是 CJS 产物（`tsdown` 第三段配置），改成 `require` 后 22/44 双兼容；`beta/preload-app.ts:65` 同样处理。

**(e) `MessageBoxOptions.type` 窄化**（`desktop-dialog-window.ts:233-245`）

```ts
type DialogType = 'none' | 'info' | 'error' | 'question' | 'warning'
const DIALOG_TYPES: readonly string[] = ['none', 'info', 'error', 'question', 'warning']
function dialogType(value: string | undefined): DialogType {
  return value !== undefined && DIALOG_TYPES.includes(value) ? value as DialogType : 'none'
}
// 调用处：type: dialogType(options.type)
```
原因：22 的 `MessageBoxOptions.type` 是宽 `string`（d.ts:14763 区块），新版是窄字面量联合；代码把 Electron 的宽类型直接塞进自己的窄联合，故报“不可赋给”。

**(f) `console-message` 事件签名**（`renderer-logging.ts:14-17`）

```ts
type ConsoleMessageEvent = Electron.Event & { message?: string; level?: string | number }
contents.on('console-message', (event: ConsoleMessageEvent, legacyLevel: number, legacyMessage: string) => {
  const message = typeof legacyMessage === 'string' ? legacyMessage : event?.message
  ...
})
```
22 实际回调是 `(event, level: number, message: string, line: number, sourceId: string)`；现有代码已经同时兼容两代形状，只是**类型**要放宽，运行期无需改动。
## 二、Node 22 → Node 16.17 的 API / 全局缺失

### 2.0 受影响进程（先划清边界）

| 进程 | 实际 Node / 引擎 | 受影响 |
|---|---|---|
| Electron 主进程 | Node **16.17.1** | 是 |
| `utilityProcess` 里的 DSH Host | Node **16.17.1**（Electron 22 的 utilityProcess 用 Electron 自带 Node） | 是（见 §八，建议改架构回避） |
| preload（sandbox + contextIsolation） | Chromium 108 + 受限环境 | 是（Node 侧 API 大多不可用） |
| 主进程 spawn 的 primary-runtime（`runtime/<arch>/primary-runtime/node`） | **Node 22**（随包分发） | 否 |
| 打包/校验脚本（`scripts/*.ts`） | 开发机 Node 22 | 否 |

### 2.1 命中清单（精确到行）

| # | 缺失项 | Node 引入 | 命中位置 | 22/16 上的替代 |
|---|---|---|---|---|
| 1 | `import.meta.resolve()` | 20.6（16 仅 `--experimental-import-meta-resolve`） | `module-resolution.ts:21`（**模块顶层，import 即执行**）；`desktop-office.ts:88`；`beta/host/office.ts:53` | `createRequire(import.meta.url).resolve(specifier)` + `pathToFileURL()`；CJS 产物下 `import.meta.url` 先替换为 `pathToFileURL(__filename).href` |
| 2 | `fetch` 全局 | 18 | `update-checker.ts:215`（`defaultRequest` 兜底） | 主进程已注入 `request`（`electron-runtime.ts:243`）；把 `defaultRequest` 改为抛错或用适配层 |
| 3 | `Headers` / `Response` / `Request` / `ReadableStream` / `Blob` / `FormData` 全局 | 18 | `electron-runtime.ts:118,134,145,148`；`host-runtime-bridge.ts:57,58` | 自建最小 shim（推荐）或运行时注入 `undici@5`，见 §2.3 |
| 4 | `Readable.toWeb()` | 17 | `electron-runtime.ts:148` | Node 16 有 `require('node:stream/web').ReadableStream`；用手写适配器或 `undici` 的 `ReadableStream` 构造 |
| 5 | `structuredClone` | 17 | `profile.ts:1617,1983,1989`；`setup-wizard-settings.ts:358,508,550,593`；`profile-context.ts:58`（共 8 处） | `v8.serialize`/`v8.deserialize` 深拷贝 helper（纯 JSON 数据，语义等价） |
| 6 | `AbortSignal.timeout()` | 17.3 | `platform-login-window.ts:83`；`beta/main.ts:936`、`beta/platform-login-window.ts:67`、`beta/updates.ts:95,140` | 手写 `controller + setTimeout + signal.addEventListener('abort', clear)` |
| 7 | `AbortSignal.any()` | 20.3 | `beta/updates.ts:95,140` | 合并：把两个 signal 都 `addEventListener('abort', () => controller.abort(reason))` |
| 8 | `AbortSignal.reason` | 17.2 | `electron-runtime.ts:162` | `(signal as { reason?: unknown }).reason ?? undefined`，否则走 `DOMException` 分支 |
| 9 | `URL.canParse()` | 18.17 | `module-resolution.ts:256`；`package-overlay.ts:119`；`profile.ts:1387`；beta：`browser-guests.ts:157,167`、`platform-view.ts:160,169`、`platform-login-window.ts:39`、`client/market-toggle.ts` | `function canParse(v: string) { try { new URL(v); return true } catch { return false } }` |
| 10 | `Array.prototype.findLastIndex()` | 18 | `profile.ts:549,901` | 倒序 `for` 或 `[...arr].reverse().findIndex()` |
| 11 | `import.meta.url` | ESM only | 桌面插件 11 个文件（`bin.ts:71,124,185`、`compatibility-shell.ts:17,42`、`desktop-cli.ts:16,128`、`diagnostic-export.ts:41-42`、`host-process.ts:49`、`module-resolution.ts:21,25,26` 等） | 切 CJS 后由 bundler 生成 `__filename` 版 shim（见 §4），**不要**手改调用点 |
| 12 | `node:sqlite` / `util.parseArgs` / `fs.cp` / `node:test` / `process.getActiveResourcesInfo` / `Array.fromAsync` / `Promise.withResolvers` / `Object.groupBy` / `Array.prototype.toSorted|toReversed|with` | 均 ≥16.7 或更高 | **主进程代码未使用**；`fs.cp`/`util.parseArgs`/`node:test` 只在 `scripts/*` 出现（本机 Node 22 跑，无影响） | 无需处理（已逐项 grep 确认） |
| 13 | `crypto.randomUUID()` | 14.17 | `crash-evidence.ts:133,157`、`desktop-data-operation-lock.ts:99`、`desktop-installation-id.ts:3,84`、`desktop-runtime-environment.ts`、`desktop-terminal.ts:195`、`main-window-state.ts:113`、`lifecycle-events.ts:291`、`developer-logging.ts:9,29`、`diagnostic-export-worker.ts:288` | **16.17 可用，无需改动** |
| 14 | `Object.hasOwn` / `String.replaceAll` / `Error.cause` / `Array.prototype.at` / `timers/promises` | 16.9 / 15 / 16.9 / 16.6 / 15 | 多处 | **16.17 全部可用，无需改动** |
### 2.2 建议新增 `src/node16-shims.ts`（替代方案集）

```ts
import { serialize, deserialize } from 'node:v8'
import { Readable } from 'node:stream'
import { ReadableStream as WebReadableStream } from 'node:stream/web'

/** structuredClone 替代：Desktop 的数据均为 JSON 形状，v8 往返语义等价且更快。 */
export function cloneDeep<T>(value: T): T { return deserialize(serialize(value)) as T }

/** AbortSignal.timeout 替代（17.3 才有）。 */
export function timeoutSignal(ms: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/** URL.canParse 替代（18.17 才有）。 */
export function canParseUrl(value: string): boolean { try { new URL(value); return true } catch { return false } }

/** Readable.toWeb 替代（17 才有）：最小单向桥接。 */
export function nodeReadableToWeb(source: Readable): ReadableStream<Uint8Array> {
  return new WebReadableStream({
    start(controller) {
      source.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      source.on('end', () => controller.close())
      source.on('error', error => controller.error(error))
    },
    cancel() { source.destroy() },
  }) as unknown as ReadableStream<Uint8Array>
}
```
> 注意 `DOMException` 在 Node 16 是全局可用的（`globalThis.DOMException`），无需 shim；`AbortController`/`AbortSignal` 自 15 起稳定。

### 2.3 `net.fetch` / `session.fetch` 适配层设计（关键交付）

**约束**：既要 22（无 fetch）跑通，也要 44 不劣化；必须保留**流式响应、系统代理、Cookie、重定向、abort**，不能退回 `https.request`（会绕开 Chromium 的代理与证书策略）。

**三个方案对比**

| 方案 | 改动量 | 保留代理/证书 | 保留 Cookie | 流式 | 风险 |
|---|---|---|---|---|---|
| A. 自建 `desktop-fetch.ts`：`net.request` → 自定 `DesktopResponse` 结构 | 中 | ✔（Chromium net 栈） | ✔（`useSessionCookies`） | ✔（Node 流 + 裸 reader） | 需把调用点的 `Response` 换成新结构 |
| B. 运行时注入 `undici@5` 的 `Headers`/`Response`/`fetch` | 小 | ✘（fetch 走 undici 自己的 socket，绕开系统代理/证书） | ✘ | ✔ | 与代码里精心实现的代理/证书逻辑冲突，**不推荐用在传输层** |
| C. B 的裁剪版：只用 undici 提供 `Headers`/`Response` **类**，传输仍走 `net.request` | 小 | ✔ | ✔ | ✔ | 多一个依赖（~1MB），但调用点几乎不改；**推荐** |

推荐 **C 为主、A 为兜底**：即 `src/desktop-fetch.ts` 同时导出 `Headers`/`Response`（有 `undici@5` 就用现成的，没有就用内联最小实现）和 `fetchLike(url, init, { session })`。核心骨架：

```ts
import { net, type Session } from 'electron'
import { Request as NetRequestCtor } from './node16-shims.ts'   // 仅类型

export interface FetchInit {
  method?: string
  headers?: Record<string, string> | Array<[string, string]>
  signal?: AbortSignal
  redirect?: 'follow' | 'manual'
  credentials?: 'include' | 'omit'
  session?: Session
}

export function fetchLike(url: string, init: FetchInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url, method: init.method ?? 'GET',
      // 22 的 ClientRequestConstructorOptions 已支持这四个字段：
      ...(init.session === undefined ? {} : { session: init.session }),
      credentials: init.credentials ?? 'include',
      useSessionCookies: true,
      redirect: init.redirect ?? 'follow',
    })
    for (const [k, v] of toHeaderEntries(init.headers)) request.setHeader(k, v)
    request.on('response', incoming => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item)
      }
      resolve(new Response(
        NULL_BODY_STATUSES.has(incoming.statusCode ?? 0) ? null : nodeReadableToWeb(incoming as unknown as Readable),
        { status: incoming.statusCode ?? 0, headers },
      ))
    })
    request.on('error', reject)
    request.on('abort', () => reject(abortReason(init.signal)))
    if (init.signal?.aborted) { request.abort(); return }
    init.signal?.addEventListener('abort', () => request.abort(), { once: true })
    request.end()
  })
}
```
改造点只有 3 处：`electron-runtime.ts:243`（`request: (url, init) => fetchLike(url, init)`）、`electron-shell-generation.ts:81`（`fetchLike(spec.authenticationUrl, { ...opts, session: renderer.session })`，注意这里**必须**传 `session` 才能带上 renderer 的登录 Cookie，这正是原来 `session.fetch` 的语义）、`host-runtime-bridge.ts:54-58`（只换 `Headers`/`Response` 的构造来源，若按 §八 改架构则不必要）。
> 兼容 44：`desktop-fetch.ts` 里首行判断 `typeof net.fetch === 'function'` 则直接透传 `net.fetch(url, init)`，保证新版本走原路径、零回归。
## 三、`WebContentsView` 的真实用法与 Electron 22 替代设计

### 3.1 现有语义拆解（`compatibility-shell.ts` 全文已逐行读）

`CompatibilityShell` 只在 **isolated 模式**（`electron-shell-generation.ts:321,338-340`，即 `mode !== 'advanced' && platform !== 'linux'`）下创建，它把**一个 BrowserWindow 拆成两个独立 WebContents surface**：

| 语义 | 现有实现（30+） | 22 等价物 |
|---|---|---|
| 两个 surface | 两个 `WebContentsView`，各有独立 `webPreferences`（不同 partition、不同 preload） | 两个 `BrowserView`，构造参数 `BrowserViewConstructorOptions.webPreferences` 完全同构 |
| 层级（chrome 压在 content 上） | `window.contentView.addChildView(content)` 再 `addChildView(chrome)` | `window.addBrowserView(content)` 再 `addBrowserView(chrome)`；需要时 `window.setTopBrowserView(chrome)` |
| 布局 | `content.setBounds({0, FRAME_H, w, h-FRAME_H})`、`chrome.setBounds({0,0,w, expanded?h:min(h,FRAME_H)})`；同尺寸跳过 | `BrowserView.setBounds()` 语义相同（坐标相对窗口内容区原点，与 `contentView` 子视图一致） |
| 透明 | `content.setBackgroundColor('#00000000')`，让原生窗口材质透出（仅 extended + material≠off） | `BrowserView.setBackgroundColor('#00000000')`（22 已有） |
| 命中测试 | chrome 覆盖区域天然吞掉鼠标事件，content 收不到；expanded 时 chrome 覆盖全窗 | 相同：BrowserView 按 z-order 上层优先接收输入 |
| resize 触发 | `window.on('resize'/'enter-full-screen'/'leave-full-screen')` + min/restore 保护 | 事件完全相同，可原样保留 |
| 重绘 | `reveal()` 里对两个 webContents `invalidate()` | `webContents.invalidate()` 22 已有（d.ts:11479） |
| 销毁 | `removeChildView` ×2 → 各自 `webContents.close({waitForBeforeUnload:false})` | `removeBrowserView` ×2 → 同样的 `close()`（22 已有，d.ts:11259） |
| chrome 的受限 IPC | `chrome.ipc.handle(channel, ...)` + `senderFrame.url` 校验 | **原样保留**（22 有 `webContents.ipc`） |
| 导航封锁 | `will-navigate`/`will-redirect`/`will-attach-webview` + `setWindowOpenHandler(deny)` | 全部原样保留 |

**结论：`BrowserView` 能做到语义等价**，因为原代码从不使用 `View` 独有的 30+ 能力（`setBorderRadius`、`setVisible`、`addChildView` 的相对布局体系），所有布局都是绝对 `setBounds`。唯一需要重新设计的是**层级维护时机**与**销毁顺序**。

### 3.2 建议的抽象接口（`src/desktop-view.ts`，双版本单实现）

目标：22 与 30+ 共用同一份调用方代码，能力探测选择实现，避免 `compatibility-shell.ts` 出现 if/else 分支。

```ts
import { BrowserView, WebContentsView, type BrowserWindow, type Rectangle, type WebContents } from 'electron'

/** 一个可布局、可销毁的 web surface（22: BrowserView；30+: WebContentsView）。 */
export interface DesktopSurface {
  readonly webContents: WebContents
  setBounds(bounds: Rectangle): void
  setBackgroundColor(color: string): void
  /** 只解绑，不销毁 webContents。 */
  detach(): void
  /** 解绑 + 关闭 webContents；幂等。 */
  destroy(): void
}

/** 把一个窗口当作 surface 栈：content 在底、chrome 在顶。 */
export interface DesktopSurfaceStack {
  readonly content: DesktopSurface
  readonly chrome: DesktopSurface
  /** 重新把 chrome 提到最上层（22 上是必需的，见 §3.3 坑 1）。 */
  raiseChrome(): void
  dispose(): void
}

export const HAS_VIEW_API: boolean = typeof (WebContentsView as unknown) === 'function'

export function createSurface(window: BrowserWindow, options: Electron.WebPreferences): DesktopSurface
export function createSurfaceStack(window: BrowserWindow, content: Electron.WebPreferences, chrome: Electron.WebPreferences): DesktopSurfaceStack
```

`BrowserView` 实现的关键形状（22 分支）：

```ts
function chromeSurface(window: BrowserWindow, webPreferences: Electron.WebPreferences): DesktopSurface {
  const view = new BrowserView({ webPreferences })
  const contents = view.webContents
  let attached = false
  window.addBrowserView(view); attached = true
  return {
    webContents: contents,
    setBounds: bounds => { if (!window.isDestroyed()) view.setBounds(bounds) },
    setBackgroundColor: color => view.setBackgroundColor(color),
    detach() { if (!attached) return; attached = false; if (!window.isDestroyed()) window.removeBrowserView(view) },
    destroy() {
      this.detach()
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
    },
  }
}
```
30+ 分支把 `addBrowserView` 换成 `window.contentView.addChildView(view)`、`removeBrowserView` 换成 `removeChildView` 即可，其余调用点不动。
### 3.3 必须处理的坑（按踩坑概率排序）

1. **z-order 不会自我维持**。22 的 `addBrowserView` 按调用顺序决定层叠；一旦发生 `removeBrowserView` + 重加、或某些窗口状态（maximize/restore/fullscreen）后的合成层重建，chrome 可能掉到 content 下面（表现为顶栏不可见/不可点）。**规则**：封装 `raiseChrome()`（内部 `window.setTopBrowserView(chrome)`，只能对已 attach 的 view 调用），并在 `attach` 后、`expand/collapse` 切换后、`enter/leave-full-screen` 后、`restore/show` 后各调一次。
2. **销毁顺序**。`removeBrowserView` 在窗口已 destroyed 时抛异常（现有代码先判 `window.isDestroyed()`，保留该判断）。建议把解绑提前到 `window.on('close')`，`dispose()` 只负责关闭 webContents；两处都要幂等。
3. **`setVisible` 在 22 不存在**（beta 用到：`beta/platform-view.ts:178,195`）：22 的替代是「解绑/重绑」或「把 bounds 移出可视区/高度置 0」。注意解绑后 `setTopBrowserView` 会抛错。
4. **`setAutoResize` 不要用**：现有布局是绝对坐标 + 顶部 `DESKTOP_FRAME_HEIGHT` 偏移，`setAutoResize({width,height})` 会让 chrome 也跟随全高，破坏层级语义。
5. **devtools**：对 BrowserView 的 webContents 用 `openDevTools({ mode: 'detach' })`，否则面板会挤占窗口内容区（30+ 的 WebContentsView 也有同样问题，但 22 更明显）。
6. **焦点**：22 的 BrowserView 不自动聚焦，`attach` 后与 `expand` 后需显式 `content.webContents.focus()`；现有 `electron-shell-generation.ts:687` 的 `renderer.focus()` 要保留并在 22 分支补一次。
7. **透明合成**：`setBackgroundColor('#00000000')` 在 22 上生效，但 extended 模式依赖的窗口材质在 Windows 7 上不存在——Win7 必须把 material 强制为 `off`（见 §七 降级 D1）；macOS `vibrancy` + 透传 BrowserView 在 22 已知有重绘残影，若保留 material 建议回退不透明。
8. **最小化/还原后的 stale surface**：`reveal()` 的 `invalidate()` 逻辑必须原样保留（22 上 BrowserView 同样会在最小化时停止合成）。
9. **圆角**：22 的 BrowserView 不裁剪圆角，`roundedCorners: true` 在 Win11 上会出现四角像素溢出；Win7 无圆角，无影响。
10. **窗口 0 尺寸**：`BrowserView.setBounds` 不接受负值/0 宽高之外的异常值；现有 win32 的 `width<=0 || height<=FRAME_H` 保护要保留并同样用于 22。
11. **`contentView` 缺省的起点不同**：30+ 子视图坐标相对 `contentView`（通常等于内容区）；22 的 BrowserView 坐标相对窗口内容区——两者在本项目一致，但**不要**在 22 分支里叠加窗口 frame 尺寸（`getContentSize` 已是内容区）。

### 3.4 迁移步骤（可分批合入，建议顺序）

1. 新增 `src/desktop-view.ts`（§3.2 接口 + 两个实现），先只在 30+ 下用新路径跑通，确认无回归（这步可以在 Electron 44 上完成）。
2. `compatibility-shell.ts` 改为持有 `DesktopSurface`/`DesktopSurfaceStack`，把 `window.contentView.addChildView` → `stack.chrome.raiseChrome()` 等调用替换；`resize()` 里改用 `surface.setBounds`。
3. `dispose()` 改为 `stack.dispose()`，并把解绑挂在 `window.on('close')`。
4. 在 Electron 22 上验证三件事：chrome 可见可点、content 可交互、extended 模式透明（或按 §七 降级为不透明）。
5. 最后再处理 `beta/platform-view.ts`（多了 `setVisible` 语义，见 §九）。

### 3.5 风险评级

| 风险 | 等级 | 说明 |
|---|---|---|
| 双 surface 结构本身 | 低 | 纯 API 平移，语义已逐条对齐 |
| z-order 稳定性 | 中 | 需要显式 `raiseChrome()`，否则偶发“顶栏消失” |
| 透明 + 材质 | 中高 | Win7 无材质必降级；macOS 22 有残影风险 |
| 销毁/崩溃路径 | 中 | 22 的 BrowserView 生命周期与窗口耦合更紧，需保证幂等 |
| 命中测试 | 低 | 绝对坐标 + 上层优先，与现状一致 |
## 四、主进程构建目标（这是最容易被 tsc 漏掉的 P0）

### 4.1 现状（实测，不是推断）

- `dsh-plugin-desktop/package.json`：`"type": "module"`、`"main": "lib/main.js"`、`"engines": {"node": "^22.19.0 || >=24.0.0"}`
- `tsdown.config.ts:38-46`：主进程段 `format: 'esm'`、`platform: 'node'`、**`target: 'es2024'`**
- `tsdown.config.ts:62-77`：preload 段 `format: 'cjs'`、`target: 'es2022'`、`external: ['electron']`、`entryFileNames: '[name].cjs'`（这段已经天然兼容 22）
- `tsconfig.json`：`target: ES2024`、`module: NodeNext`、`moduleResolution: NodeNext`、`verbatimModuleSyntax`、`allowImportingTsExtensions`
- 已构建产物 `lib/main.js` 实测（5128 行）：**42 条 ESM `import`**，首行即 `import { app, crashReporter, dialog, safeStorage, screen, session, shell, utilityProcess } from "electron"`；含 **7 处 `import.meta.url`**；**无顶层 await**；`??=` 9 处；grep 确认**不含** `using`、class static block、`toSorted/toReversed`、`Object.groupBy`、`Promise.withResolvers`、`Array.fromAsync`。

### 4.2 Node 16 能否解析这些语法？

**语法层可以，模块层不行。** 关键在于两点：

1. **Electron 22 不支持主进程 ESM**（28 才引入）。`import ... from "electron"` 在 22 的 ESM 加载器里无法解析 `electron` 内置模块，启动即失败；不是“能跑但告警”，是硬失败。因此 **`format: 'esm'` 必须改 CJS**，这是 P0-1。
2. `target: 'es2024'` 目前产出的语法恰好 Node 16 都能解析（上面 grep 证明），但这是**巧合而非保证**——改成 CJS 时应同时把主进程段 target 降到 `node16`，让 bundler 主动降级，避免未来某次提交引入 Node 18+ 语法而无人发现。

### 4.3 需要的构建改动

```ts
// tsdown.config.ts（主进程段）
{
  entry: { /* 不变 */ },
  outDir: 'lib',
  format: 'cjs',              // ① 22 主进程只能是 CJS
  platform: 'node',
  target: 'node16',           // ② 主动降级到 Node 16.17
  fixedExtension: true,       // ③ type:module 下 CJS 必须是 .cjs，且 chunk 也要带扩展名
  dts: false,
  clean: false,
  sourcemap: true,
  outputOptions: {
    entryFileNames: '[name].cjs',
    chunkFileNames: '[name]-[hash].cjs',
    // ④ CJS 里没有 import.meta.url：注入等价物
    banner: 'const __dshImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  define: { 'import.meta.url': '__dshImportMetaUrl' },   // ⑤ 源码里的 11 处 import.meta.url 由 bundler 替换
}
```

配套改动：

- `package.json`：`"main": "lib/main.cjs"`；`engines.node` 放宽到 `">=16.17.0"`（仅提示作用）；`peerDependencies.electron` 改 `">=22.3.27 <45"`
- `tsconfig.json`：`target`/`lib` 降为 `ES2022`（保留 `lib: ["ES2022","DOM","DOM.Iterable"]`，因为 `fetch`/`Response` 的**类型**还在用）；`module` 保持 `NodeNext` 只影响类型检查，产物由 tsdown 决定
- `src/packaged-runtime-smoke.ts:236-237` 有两行**顶层 await**（`await verifyBundledSkills(...)`、`await smokeSessionMigration()`），CJS 下是语法错误：包进 `async function main(){...}; void main()` 
- `preload` 段不用动（已 CJS + es2022）；但 `preload.ts` 若按 §1.2(d) 改成 `require`，需保持 `external: ['electron']`
- `lib/` 目录里已提交的旧产物（`main.js` 等 ESM 文件）在切换后必须重建；`tsdown clean: false`，故切换时建议先 `scripts/clean.mjs` 避免新旧混存

### 4.4 与 Electron 22 的额外交互

- Electron 22 的 `app.asar` 加载 CJS 入口无问题；`type: "module"` + `.cjs` 扩展名也不会被 asar 影响。
- 若**不改** ESM 而想“在 22 上跑”，唯一途径是把主进程代码打进 Host（utilityProcess）或让宿主用 CJS 包装器 `createRequire` 加载——但 utilityProcess 在 22 同为 Node 16 且同样不支持 ESM，等于把问题挪走而非解决，不推荐。
## 五、打包期脚本对 Electron 版本的假设

| 脚本 | 22 下的问题 | 结论 |
|---|---|---|
| `package.json` → `build.electronFuses` | 配置里有 **`resetAdHocDarwinSignature: true`**，这是 Electron 22 **不存在**的 fuse（22 只有 7 个 fuse，含 `enableEmbeddedAsarIntegrityValidation`、`onlyLoadAppFromAsar`，无 resetAdHoc） | **P0：必须从 22 分支的配置里删除该键**，否则 electron-builder 调 `@electron/fuses` 时对 22 二进制找不到对应索引而失败（mac 打包必炸；Windows 是否触发取决于 electron-builder 平台分支，风险不可接受） |
| `scripts/package-win.ts:198` | 只覆盖 `--config.electronFuses.onlyLoadAppFromAsar=false`，其余 fuse 仍按 base 配置全量应用 → 同上被 `resetAdHocDarwinSignature` 污染 | 同 P0-13；建议 22 分支把 base 配置改成只留 `runAsNode`/`enableEmbeddedAsarIntegrityValidation`（+ 按需 `onlyLoadAppFromAsar`） |
| `scripts/verify-electron-fuses.ts:68-79` | 只校验 `RunAsNode`、`EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar` 三个 fuse；**这三项 22 都有**，`getCurrentFuseWire` 读 22 的 wire 也正常 | **无需改动**（但请在 22 上跑一次确认 wire 读取不因项数少而报错） |
| `scripts/package-dir.mjs:14` | `electronDist = resolve(dirname(require.resolve('electron/package.json')), 'dist')`：22 的 npm 包结构与 44 相同 | **无需改动** |
| `scripts/prepare-fs-ext.ts` | 通过 node-gyp 的 `config.gypi` 里 `node_module_version` **自动**读 ABI（`readBuiltAbi`，:167-180），22 会得到 **110**，无需硬编码；Windows 明确不需要 fs-ext（:69、:212） | Windows **无需改动**；mac/Linux 需保证 `--target=22.3.27` 与 `--dist-url` 指向 electron 22 headers |
| `scripts/verify-packaged-runtime.ts:200-210` | `REQUIRED_POSIX_FS_EXT_ENTRIES` 硬编码 **`electron.abi149.node`**；Electron 22 的 ABI 是 **110** → mac/Linux 校验必失败 | **P1（仅 mac/Linux）**：改为 `electron.abi110.node`，更好的做法是从 `node_modules/electron/package.json` 版本映射 ABI 后拼文件名 |
| `scripts/verify-packaged-runtime.ts`（其余） | 断言的是 asar 目录结构、unpacked 白名单、node-pty/ripgrep 预编译产物、安装器 PE 头——均与 Electron 版本无关；`node-pty` 走 `prebuilds/win32-x64/*.node`（N-API），**不受 ABI 110 影响** | **无需改动** |
| `scripts/prepare-runtime.ts` | 只准备 Python / Node / pnpm 的 `primary-runtime` payload（`desktopRuntimeTargets`、`primaryRuntimeDirectory`），与 Electron 版本无关 | **无需改动**；而且它正是 §八 方案(a) 的落地基础（随包已有 Node 22） |
| `scripts/verify-win-installer.ts` | 只做 PE 头校验 + `DSH-Desktop-<version>-x64-Setup.exe` 文件名匹配，不涉及 Electron 版本 | **无需改动** |
| `scripts/verify-loader-boot.mjs:78`、`verify-profile-boot.mjs:160`、`verify-cli-runtime.mjs:22` | 从 `node_modules/electron/package.json` 读版本后启动对应二进制，属于通用逻辑 | **无需改动**（会在 22 上真实启动，正好作为回归门） |
| `scripts/package-win.ts:171-185` 前置门禁 | 会跑 `check:win-package`，其中包含 `npmRebuild=false` 下的原生模块断言与 `verify-packaged-runtime` | 需先完成 P0 清单，否则门禁失败是“预期结果”而非新问题 |

补充两点 Windows 7 相关：

- electron-builder 26.15 的 NSIS 默认仍支持 Win7，但建议显式 `nsis.minimumSystemVersion: "6.1"`，并避免使用 Win10+ 才有的 `oneClick` DPI 相关选项。
- Electron 22 是**最后支持 Win7/8.1 的 Electron 大版本**（23 起放弃），所以 22.3.27 是正确且唯一的目标；Chromium 108 也是最后一个支持 Win7 的引擎版本，渲染侧无需再降。
## 六、分级实施清单

格式：`级别 | file:line | 改动 | 理由`。P0 = 不改进不了编译/启动；P1 = 功能降级可接受；P2 = 可选美化。

### P0（21 条）

```
P0 | tsdown.config.ts:39-41 | 主进程段 format:'cjs'、target:'node16'、输出 .cjs（含 chunk）、define import.meta.url | Electron 22 无主进程 ESM，产物首行 import 'electron' 即失败
P0 | package.json:main/type/engines | main 改 lib/main.cjs；engines 放宽 >=16.17；peerDependencies.electron 改范围 | 配合上一条；否则 asar 入口仍是 ESM
P0 | src/packaged-runtime-smoke.ts:236-237 | 顶层 await 包进 async main() | CJS 下顶层 await 是语法错误
P0 | src/compatibility-shell.ts:1,16,20,41,48 | WebContentsView → 经 src/desktop-view.ts 的 BrowserView 实现 | 22 无 WebContentsView（d.ts 确认）
P0 | src/compatibility-shell.ts:62,63,213,214 | contentView.addChildView/removeChildView → addBrowserView/setTopBrowserView/removeBrowserView | 22 无 BrowserWindow.contentView
P0 | src/electron-shell-generation.ts:598,646 | will-frame-navigate → will-navigate（签名同步改） | 22 无 will-frame-navigate
P0 | src/electron-shell-generation.ts:516 | Event<WebContentsWillFrameNavigateEventParams> → Electron.Event & {url,isMainFrame} | 22 的 Event 非泛型、无该 Params 类型
P0 | src/electron-shell-generation.ts:130,132 | WebFrameMain.detached → frameAlive() 探针（可选读 + try/catch） | 22 的 WebFrameMain 无 detached
P0 | src/electron-runtime.ts:243 | net.fetch → src/desktop-fetch.ts 的 fetchLike()（44 上透传 net.fetch） | 22 的 Net 只有 request/isOnline/online
P0 | src/electron-shell-generation.ts:81,88,90,93 | session.fetch → fetchLike(url,{session:renderer.session,...}) | 22 的 Session 无 fetch；必须带 session 才有登录 Cookie 语义
P0 | src/electron-runtime.ts:118,134,145,148 | new Headers/new Response/Readable.toWeb → 自带 shim | Node 16 无 Headers/Response 全局，无 Readable.toWeb
P0 | src/main.ts:333 | getSelectedStorageBackend → Linux 保守判定（D-Bus/--password-store） | 22 的 SafeStorage 无该方法
P0 | src/preload.ts:3,19 | 命名 import webUtils → electron.webUtils?.getPathForFile + File.path 回退 | 22 无 webUtils（29+ 才有）
P0 | src/renderer-logging.ts:14-17 | console-message 回调事件类型放宽为 Event & {message?,level?} | 22 的 Event 无 message/level（仅类型冲突）
P0 | src/desktop-dialog-window.ts:238 | options.type 经 dialogType() 窄化 | 22 的 MessageBoxOptions.type 是宽 string，不可赋给窄联合
P0 | src/module-resolution.ts:21 | import.meta.resolve → createRequire(import.meta.url).resolve + pathToFileURL | Node 16 无 import.meta.resolve；且在模块顶层，main 的 import 链会立即执行
P0 | src/desktop-office.ts:88 | 同上 | 同上（插件装载期执行）
P0 | src/profile.ts:1617,1983,1989 / setup-wizard-settings.ts:358,508,550,593 / profile-context.ts:58 | structuredClone → cloneDeep(v8.serialize 往返) | Node 16 无 structuredClone；这些路径由 main.ts 直接引用
P0 | src/platform-login-window.ts:83 | AbortSignal.timeout → timeoutSignal() | Node 16.17 无 AbortSignal.timeout
P0 | package.json build.electronFuses | 删除 resetAdHocDarwinSignature，只留 RunAsNode/EnableEmbeddedAsarIntegrityValidation（Windows 另设 OnlyLoadAppFromAsar=false） | Electron 22 只有 7 个 fuse，无该键；否则打包失败
P0 | src/host-process.ts:49 + src/host-process-entry.ts:18 | utilityProcess(Node 16) → child_process.spawn 随包 primary-runtime 的 Node 22 + IPC 改造 | Host 装载 engines ^22.19 的整棵 harness，Node 16 上必然失败（详见 §八）
```

### P1（9 条）

```
P1 | src/module-resolution.ts:256 / src/package-overlay.ts:119 / src/profile.ts:1387 | URL.canParse → canParseUrl() | Node 16.17 无 URL.canParse（18.17）
P1 | src/profile.ts:549,901 | Array.findLastIndex → 倒序循环 | Node 16 无 findLastIndex（18）
P1 | scripts/verify-packaged-runtime.ts:203-208 | electron.abi149.node → electron.abi110.node（或按 electron 版本推导） | ABI 110；仅影响 mac/Linux 校验
P1 | src/electron-runtime.ts:162 | 读 signal.reason 前加存在性判断 | Node 16.17 无 AbortSignal.reason（17.2）
P1 | src/window-options.ts:140 / src/auxiliary-window-options.ts:36 | Win7 走自绘窗口按钮 + 主进程 IPC（window.minimize/maximize/close） | titleBarOverlay 仅 Win10+，Win7 无原生最小化/最大化/关闭
P1 | src/window-options.ts:125-133 + 窗口材质解析 | Win7 强制 material='off'（os.release() 判定） | Win7 无 DWM Mica/Acrylic，透明确保不出现全黑/残影
P1 | src/update-checker.ts:215 | defaultRequest 改为 fetchLike 或显式抛错 | Node 16 无全局 fetch；避免静默运行时错误
P1 | src/electron-shell-generation.ts:687 + desktop-view 迁移后 | attach/expand 后显式 content.webContents.focus()；devtools 用 mode:'detach' | 22 的 BrowserView 不自动聚焦、内嵌 devtools 会挤占内容区
P1 | macOS: compatibility-shell.ts:59-61 | 保留 material 时回退不透明（22 的 vibrancy+BrowserView 有残影） | 外观降级换稳定
```

### P2（4 条）

```
P2 | src/window-options.ts:146 / src/auxiliary-window-options.ts:42 | roundedCorners 在 Win7/无 DWM 下无效果，可保留（无需改） | 纯外观
P2 | src/window-options.ts:138,145,147 | autoHideMenuBar/hasShadow/thickFrame 在 Win7 表现差异，按需微调 | 纯外观
P2 | src/notifications.ts + Win 通知路径 | Win7 无 Toast API，降级为 Tray 气泡或应用内提示 | 通知能力降级
P2 | src/desktop-view.ts 新增文件 | BrowserView 不裁剪圆角，Win11 上四角可能溢出 | 纯外观
```

### 工作量与文件数

| 项 | 文件数 | 估时 |
|---|---|---|
| 构建切 CJS（tsdown/package.json/tsconfig/smoke 顶层 await） | 4 | 0.5 人日 |
| `desktop-view.ts` 抽象 + `compatibility-shell.ts` 迁移 | 2（+1 新增） | 1.5 人日 |
| `desktop-fetch.ts` + net/session fetch 适配（含 Cookie/重定向/abort 验证） | 1（+1 新增）+ 3 调用点 | 1 人日 |
| Node 16 shim（structuredClone/timeout/canParse/findLastIndex/toWeb/Headers/Response） | 1（+1 新增）+ 8 文件 | 0.5 人日 |
| Electron API 小改（har/事件/IPC/窄化/safeStorage/webUtils） | 6 | 0.5 人日 |
| 打包与校验（fuses/ABI/门禁） | 2 | 0.5 人日 |
| 架构改造 utilityProcess → spawn Node 22（host-process + host-process-entry + 生命周期/日志/退出码） | 2 | 1.5–2 人日 |
| **合计（主进程/Node 侧，desktop 插件）** | **约 20 个既有文件 + 3 个新文件** | **约 6–7 人日**（不含 beta 变体、不含渲染侧 Chromium 108 适配） |

> 若不做架构改造（保留 utilityProcess），则还需把整棵 harness 降到 Node 16 —— 不可行，故 P0-21 是必选项。
## 七、无法在 Electron 22 上实现、必须降级/关闭的功能

| # | 功能 | 现状位置 | 22/Win7 上的处理 | 影响 |
|---|---|---|---|---|
| D1 | 原生窗口材质（Mica/Acrylic/vibrancy 透出） | `window-options.ts:125-133`（macOS `vibrancy`）、extended 模式 `material!=='off'` | Win7 强制 `material='off'`，窗口用不透明底色 `#202124`；macOS 建议保留 vibrancy 但 content 不透传 | 外观损失，功能无损 |
| D2 | 原生标题栏按钮覆盖层（titleBarOverlay） | `window-options.ts:140`、`auxiliary-window-options.ts:36` | Win7 无原生覆盖层 → 由 chrome surface 自绘最小化/最大化/关闭并 IPC 到主进程 | 必须补 UI，否则 Win7 无法最小化/关闭 |
| D3 | 窗口圆角（roundedCorners 真正生效） | `window-options.ts:146` | Win7 无 DWM 圆角；保留选项即可 | 纯外观 |
| D4 | Windows 通知（Toast） | `notifications.ts`（`Notification` 路径） | Win7 无 Toast API → 降级 Tray 气泡或应用内提示 | 通知能力降级 |
| D5 | 主进程 ESM | `tsdown.config.ts:39` | 不能保留：必须 CJS | 无功能影响，仅构建形态 |
| D6 | Host 跑在 Electron 自带 Node（utilityProcess） | `host-process.ts:49` | 不能保留：必须改用随包 Node 22 子进程（§八） | 影响启动方式，不影响功能 |
| D7 | `webUtils.getPathForFile` 的精确路径语义 | `preload.ts:19` | 用 `File.path` 回退；Electron 22 上语义等价（32 才移除） | 无实际损失 |
| D8 | `session.fetch` 的 Chromium 原生 fetch 语义 | `electron-shell-generation.ts:81` | 用 `net.request` 适配（同为 Chromium 网络栈，代理/证书一致）；不保留 `Response.url` 语义（现代码本就没依赖） | 无实际损失 |
| D9 | Linux `safeStorage` 后端精确识别 | `main.ts:333` | 保守判定，最坏每次重建 LAN HTTPS CA | 仅 Linux，且可接受 |
| D10 | 内嵌 devtools 面板布局 | `developerTools` 动作 | 22 建议 `mode:'detach'` | 交互变化 |

> **不需要**降级但需要“改写”的：WebContentsView → BrowserView（等价）、will-frame-navigate → will-navigate（等价）、webContents.ipc（22 已有，零改动）。

## 八、项目级架构风险：`utilityProcess` = Node 16（必须优先决策）

**事实链（已核对代码）**

1. `src/host-process.ts:49`：`utilityProcess.fork('./host-process-entry.js', [], {...})` —— Host 是 Electron 的 utilityProcess。
2. Electron 22 的 utilityProcess 使用**Electron 自带的 Node 16.17.1**（不是系统的 Node）。
3. `src/host-process-entry.ts:2-13` 直接 import 了 `@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-http-proxy`、`@deepseek-ai/dsh-launch-environment`，随后 `bootDesktopHost(...)` 挂载**整棵 harness 与全部插件**。
4. 该 harness 的 `engines.node` 是 `^22.19.0 || >=24.0.0`。

**结论**：即使把 desktop 插件本身全部改成 Node 16 兼容，Host 里的 harness 依然跑不起来。这超过了“插件移植”的范畴，是**运行时选型**问题。

**推荐方案 (a)：Host 不再用 utilityProcess，改用随包已有的 Node 22**

- 仓库已通过 `scripts/prepare-runtime.ts` 准备 `<resources>/runtime/<arch>/primary-runtime/node`（Node 22），这是现成条件。
- 改动集中在两个文件：
  - `host-process.ts`：`utilityProcess.fork(file, args, {stdio:'pipe', env})` → `spawn(nodeExe, [file], { stdio: ['ignore','pipe','pipe','ipc'], env })`，`child.postMessage` → `child.send`，`child.on('message')` → `child.on('message')`（语义一致），`child.kill()` 保留；`child.pid`/`stdout`/`stderr` 保持不变。
  - `host-process-entry.ts`：`process.parentPort` → `process.on('message')` + `process.send`；`HostRpc` 的 `send/listen` 只需换实现（该类已是可注入设计，:20-27）。
- 生命周期风险点：Electron 的 utilityProcess 有 `exit` 事件与 `pid`，`child_process` 同样有；但 **`utilityProcess` 的崩溃不会触发 `uncaughtException`**，而 `child_process` 需要显式处理 `error` 事件与 stdio 背压（现有 `createProcessOutputLogging` 已处理 stdout/stderr 管道）。
- 附带好处：这条路径同时解决 P0-1 中的 Host 侧 ESM 约束（Node 22 原生支持 ESM），把 Node 16 的适配面压缩到 **Electron 主进程 + preload** 两个地方。

**备选方案 (b)**：保留 utilityProcess，但把 Host 换成“只做 RPC 转发”的薄壳，真正 harness 由 `spawn` 的 Node 22 承担 —— 多一层转发，收益不如 (a) 直接。

**方案 (c)**（不推荐）：把 harness 降级到 Node 16 —— 工作量与风险都远超项目目标。
## 九、`dsh-plugin-desktop-beta` 变体差异（同一批改动 + 额外项）

beta 与 stable **共享同一套 Electron 22 阻塞点**（ESM 主进程、WebContentsView、net.fetch、webUtils、Node 16 全局、fuses 配置），但**面更宽**，需要额外处理：

| # | 位置 | 差异 | 处理 |
|---|---|---|---|
| B1 | `beta/package.json` | 与 stable 一样：`type=module`、`main=lib/main.js`、`engines ^22.19`、`build.electronFuses.resetAdHocDarwinSignature=true` | 与 P0-1/P0-2/P0-20 完全相同 |
| B2 | `beta/tsdown.config.ts:13` | 主进程段同样 `format:'esm'`、`target:'es2024'` | 同 P0-1（且 beta 的 `deps.neverBundle` 语法与 stable 的 `external` 不同，改 CJS 时注意） |
| B3 | `beta/tsdown.config.ts:17-22` | preload 段 `format:'cjs'` 但 **`target:'es2024'`**（stable 是 `es2022`） | 降到 `node16`/`chrome108`；沙箱 preload 在 Chromium 108 上跑，ES2024 语法无保证 |
| B4 | `beta/platform-view.ts:8,46,152` | `WebContentsView` + `View` 类型；`owner.contentView.addChildView`（:179）/`removeChildView`（:234） | 同 §3 抽象；**额外**：`:178,195` 的 `view.setVisible(false/true)` 在 22 不存在 → 用「解绑/重绑」或「bounds 移出可视区」实现 |
| B5 | `beta/main.ts:250` | `request: (url, init) => net.fetch(url, {...init, credentials:'omit'})` | 换 `fetchLike(..., { credentials:'omit' })` |
| B6 | `beta/main.ts:115,1211` | `protocol.registerSchemesAsPrivileged` + **`protocol.handle('dsh-app', ...)`**（Electron 25+），handler 返回 `Response`（:1218,1222,1332） | 22 上退回 `protocol.registerFileProtocol` / `registerStreamProtocol`，把 `Response` 改成 `{ mimeType, data }` 或 Node 流；或把该路由改为 loopback HTTP（beta 已有 webserver，改造面可控） |
| B7 | `beta/web-document.ts`（全程 `new Response`/`new Headers`，:64-168）、`beta/webserver.ts:75`、`beta/browser-sessions.ts:72,74`、`beta/update-transport.ts:73,96,104,107` | 大量依赖 Web 全局 + `Readable.toWeb`（:107） | 与 §2.2/§2.3 共用 shim；这些模块若跑在主进程，全部受 Node 16 约束 |
| B8 | `beta/updates.ts:95,140` | `AbortSignal.any([signal, AbortSignal.timeout(...)])` —— Node 20.3 / 17.3 才有，**两项都缺** | 合并 controller（§2.2）+ `timeoutSignal` |
| B9 | `beta/platform-login-window.ts:39,67`、`beta/browser-guests.ts:157,167`、`beta/platform-view.ts:160,169` | `URL.canParse` | `canParseUrl()` |
| B10 | `beta/host/office.ts:53` | `import.meta.resolve` | `createRequire().resolve` |
| B11 | `beta/preload-app.ts:2,65` | `webUtils.getPathForFile` | 同 §1.2(d) |
| B12 | `beta/scripts/verify-fuses.ts`、`beta/scripts/package.ts`、`beta/scripts/packaging-builder.mjs` | beta 用自己的一套打包脚本（`package.ts` 分发到 mac/win/linux），fuse 期望值需按 22 的 7 个 fuse 重新核对 | 与 §5 同源问题；建议抽公共 `electron-fuse-policy.ts` |
| B13 | `beta/scripts/verify-window-controls.mjs`（991 行）、`verify-sidebar-browser*.mjs` | 以 Electron 真实启动做 UI 断言；`titleBarOverlay` 相关断言在 Win7 上会因无原生覆盖层而不成立 | 增加平台/版本条件，或只作 Win10+ 门禁 |

**关于一处误报的更正**：`beta/update-installer.ts:22` 的 `win.contentView` 是 **JXA 脚本里的 `NSWindow.contentView`**（`osascript -l JavaScript` 字符串内，见 :12-39），与 Electron API 无关，**不需要改**。我最初按文件名扫描时误列入，已修正。

**变体策略建议**：stable 与 beta 的主进程差异集中在 §3/§2 的同一批抽象（surface、fetch、shims）。建议把三件东西抽成 **stable/beta 共用的内部包或目录**（如 `desktop-native-compat/`），否则两份实现会立刻漂移。

## 十、复核清单（改完后怎么证明没漏）

1. **类型层**：`tsc -p tsconfig.json --noEmit`（pin electron 22.3.27）应 0 错误；再用 Lead 的 21 条错误表逐条对照关闭。
2. **构建层**：`node scripts/clean.mjs && tsdown` 后确认 `lib/main.cjs` 存在、`lib/main.js` 不再被 `package.json` 引用；`grep -c 'import ' lib/main.cjs` 中不应再有 ESM `import`（`require` 除外）。
3. **语法层**：用 Node 16.17 直接 `node --check lib/main.cjs`，以及 `node -e "require('./lib/main.cjs')"` 至少验证可加载（会因无 Electron 环境失败，但不应是语法错误）。
4. **API 层**：在 Electron 22.3.27 真实启动一次：窗口出现 → chrome 顶栏可点 → content 可交互 → 关闭无崩溃 → `render-process-gone` 后恢复一次。
5. **运行期全局**：启动后立即检查 `typeof Headers/Response/Readable`、`typeof structuredClone` 是否都有定义（shim 生效证据）。
6. **更新链路**：手动触发一次版本检查（走 `fetchLike`），确认有响应、有 body 流、可取消。
7. **打包**：`node scripts/package-win.ts` 走完并用 `verify-electron-fuses`、`verify-win-installer` 复验；`verify-packaged-runtime` 在 Windows 上应通过（无 fs-ext 断言）。
8. **架构**（若采纳 §八 方案(a)）：确认 Host 由随包 Node 22 启动（`process.versions.node` 打点为 22.x），且崩溃/重启/优雅退出三条路径都复现原有日志与退出码。

## 十一、审计方法与证据索引

- Electron 22 判据：`dsh-plugin-desktop/node_modules/electron/electron.d.ts`（22.3.27），关键行号已在 §1 表内标注（如 `readonly ipc: IpcMain` @11897、`Net` @6131、`BrowserView` @1675、`WebFrameMain` @12130）。
- 构建产物证据：`dsh-plugin-desktop/lib/main.js`（5128 行，42 条 ESM import、7 处 `import.meta.url`、无顶层 await、无 ES2024 独有语法）。
- 代码位置：全部来自当前工作区文件（行号可直接跳转）；beta 侧同样核对到行。
- 未完成/未覆盖：运行期实测（本审计只读，未启动 Electron 22）；渲染侧 Chromium 108 适配由 Lead 的另一路审计覆盖（`.win7/audit-renderer108.md`、`.win7/rg-renderer-apis.txt`）。