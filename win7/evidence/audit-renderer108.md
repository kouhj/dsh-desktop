# 渲染层 Chromium 108 兼容审计（Electron 22 / Windows 7 SP1）

> 审计对象：DSH Desktop 渲染层。基线：Electron 22.3.27 = Chromium **108.0.5359.215** / V8 10.8.168.25 / Node 16.17.1（https://releases.electronjs.org/release/v22.3.27）。
> 工作区 `/home/james/src/dsh_win7`（fork `kouhj/dsh-desktop`）。本次只读，未改任何源码；报告落在 `.win7/`。
> 方法：远程 `rg`/`sed` 全量扫描 + 单文件精读 + 上游文档核对。**未能** `yarn install`（仓库无 `node_modules`），故无法反编译已构建产物；每条都标了「已核对」/「需构建复核」。

---

## 0. 结论摘要（TL;DR）

1. **渲染层不是单一 bundle，而是三段**：①`dsh-plugin-desktop/src/client/**`（插件工厂 `client.js`，注入到 Web 渲染器）；②`dsh-plugin-desktop/src/native-ui/**`（6 个独立 `BrowserWindow` 页面：onboarding/setup wizard/dialog/recovery/profile-*）；③**上游预构建的 `@deepseek-ai/dsh-web-frontend` dist**（`deepseek-harness/apps/web` 构建产物，随 `vendor/dsh-runtime/0.2.1-rc.3/*.tgz` 发行）。第③段才是主界面，它**不在本仓库源码里构建**，这是本项目的结构性阻塞点。
2. **P0 共 4 类（6 处根因）**：
   - `Promise.withResolvers`（Chromium 119+）：上游渲染层**非测试代码 18 处**运行时调用 + `injections.ts:86` 的 boot gate。Chromium 108 上直接 `TypeError`：审批流、追问、会话提交、轨迹、模型设置等核心交互会抛错；**beta/next 变体更会因此 boot 失败**（`web-document.ts:24`）。
   - `AbortSignal.any`（Chromium 116+）：**19 处**。文档预览、workspace 导航、插件管理、文件拖拽的取消链路会抛 `TypeError`。
   - `Array.prototype.toSorted`（Chromium 110+）：**3 处**（模型选择、定时任务页、模型设置）。
   - `@scope`（Chromium 118+）：`vite.client.config.ts:21` 把整份 onboarding Tailwind CSS 包进 `@scope` → 108 上**整段样式被丢弃**，首启 onboarding 完全无样式。
3. **CSS 是系统性风险**：Tailwind 4.3.3 官方基线是 Chrome 111+/Safari 16.4+；本仓库 `src/native-ui/shared/theme.css:27-63` 直接写 `oklch()`，build 后全量 `oklch`/`color-mix`/`@property` 不会被降级（`@tailwindcss/vite` 内部 `optimize()` 不传 targets；`vite.client.config.ts` 还 `minify:false`，等于零降级）。上游 CSS 另有 **100 处 `color-mix()`（71 处含 `var()`）**。
4. **构建目标全线偏新**：desktop client `es2022`、desktop native-ui **未设置**（Vite 8 默认 Chrome 111 baseline）、上游 `apps/web` `es2022`、客户端插件 `tsdown.client.ts` browser 面 `es2024`；`tsconfig.base.client.json` 用 `lib: ES2024`。语法层大多能靠 `build.target:'chrome108'` 解决，但**运行时 API 必须 polyfill**。
5. **最小 polyfill 只需 3 个 API**（`Promise.withResolvers`、`AbortSignal.any`、`Array.prototype.toSorted`，约 1.5–2KB min / <1KB gzip），注入点已定位：`ctx.webServer.tapIndex()` 或 `webserver/index-inject` 行（`packages/host/webserver/src/injections.ts`），**必须在 boot gate 之前**。
6. **不建议** `@vitejs/plugin-legacy`/Babel：Chromium 108 是 ES2022 级别，legacy 只会引入 `regenerator` 与体积负担。唯一的语法例外是 `using` 声明（见 §5.1）。
7. 依赖侧没有“编译器级硬门槛”，只有 Tailwind 4 的浏览器基线问题；`@base-ui/react@1.7.0`、`lexical@0.49.0` 都未声明浏览器基线，需构建后实测（§7）。

---

## 1. 审计范围与文件清单

| 段 | 路径 | 构建方式 |
|---|---|---|
| A. client 插件 | `dsh-plugin-desktop/src/client/**`（34 文件）+ `src/preload.ts`、`src/compatibility-preload.ts` | `vite build -c vite.client.config.ts` → `lib/client.js`（CJS + `__ModuleLoader__` 工厂，`minify:false`，external: react/react-dom/`@deepseek-ai/*`） |
| B. native-ui 页面 | `dsh-plugin-desktop/src/native-ui/**`（6 个 html + `shared/theme.css` + `components/ui/*`） | `vite build -c vite.native-ui.config.ts` → `lib/native-ui/`，Tailwind 4 via `@tailwindcss/vite` |
| C. 主渲染器 | `deepseek-harness/apps/web`（入口 `index.html` + `src/main.ts`）+ `deepseek-harness/packages/client/**`（约 60 个 client 包） | 上游 `vite build` → `dist`；以 `@deepseek-ai/dsh-web-frontend` 发布，再被打进 `vendor/dsh-runtime/*.tgz` |
| D. beta/next | `dsh-plugin-desktop-beta/`、`dsh-desktop-next/`（client 配置 re-export A；有自己的 `web-document.ts`、`theme.css`、`preload-app.ts`） | 同 A/B，另有 `scripts/package.ts` |

主进程侧（`src/main.ts` 等）不在本报告范围，只做交叉引用。

---

## 2. 渲染层如何启动（定位注入点用）

- 稳定版桌面：`BrowserWindow.loadURL(loopback)`（`dsh-plugin-desktop/src/electron-shell-generation.ts:684-685`）→ 上游 WebServer 提供 `dist/index.html`（`packages/bundle/web-app/src/index.ts:206` `FrontendStatic`）→ 每次请求执行
  `renderIndexInjections(html, rows)`（`packages/host/webserver/src/index.ts:739`）。
- 注入行类型：`{kind:'global'|'script'|'script-src'|'script-preload'|'style'|'html'}`，`head`/`body` 两个位置，见 `packages/host/webserver/src/injections.ts:15-31`。
- **boot gate**：`injections.ts:86`
  `const READY_MARKUP = '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'`，追加在所有 body 行之后。
- 前端消费：`apps/web/src/main.ts:22-35`（Desktop 分支 `gate` 缺失直接 `throw new Error('desktop web: boot readiness is missing')`）、`packages/client/web/src/boot.ts:57`（可选链等待）。
- `tapIndex(transform)`（`webserver/src/index.ts:519`）在行渲染**之后**执行原始 HTML 变换 —— 这是**无需改 vendor 包**的 polyfill 注入点。

---

## 3. JS 语言 / 内置对象缺失（P0 主体）

扫描口径：`deepseek-harness/{apps/web/src,packages/client,apps/desktop/renderer}` + `dsh-plugin-desktop/src/{client,native-ui}`，排除 `tests/`、`*.spec.*`、`*.test.*`。

| API | Chromium 108 | 命中（非测试） | 位置 |
|---|---|---|---|
| `Promise.withResolvers` | ❌ 119 | **18**（client 插件 16 + 上游 desktop renderer 2）+ boot 2 | 见下表 3.1 |
| `AbortSignal.any` | ❌ 116 | **19** | 见下表 3.2 |
| `Array.prototype.toSorted` | ❌ 110 | **3** | `ui-model-selection/src/client/provider-order.ts:9`、`ui-schedule/src/client/TaskManagerPage.tsx:92`、`ui-settings-models/src/client/store.ts:73` |
| `Array.prototype.toReversed/toSpliced/.with` | ❌ 110 | **0** | — |
| `Object.groupBy`/`Map.groupBy` | ❌ 117 | **0** | — |
| `Array.fromAsync` | ❌ 121 | **0** | — |
| `Set.prototype.union/intersection/difference/symmetricDifference` | ❌ 122 | **0**（`z.union` 是 schemastery，非 Set） | — |
| `String.prototype.isWellFormed/toWellFormed` | ❌ 111 | **0** | — |
| `Uint8Array.fromBase64/toBase64/fromHex` | ❌ 130+ | **0** | — |
| `RegExp` `v` flag / `unicodeSets` | ❌ 112 | **0**（`new RegExp` 91 处均为 `g/u/gu` 等旧 flag） | — |
| `using` / `await using` 声明（显式资源管理） | ❌ 134 | **1** | `ui-trajectory/src/index.ts:115` `using _cancellation = addAbortListener(...)` |
| 装饰器（legacy TS） | 需转译 | 2（`@Remote`） | `packages/client/file-upload/src/index.ts:112`、`ui-plugin-manager/src/index.ts:50` |
| `structuredClone` | ✅ 98 | 2（renderer） | `ui-settings/src/client/config-form.ts:130`、`ui-settings-models/src/client/ProviderEditor.tsx:121`（含 `{transfer}` 也在 98+） |
| `AbortSignal.timeout` | ✅ 103 | 1（main process） | `dsh-desktop-next/src/updates.ts:95`（Node 侧问题，交给主进程审计） |
| `Intl.*` | ✅ | DateTimeFormat 46 / Collator 4 / Segmenter 3（87+）/ NumberFormat 2 | 无 `Intl.DurationFormat`（129） |

### 3.1 `Promise.withResolvers` 运行时调用点（18，全部会抛 TypeError）

```
packages/client/ui-approval/src/client/contract/slots.ts:119
packages/client/ui-approval/src/client/index.ts:56
packages/client/ui-user-questions/src/client/contract/slots.ts:177
packages/client/ui-user-questions/src/client/index.ts:236
packages/client/ui-sidebar-documentpreview/src/client/pdf/runtime.ts:22,23,79
packages/client/ui-trajectory/src/index.ts:110,121
packages/client/ui-conversation/src/client/service.ts:282
packages/client/ui-agent-preset/src/client/section-store.ts:103
packages/client/ui-agent-preset/src/client/seat-store.ts:232
packages/client/ui-settings-models/src/client/store.ts:219
packages/client/product-analytics/src/index.ts:76,84
packages/client/product-analytics/src/environment-query.ts:28
```
影响：审批弹窗（agent 工具审批）、追问（user-questions）、消息提交确认、轨迹更新、agent preset、模型设置保存、埋点 —— 都是**主路径**，一抛错即该交互不可用（多数还在 React 事件/effect 内，会导致错误边界或静默失败）。
另有 boot 侧：`packages/host/webserver/src/injections.ts:86`、`apps/desktop/renderer/mandatory-update-frame.js:8,36`、`dsh-plugin-desktop-beta|dsh-desktop-next/src/web-document.ts:24`。
注：`apps/desktop/renderer/*` 属于上游 Desktop 独立产品，本产品未打包（`rg mandatory-update dsh-plugin-desktop/src` = 0），列为参考。

**严重度区分**：稳定版主窗口 `apps/web/src/main.ts` 走 `desktop === undefined` 分支（`dsh-plugin-desktop/src/preload.ts` 只暴露 `dshDesktop`，不暴露 `dshDesktopBoot`），boot gate 用可选链，所以 gate 抛错本身不白屏 → 稳定版按 **P0（功能级）**；beta/next 有 `preload-app.ts:45` 的 `dshDesktopBoot`，gate 缺失会走 `reportFailure` → **P0（启动失败/恢复页）**。

### 3.2 `AbortSignal.any`（19，Chromium 116+）

```
packages/client/ui-trajectory/src/index.ts:107
packages/client/ui-sidebar-documentpreview/src/client/html/read-relative.ts:37
packages/client/ui-sidebar-documentpreview/src/client/office/{OfficeBody.tsx:57,cache.ts:91}
packages/client/ui-sidebar-documentpreview/src/client/pdf/{pdf.tsx:70,158,runtime.ts:21}
packages/client/ui-sidebar-documentpreview/src/client/face.ts:175
packages/client/ui-deliverables/src/{present-open.ts:46,client/present-open.ts:91,client/host-read-store.ts:49}
packages/client/ui-sidebar-browser/src/client/electron/ElectronWebViewImpl.ts:134,152
packages/client/ui-plugin-manager/src/index.ts:61
packages/client/ui-workspace/src/client/navigation.ts:310,478
packages/client/ui-sidebar-files/src/client/directory-node.ts:24
packages/client/ui-file-drag/src/client/transfers.ts:50
```
影响：取消/组合信号是这些面板的常规路径（打开文档预览、切换 workspace、关闭插件卡片、拖拽文件），抛错会让面板加载中断。

---

## 4. Web API 可用性（逐项结论）

| API | Chromium 108 | 本项目命中 | 结论 |
|---|---|---|---|
| `structuredClone` | ✅ 98 | 2 renderer | 可用 |
| `AbortSignal.any` | ❌ 116 | 19 | 见 §3.2，需 shim |
| `AbortSignal.timeout` | ✅ 103 | 1（main） | 渲染层无 |
| `navigator.userAgentData` | ❌ 90（仅部分）/本项目不用 | 0 | 无影响 |
| `HTMLInputElement.showPicker` | ✅ 99 | 0 | 无影响 |
| `Element.checkVisibility` | ✅ 105 | 0 | 无影响 |
| `<dialog>` + `showModal` | ✅ 37 | 0 | 无影响（组件库用 div 实现） |
| Popover API（`popover`/`showPopover`） | ❌ 114 | 0（49 处 `popover` 全是 Tailwind token/类名；`QuotePreview.tsx:100` 只是 `data-quote-popover`） | 无影响 |
| View Transitions（`startViewTransition`） | ❌ 111 | 0 | 无影响 |
| 滚动驱动动画（`animation-timeline`） | ❌ 115 | 6（2 文件） | **已有降级**：`ui-user-questions/src/client/QuestionComposer.module.css:448` `@supports not (animation-timeline: scroll())`，108 走完整文本分支 → 可接受 |
| `scheduler.postTask` | ✅ 94 | 0 | 无影响 |
| `CompressionStream` | ✅ 80 | 0 | 无影响 |
| WebGPU | ❌ 113（108 无） | 0 | 无影响 |
| File System Access | ✅ 86（部分） | 0 | 无影响 |
| `Notification` API | ✅ 22（Windows 需 toast 支持） | 0（通知走主进程 `notifications.ts`） | 无影响 |
| `CSS.escape` | ✅ 46 | 0 | 无影响 |
| `requestIdleCallback` | ✅ 47 | 0 | 无影响 |
| `adoptedStyleSheets` / `CSS.registerProperty` | ✅ 73/85 | 0 | 无影响 |
| `Intl.Segmenter` | ✅ 87 | 1 | 可用 |
| `navigator.clipboard` | ✅ 66 | 3 | 可用（需安全上下文，loopback 算） |
| `WebSocket`/`EventSource`/`TextDecoderStream` | ✅ 43/6/78 | 各 1 | 可用 |
| `ResizeObserver`/`MutationObserver`/`IntersectionObserver` | ✅ | 3 | 可用 |
| `document.startViewTransition` | ❌ | 0 | 无影响 |

结论：**Web API 面没有白屏级缺口**，缺口集中在 §3 的三个内置对象。

---

## 5. CSS / Tailwind 4（P0/P1 主体）

### 5.1 实际 CSS 管线（已核对）

- A 段（client 插件）：`@tailwindcss/vite@4.3.3`（`yarn.lock:19642-19643`）在 build 阶段生成 CSS，内部调用 `optimize(code, { minify, map })`，**不传 `targets`**（已从 `https://unpkg.com/@tailwindcss/vite@4.3.3/dist/index.mjs` 的压缩源码确认：`p=K(p.code,{minify:g,map:p.map})`）。因此 Tailwind 输出保持现代语法。
- `vite.client.config.ts:36` `minify: false` → Vite 也不会跑 Lightning CSS 压缩/降级。
- 自定义 `onboardingStyles()` 插件（`vite.client.config.ts:10-30`）在 `generateBundle` 里把 CSS asset 文本**原样**塞进 `client.js` 的 `<style>`，并用 `@scope (:root:has(.dshDesktopOnboardingContent)) { ... }` 包裹（第 21 行），同时把 `:root, :host {` 改写成 `:scope {`（第 20 行）。
- B 段（native-ui）：`@tailwindcss/vite` + `src/native-ui/shared/theme.css`（`@import "tailwindcss"` + `tw-animate-css` + `shadcn/tailwind.css` + `@fontsource-variable/inter/wght.css`），无 `build.target`（Vite 8 默认 Chrome 111 baseline）。
- C 段（上游）：`packages/client/tsdown.client.ts` 用 `lightningcss.transform()` 处理 `.module.css`，**grep 无 `targets` 配置** → 不做降级；`apps/web/vite.config.ts:180` `target:'es2022'`。
- Vite 8 事实（https://vite.dev/guide/migration）：Rolldown + Oxc；默认 `build.target` 升到 **Chrome 111**；CSS 默认用 Lightning CSS 压缩；`esbuild.*` 选项已废弃 → `oxc.*`；`optimizeDeps.esbuildOptions` → `optimizeDeps.rolldownOptions`。

### 5.2 现代 CSS 特性使用位置（Chromium 108 判定）

| 特性 | 需要版本 | 108 | 命中 | 位置 |
|---|---|---|---|---|
| `@scope` | 118 | ❌ | 2 真实用法 | `dsh-plugin-desktop/vite.client.config.ts:21`（包住整份 onboarding CSS，**全部丢弃**）、`deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/excel/excel.tsx:13`（Excel 预览样式整段丢） |
| `oklch()` | 111 | ❌ | 32 | `dsh-plugin-desktop/src/native-ui/shared/theme.css:27-63`（30 个主题变量，含暗色 48-63）、`dsh-plugin-desktop-beta/src/native-ui/theme.css:38` |
| `color-mix()` | 111 | ❌ | 125（上游 100 + 桌面 18 + beta 7） | 桌面：`src/client/{plugin-controls-styles.ts:57-58, desktop-settings-styles.ts:144,181,263,264,395,404, extended-styles.ts:83,86,167,192,324,353,381}`、`src/native-ui/shared/theme.css:93`、`compatibility-chrome/style.css:27,30,111,136,268,297,325`；上游：`ui-theme/src/styles/design-platform.css:179,231`、`ui-primitives/src/{Tag,ConnectionIndicator}.module.css` 等 27 文件 |
| `@container` | 105 | ✅ | 12 | 可用 |
| `:has()` | 105 | ✅ | 80 | 可用（`onboarding.css:31`、`styles.ts:50`） |
| `@layer` | 99 | ✅ | 2 | 可用 |
| `@property` | 85 | ✅ | 1 | `ui-settings-account/src/client/DesktopOnboarding.module.css:200` 可用 |
| `light-dark()` | 123 | ❌ | 1 | `ui-primitives/src/ZoomControls.module.css:21`（阴影丢，P2；Lightning CSS 可降级） |
| `field-sizing` | 123 | ❌ | 3 | `ui-schedule/src/client/TaskManagerPage.module.css:1161`、`ui-message-feedback/src/client/FeedbackDialog.module.css:78`（输入框不自适应高度，P2） |
| `anchor()`/`anchor-size()`/`position-anchor` | 125 | ❌ | 10（3 文件） | `ui-primitives/src/MenuSurface.module.css:38-45` **仅 `html[data-platform='darwin']`**，Windows 无影响 |
| `text-wrap: balance/pretty` | 114/117 | ❌ | 1 | 仅换行效果，P2（Lightning CSS 不降级，但可忽略） |
| `scrollbar-width` | 121 | ❌ | 2 | `theme.css:76` 隐藏滚动条失效（P2，可用 `::-webkit-scrollbar` 已并存） |
| `subgrid`/`view-transition` | 117/111 | ❌ | 0 | 无 |
| Tailwind `/NN` 透明度工具类（依赖 `color-mix(in oklab, var(...) N%, transparent)`） | 111 | ❌ | **31 处** | 桌面 4 个组件内（`ring-ring/30`×5、`border-destructive/50`×3、`bg-muted/40`×2、`bg-background/80`×2 等）→ 108 上这些声明被丢弃：边框/焦点环/半透明底色消失 |

**关键限制（已从 Lightning CSS 官方文档确认）**：`color-mix()` 只有在**两端都是静态颜色**时才会被静态求值降级；**含 `var()` 的 color-mix 无法降级**。上游 100 处里 **71 处含 `var()`**，桌面 18 处几乎全是 `var(--dsw-alias-*)` → 只能靠改写法或补 fallback，不能靠构建配置解决。`oklch()` 则可以：Lightning CSS 在 targets 要求时会输出 RGB/`color(display-p3)` 回退声明（文档 "LAB colors" 一节）。

### 5.3 降级方案（可直接抄）

**方案 A（推荐，最外科）：构建后 Lightning CSS 定向降级插件**

```ts
// 放在 dsh-plugin-desktop/scripts/css-compat108.ts（新文件），两个 vite config 与 apps/web 复用
import { transform, browserslistToTargets, Features } from 'lightningcss'
import type { Plugin } from 'vite'

const targets = browserslistToTargets(['chrome 108'])

/** 把最终 CSS asset 降级到 Chromium 108：颜色/嵌套/逻辑属性/媒体查询/前缀。 */
export function cssCompat108(): Plugin {
  return {
    name: 'dsh-css-compat-108',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !String(asset.fileName).endsWith('.css')) continue
        const result = transform({
          filename: String(asset.fileName),
          code: Buffer.from(String(asset.source)),
          targets,
          // 不要 include Features.Colors 之外的激进项；VendorPrefixes 交给默认行为
        })
        asset.source = result.code
      }
    },
  }
}
```

接入：
- `dsh-plugin-desktop/vite.client.config.ts`：`plugins: [react(), tailwindcss(), onboardingStyles(), cssCompat108()]`，并把 `onboardingStyles()` 的 `enforce:'post'` 保持在其后（顺序：cssCompat108 先跑，onboardingStyles 再包）。
- `dsh-plugin-desktop/vite.native-ui.config.ts`：`plugins: [react(), tailwindcss(), cssCompat108()]`。
- `deepseek-harness/apps/web/vite.config.ts`：`plugins: [..., cssCompat108()]`（重建 dist 时生效）。
- A 段 `onboardingStyles` 现在的 `generateBundle` 会**删掉 CSS asset**，所以要保证 `cssCompat108` 的 `generateBundle` 先执行（同 `enforce:'post'` 下按插件顺序，把 `cssCompat108()` 放在 `onboardingStyles()` 之前即可）。

**方案 B（Vite 原生）**：两个 config 加

```ts
build: { target: 'chrome108', cssTarget: ['chrome108'], cssMinify: 'lightningcss' },
css: {
  transformer: 'lightningcss',
  lightningcss: { targets: browserslistToTargets(['chrome 108']) },
},
```
需要 `devDependencies` 显式加 `lightningcss` 与 `browserslist`（`@tailwindcss/node` 已间接依赖 lightningcss，但不要依赖传递依赖）。注意 `css.transformer:'lightningcss'` 会取代 PostCSS 链路，若仓库以后加 PostCSS 插件会冲突；且它只对 Vite 经手的 CSS 生效，**对本项目最重要的 `onboardingStyles` 注入路径仍建议用方案 A 的产物校验**。

**必须搭配的源码改写（构建降级解决不了的部分）**

1. **删除 `@scope` 包裹**（`vite.client.config.ts:19-27`）。现有实现本来就把 `<style>` 的插入/移除绑定在 onboarding 生命周期上（注释也这么写），无需 `@scope`。改法：把第 20 行 `:root,:host` → `:scope` 的替换和第 21 行包裹一起删掉，直接把 `source` 注入：
```ts
const install = `const style = document.createElement('style'); style.textContent = ${JSON.stringify(source)}; document.head.appendChild(style);`
```
   若担心样式外泄，改用前缀选择器生成（`:where(:root:has(.dshDesktopOnboardingContent)) <sel>`），不要用 `@scope`。
2. **`oklch()` 主题变量**：`src/native-ui/shared/theme.css:27-63` 的 30 行改成 `hex`/`rgb`（方案 A 也会生成回退，但直接改更可控、且 `--*` 变量的回退行为需要在 108 实测确认）。
3. **含 `var()` 的 `color-mix()`**：每个位置加一条降级声明（108 丢弃第二条、保留第一条）：
```css
/* before */
background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
/* after */
background: var(--dsw-alias-state-error-primary);                    /* 108 fallback */
background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
```
   若不能接受纯色降级，就把透明度下沉为 `--dsw-alias-*-soft` 静态 `rgba()`（在上游 `design-platform.css` 定义，按主题各给一份）。
4. **Tailwind `/NN` 工具类（31 处）**：108 上失效。选项：(a) 逐处换成 `rgb(var(--...)/N)` 不现实（Tailwind 4 无 `<alpha-value>`）；(b) 为这 31 个用法加兼容类（在 `onboarding.css` 里手写 `--tw` 覆盖）；(c) **建议**：与设计确认，Win7 渠道把 `/NN` 降级为实色类（如 `ring-ring/30` → `ring-ring`），改动集中在 `src/native-ui/components/ui/*.tsx` 的 6 个文件。
5. `light-dark()`（1 处）、`field-sizing`（3 处）、`text-wrap`（1 处）→ Lightning CSS 能处理 `light-dark`，`field-sizing`/`text-wrap` 忽略即可（P2）。

---

## 6. 构建目标（要动的配置清单）

| 文件 | 现状 | 改成 | 说明 |
|---|---|---|---|
| `dsh-plugin-desktop/vite.client.config.ts:36` | `target:'es2022'`, `minify:false` | `target:'chrome108'`, 保留 `minify:false`（或 `'oxc'`） | Vite 8/Oxc 支持 `chrome108` 目标字符串；CSS 走 §5.3 方案 A |
| `dsh-plugin-desktop/vite.native-ui.config.ts` | 无 `build.target` | `build: { target:'chrome108', cssTarget:['chrome108'] }` + `cssCompat108()` | Vite 8 默认是 Chrome **111**，不改会产出 109–111 语法 |
| `deepseek-harness/apps/web/vite.config.ts:180` | `target:'es2022'` | `target:'chrome108'` + `cssCompat108()` | 必须重建 `@deepseek-ai/dsh-web-frontend` dist 并重打 `vendor/dsh-runtime` tarball，否则改不到实际渲染层 |
| `deepseek-harness/packages/client/tsdown.client.ts:310-312` | browser 面 `target:'es2024'` | `target:'chrome108'` | 60 个 client 插件包的 JS；同时给其 CSS `lightningcss.transform()` 传 `targets`（当前无 targets，grep 已确认） |
| `deepseek-harness/tsconfig.base.client.json:9` | `lib:["ES2024",...]` | 保持（仅类型）；可加 `ES2022` 语义注释 | `lib` 不参与降级，真正决定产物的是 target |
| `dsh-plugin-desktop/tsdown.config.ts`（host/bin） | `target:'es2024'` | `'node16'` | 主进程 → 交给 electron22-auditor；渲染层只需 preload 段（`es2022` 对 Node 16.17 足够） |
| `dsh-plugin-desktop/package.json:373` / `:354` | `devDependencies.electron:22.3.27`（已是） / `peerDependencies.electron:44.7.0` | peer 改 `22.3.27` | 已由 Lead 改 devDeps，peer 未同步；另查 `electron-builder`/`scripts/package*.ts` 里的 44 引用 |
| `dsh-plugin-desktop-beta/vite.client.config.ts` | re-export 稳定版 | 自动继承 | 但 `dsh-plugin-desktop-beta/vite.native-ui.config.ts:13` 无 target，要单独加 |
| `dsh-desktop-next/vite.native-ui.config.ts:13` | 同上 | 同上 | 另 `dsh-desktop-next/src/native-ui/theme.css:38` 有 `oklch()` |

**Vite 8 注意事项**
- `build.target` 影响 JS 转译（Oxc）与 `cssTarget` 默认值；`css.lightningcss.targets` 才是 CSS 降级的确定开关。
- `esbuild.*` 已 deprecated → `oxc.*`；`optimizeDeps.esbuildOptions` → `optimizeDeps.rolldownOptions`。本仓库是 lib build（不跑 optimizeDeps），**dev 模式**若要支持 Win7 调试需设 `oxc.target:'chrome108'`（dev 默认 esnext）。
- `build.cssMinify` 默认现在是 `'lightningcss'`，但我们建议 `minify:false` + 方案 A，避免对已包进 JS 的 CSS 产生二次差异。
- 不要在 lib 模式开 `@vitejs/plugin-legacy`：它依赖 SystemJS polyfill 与 `@babel/preset-env`，与 `formats:['cjs']` + `__ModuleLoader__` 工厂不兼容，且 Chromium 108 不需要。

---

## 7. Polyfill 方案（最小依赖）

### 7.1 推荐：手写 3 个 shim（约 1.5–2KB min / <1KB gzip）

```ts
// dsh-plugin-desktop/src/compat/chromium108.ts（新文件）
// 幂等、feature-detect：Node 22 的 vitest 里全部 no-op，不影响既有测试。
const g = globalThis as any

if (typeof g.Promise.withResolvers !== 'function') {
  Object.defineProperty(g.Promise, 'withResolvers', {
    configurable: true, writable: true,
    value<T>() {
      let resolve!: (v: T | PromiseLike<T>) => void
      let reject!: (e: unknown) => void
      const promise = new g.Promise<T>((res: typeof resolve, rej: typeof reject) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    },
  })
}

if (typeof g.AbortSignal.any !== 'function') {
  Object.defineProperty(g.AbortSignal, 'any', {
    configurable: true, writable: true,
    value(signals: AbortSignal[]) {
      const controller = new g.AbortController()
      const abort = (reason?: unknown) => { if (!controller.signal.aborted) controller.abort(reason) }
      for (const signal of signals) {
        if (signal.aborted) { abort(signal.reason); break }
        signal.addEventListener('abort', () => abort(signal.reason), { once: true })
      }
      return controller.signal
    },
  })
}

if (typeof g.Array.prototype.toSorted !== 'function') {
  Object.defineProperty(g.Array.prototype, 'toSorted', {
    configurable: true, writable: true,
    value(compareFn?: (a: unknown, b: unknown) => number) { return [...this].sort(compareFn) },
  })
}

export {}
```
说明：`AbortSignal.any` 的 `reason` 传播语义在 Chrome 116 是“任一 signal abort 即以该 reason abort”，上面实现一致；`addEventListener` 不需要清理（once + signal 生命周期与页面同寿，桌面场景可接受；若要严格可加 `AbortSignal` 事件清理）。
若坚持用 `core-js`，最小入口是：`core-js/modules/es.promise.with-resolvers`、`core-js/modules/es.array.to-sorted`，`AbortSignal.any` 无对应模块（core-js 3.4x 未覆盖全部 Web API，仍需手写）。体积：这两个模块约 2.7KB min / 1.1KB gzip；**`core-js/stable` 全量为 ~90KB gzip，不要用**。

### 7.2 注入点（必须早于 boot gate）

**首选（不改 vendor 包）**：在 `dsh-plugin-desktop` 组合里接管 WebServer 的 index 变换。`DesktopWebServer extends WebServer`（`src/webserver.ts:56`），在 `Service.init` 之后注册一次：

```ts
// dsh-plugin-desktop/src/webserver.ts 内，super[Service.init]() 成功后
this.ctx.effect(() => this.tapIndex(html =>
  html.replace(/<head(\s[^>]*)?>/i, tag => `${tag}<script>${COMPAT108_SHIM}</script>`),
), 'desktop: chromium108 shim')
```
或事件形式（顺序更明确，head 行先于 body 的 READY_MARKUP）：
```ts
this.ctx.on('webserver/index-inject', table => {
  table.unshift({ kind: 'script', placement: 'head', text: COMPAT108_SHIM })
})
```
两种方式都保证 shim 在 `READY_MARKUP`（body 尾部）之前执行；页面无 CSP 响应头（`rg Content-Security-Policy` 只在 SVG 资源上），内联 classic script 可执行。

**兜底（页面不经本 WebServer 时）**：`src/preload.ts` 里 `webFrame.executeJavaScript(COMPAT108_SHIM)`。注意 preload 是 isolated world，`contextBridge` 无法改原型链，`webFrame.executeJavaScript` 是唯一能在 main world 早执行的入口；但它是异步的，**不能替代**上面的服务端注入。

**B 段 native-ui**：扫描结果是仅用 `Intl.NumberFormat`/`ResizeObserver`/`MutationObserver`，**不需要 JS polyfill**；只需 §5.3 的 CSS 降级。

**beta/next**：`dsh-plugin-desktop-beta|dsh-desktop-next/src/web-document.ts:24` 的 `APP_BOOT_SCRIPT` 必须改成不依赖 `Promise.withResolvers`：
```ts
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ ??= (()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej});return{promise,resolve,reject}})()</script>'
```
（与上游 `injections.ts:86` 同一问题，建议上游同步修，避免只能靠 shim 兜住。）

### 7.3 体积 / 启动开销估算

| 项 | min | gzip | 说明 |
|---|---|---|---|
| 手写 3 shim | ~1.5KB | ~0.8KB | 一次解析，微秒级 |
| core-js 两模块 + 手写 any | ~2.9KB | ~1.2KB | 需要 `core-js` 依赖与 Babel 风格注入 |
| `core-js/stable` | ~270KB | ~90KB | 不推荐 |
| CSS 降级后增量 | +2–4% CSS 体积 | — | Lightning CSS 输出 RGB/display-p3 回退与展开 |

对启动时间影响可忽略（<1ms）；真正的启动风险是 §3 的运行时 TypeError，而不是体积。

---

## 8. 依赖硬性要求核对

| 包 | 版本（resolved） | 声明 | 判定 |
|---|---|---|---|
| `electron` | 22.3.27（devDeps） | peer 仍 44.7.0 | 需同步；Chromium 108 |
| `react` / `react-dom` | 18.3.1 | 无 engines | ✅ 支持 108（React 18 基线为现代浏览器） |
| `@base-ui/react` | 1.7.0 | `engines.node >=14`，peer react 17/18/19，**无 browserslist** | 无硬门槛；其定位/滚动逻辑用 CSS 变量 + `:has`/`ResizeObserver`，108 可用；**需构建后实测**（内部可能用 `checkVisibility`/`showPicker` 等，pkg 未声明无法静态确认） |
| `lexical` | 0.49.0 | 无 engines、peer `typescript>=5.2` | 无声明；0.49 属新版本，理论上要求现代 Chrome；**建议锁定并实测**（108 差 30 个大版本，重点测粘贴/IME/contenteditable） |
| `lucide-react` | 1.41.0 | 纯 SVG 组件 | ✅ |
| `sonner` | ^2.0.8 | React toast 库，无基线声明 | ✅（用 CSS 变量，检查 `color-mix`/`@property` 只在 108 下退化） |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | 文档基线 **Chrome 111+/Safari 16.4+/Firefox 128+** | ❌ 需 §5.3 降级 + 改写；官方对旧浏览器的答复是“用 v3.4”，但降级 v3 会连带 `tw-animate-css`/`shadcn@4` 主题失效，**不建议**（改动面大于收益） |
| `tw-animate-css` | 1.4.0 | 纯 Tailwind v4 CSS，无基线 | 依赖 Tailwind 4 特性；随 §5.3 一起降级 |
| `shadcn`（`shadcn/tailwind.css`） | ^4.18.0 | 无基线 | **未能核对内容**（无 node_modules）；该导入是 B 段 CSS 的一部分，需在首次安装后 `rg '@property|color-mix|@scope' node_modules/shadcn/tailwind.css` |
| `@fontsource-variable/inter` | ^5.3.0 | woff2 可变字体 | ✅ |
| `vite` | 8.2.1 | Rolldown/Oxc，默认 target Chrome 111 | 配置层已覆盖 |
| `@vitejs/plugin-react` | 6.1.0 | 需 Vite 6/7/8 | ✅ |
| `typescript` | 6.0.3 | 仅类型 | ✅ |
| `tsdown` | 0.22.2 | Rolldown 打包 | 需给 browser 面显式 `chrome108` |

**需要锁定的包**：`tailwindcss`/`@tailwindcss/vite` 固定 `4.3.3`（不要浮动到 4.4+，基线只会更高）；`lexical` 固定 `0.49.0` 并加一条 Chromium 108 冒烟；`@base-ui/react` 固定 `1.7.0`。其余无需降级。

---

## 9. 分级清单

> 判定口径：P0=不改必白屏/崩溃/核心交互不可用；P1=功能或样式明显破损；P2=细节。

### P0

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| P0-1 | `deepseek-harness/packages/host/webserver/src/injections.ts:86`（`READY_MARKUP`）+ 16 处 client 插件调用点（§3.1，另有上游 desktop renderer 2 处） | 注入 `Promise.withResolvers` shim 到 index head（§7.2）；beta/next 同步改 `web-document.ts:24` | Chromium 108 无此 API（119+）；`pages/client/ui-approval` 等主路径直接抛 TypeError |
| P0-2 | 19 处 `AbortSignal.any`（§3.2） | 注入 `AbortSignal.any` shim | 116+；文档预览/导航/拖拽取消链路抛错 |
| P0-3 | 3 处 `toSorted`（`ui-model-selection/src/client/provider-order.ts:9`、`ui-schedule/src/client/TaskManagerPage.tsx:92`、`ui-settings-models/src/client/store.ts:73`） | 注入 `Array.prototype.toSorted` shim | 110+；模型选择/定时任务页渲染即抛错 |
| P0-4 | `dsh-plugin-desktop/vite.client.config.ts:21`（`@scope`） | 删除 `@scope` 包裹（§5.3-1），保留样式按生命周期注入 | Chromium 118+；108 整段规则丢弃 → onboarding 无样式 |
| P0-5 | `dsh-plugin-desktop-beta|dsh-desktop-next/src/web-document.ts:24` | 用原生 Promise 构造 gate（§7.2） | 108 无 `withResolvers` → `apps/web/src/main.ts:22-24` `boot readiness is missing` → 启动失败/恢复页 |
| P0-6 | 架构：`vendor/dsh-runtime/0.2.1-rc.3/*.tgz` 里的 `@deepseek-ai/dsh-web-frontend` dist | 用 `deepseek-harness` 源码以 `target:'chrome108'` 重建 dist 并重打 tarball（或明确“Win7 渠道只支持自建 runtime”） | 主渲染器 JS/CSS 是**预构建产物**，只改本仓库改不到它 |

### P1

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| P1-1 | `src/native-ui/shared/theme.css:27-63`（30 处 `oklch`） | 改 hex/rgb 或依赖 §5.3 方案 A 回退，并实测 `--*` 变量回退 | 111+；108 变量非法 → `bg-background`/`text-foreground` 链失效，首启窗口布局/配色破损 |
| P1-2 | 桌面 18 处 + 上游 100 处 `color-mix()`（§5.2） | 加降级声明；`var()` 型无法构建降级（71 处）需改写法 | 111+；108 丢弃声明 → 边框/遮罩/阴影/选中态消失 |
| P1-3 | `src/native-ui/**/*.tsx` 中 31 处 Tailwind `/NN` | 改实色类或自定义兼容类 | 依赖 `color-mix(in oklab, var(...))`，108 丢弃 |
| P1-4 | `deepseek-harness/packages/client/ui-sidebar-documentpreview/src/client/excel/excel.tsx:13`（`@scope`） | 改为 `[data-excel-preview]` 前缀选择器 | 118+；Excel 预览样式整段丢 |
| P1-5 | `deepseek-harness/packages/client/tsdown.client.ts:310-312` | browser 面 `target:'chrome108'`；CSS `lightningcss.transform` 传 targets | 现为 es2024 且 CSS 无 targets；保证语法与颜色降级 |
| P1-6 | `deepseek-harness/apps/web/vite.config.ts:180` | `target:'chrome108'` + `cssCompat108()` | Vite 8 默认 111，es2022 不覆盖新语法产物 |
| P1-7 | `dsh-plugin-desktop/vite.native-ui.config.ts`（无 target）+ beta/next 同名文件:13 | 加 `target:'chrome108'` + CSS 插件 | Vite 8 默认 Chrome 111 |
| P1-8 | `dsh-plugin-desktop/src/preload.ts:3,18`（`webUtils.getPathForFile`） | Electron 22 无 `webUtils`（32+）；改用 `File.path`（Electron 22 可用）或降级为无路径上传 | 拖拽/粘贴带路径文件会抛错；主进程审计已接手，渲染侧保留交叉引用 |
| P1-9 | `dsh-plugin-desktop/package.json:354` peer `electron:44.7.0` | 改 `22.3.27`；全仓搜 44 引用 | 安装/校验时版本不一致 |
| P1-10 | `packages/client/ui-trajectory/src/index.ts:115`（`using` 声明） | 构建后 `rg 'using |Symbol.dispose' lib/` 校验确实被降级；否则改 `try/finally` | Chromium 134+ 才原生支持；Oxc 降级能力需构建验证 |
| P1-11 | `src/client/styles.ts:50` 等 `:has()` 规则 | 无需改（105 支持），但需回归验证 `-webkit-app-region` 拖拽区 | 105+ 边界，Win7 上 DWM 行为不同 |

### P2

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| P2-1 | `ui-primitives/src/ZoomControls.module.css:21` `light-dark()` | 允许 Lightning CSS 降级为变量回退 | 123+ |
| P2-2 | `ui-schedule/.../TaskManagerPage.module.css:1161`、`ui-message-feedback/.../FeedbackDialog.module.css:78` `field-sizing` | 忽略（高度不自适应） | 123+ |
| P2-3 | `ui-primitives/src/MenuSurface.module.css:38-45` `anchor()` | Windows 不生效（darwin-only），无需改 | 125+ |
| P2-4 | `theme.css:76` `scrollbar-width:none` | 已有 `::-webkit-scrollbar` 兜底，忽略 | 121+ |
| P2-5 | `text-wrap`（1 处） | 忽略 | 114+ |
| P2-6 | `dsh-desktop-next/src/native-ui/theme.css:38` `oklch(.65 .16 150)` | 随 P1-1 一起改 | 111+ |
| P2-7 | `apps/desktop/renderer/{mandatory-update-frame.js:8,36,web-document.ts:10}` | 上游独立产品，若将来合并需同修 | 119+ |
| P2-8 | `compatibility-chrome/style.css` 7 处 `color-mix` | 标题栏兼容模式在 108 下同样丢填充 | 111+ |

---

## 10. 验收方法（建议加进 CI）

1. **产物静态扫描**（成本最低，先卡住回归）：
```bash
# 期望 0 命中（@scope 必须为 0；color-mix/oklch 只允许出现在显式 fallback 行）
rg -a -n '@scope|Promise\.withResolvers|AbortSignal\.any|\.toSorted\(|oklch\(|color-mix\(' \
  dsh-plugin-desktop/lib dsh-plugin-desktop-beta/lib dsh-desktop-next/lib \
  deepseek-harness/apps/web/dist deepseek-harness/packages/client/*/lib
```
2. **Electron 22 冒烟**（真实 Chromium 108）：起一个 `BrowserWindow`（可复用 `verify-frontend.mjs` 的模式），在主世界 `executeJavaScript`：
```js
const r = await wc.executeJavaScript(`JSON.stringify({
  toSorted: typeof [].toSorted, withResolvers: typeof Promise.withResolvers,
  any: typeof AbortSignal.any, oklch: CSS.supports('color: oklch(1 0 0)'),
  colorMix: CSS.supports('color: color-mix(in srgb, red, blue)'),
  has: CSS.supports('selector(:has(*))')
})`)
```
   期望：3 个 API 为 `function`（polyfill 生效）、`oklch/colorMix` 为 `false`、`has` 为 `true`。
3. **首启路径人工回归**：onboarding/setup wizard（B 段 6 个窗口）+ 审批弹窗 + 文档预览 + workspace 切换 + 模型选择页。
4. **CSS 视觉回归**：给 A/B 段各截 108 与现有 Electron 44 的图，重点看标题栏、卡片边框、遮罩、选中态。

---

## 11. 未验证 / 风险（交接用）

- **无法运行 `yarn install`**：`node_modules` 不在工作区，以下内容未能读源码/产物核对，需在首次安装后补证：`shadcn/tailwind.css` 内容、`@base-ui/react` 运行时是否用到 108 缺失 API、`tw-animate-css` 的 `@property` 清单、`lexical@0.49` 的实际浏览器要求。
- **上游 dist 是预构建的**：`vendor/dsh-runtime/0.2.1-rc.3` 是 tarball，无法在不重建 `deepseek-harness` 的前提下修主渲染器（P0-6）。若决定“Win7 渠道不重建上游”，则本报告 P0-1/2/3 只能靠 §7.2 的服务端 shim 兜住（可行，但要求 `dsh web` 的 index 注入链照旧；beta/next 的 `web-document.ts` 必须自己改）。
- **Chromium 108 无法在本机执行**：所有 API 支持结论来自 Chromium/Electron/Lightning CSS/Tailwind 官方文档与版本表，未跑真实 108 渲染；第 10 节的冒烟必须补。
- **`@property` 回退行为**：108 支持 `@property`（85），但 Tailwind 的 `--tw-*` 注册在 108 下的 `initial-value` 解析需实测（若失败，渐变/阴影工具类会异常）。
- **主进程侧不在本报告**：`structuredClone`（Node 17+）、`AbortSignal.any`（Node 20+）、`webUtils`、`node16` target 等由 `electron22-auditor` 负责，本文只在渲染层交叉引用。
- **Windows 7 渲染器/GPU 前置**：Electron 22 在 Win7 上依赖 `--disable-gpu`/软件合成、以及缺 Media Foundation 的解码限制，属 `runtime-offline-auditor`/`electron22-auditor` 范围，但它会决定“即使 CSS 修好，首帧是否黑屏”，建议与本报告 P0-4/P1-1 一起做端到端验证。

---

## 附录 A：本次用到的关键证据文件（供复核）

- `dsh-plugin-desktop/package.json`（electron 22.3.27 / peer 44.7.0 / 依赖版本）
- `dsh-plugin-desktop/vite.client.config.ts`（target es2022 / minify:false / `@scope` 插件）
- `dsh-plugin-desktop/vite.native-ui.config.ts`（无 target / 6 个 html 入口）
- `dsh-plugin-desktop/src/client/onboarding.css:1-2`、`src/native-ui/shared/theme.css:1-4,27-63,93`
- `deepseek-harness/apps/web/vite.config.ts:177-181`、`apps/web/index.html`、`apps/web/src/main.ts:22-40`
- `deepseek-harness/packages/host/webserver/src/injections.ts:15-31,86,96-119`、`src/index.ts:519,733-739`
- `deepseek-harness/packages/bundle/web-app/src/index.ts:123-131,206`
- `deepseek-harness/packages/client/tsdown.client.ts:267-269,310-312`（无 CSS `targets`）
- `deepseek-harness/tsconfig.base.client.json:9`（`lib: ES2024`）
- 版本：`yarn.lock:19642,28541,784,24806,25174,28311,28839,29163,20137`
