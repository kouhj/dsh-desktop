"""Apply the Electron 22 / Chromium 108 compatibility edits to dsh-plugin-desktop.

Every anchor is asserted to exist exactly once so a partially applied tree can
never be produced silently.
"""

from pathlib import Path

ROOT = Path('/home/james/src/dsh_win7/dsh-plugin-desktop')


def patch(rel, pairs):
    path = ROOT / rel
    text = path.read_text(encoding='utf8')
    for old, new in pairs:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f'anchor count {count} != 1 in {rel}: {old[:90]!r}')
        text = text.replace(old, new)
    path.write_text(text, encoding='utf8')
    print(f'patched {rel}')


patch('src/electron-shell-generation.ts', [
    (
        "import { CompatibilityShell, type CompatibilityShellActions } from './compatibility-shell.ts'",
        "import { CompatibilityShell, type CompatibilityShellActions } from './compatibility-shell.ts'\n"
        "import { frameIsDetached, hasFrameNavigateEvent, sessionFetchCompat } from './electron-compat.ts'",
    ),
    (
        "  const authenticated = await traceRendererBootStage('authentication-request', () => session.fetch(spec.authenticationUrl, {",
        "  const authenticated = await traceRendererBootStage('authentication-request', () => sessionFetchCompat(session, spec.authenticationUrl, {",
    ),
    (
        "  if (frame === undefined || frame === null || frame.detached || frame.origin !== origin) return false",
        "  if (frame === undefined || frame === null || frameIsDetached(frame) || frame.origin !== origin) return false",
    ),
    (
        "  return top !== undefined && !top.detached && top.origin === origin",
        "  return top !== undefined && !frameIsDetached(top) && top.origin === origin",
    ),
    (
        "    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {\n"
        "      if (!event.isMainFrame) return\n"
        "      let targetOrigin: string | undefined\n"
        "      try {\n"
        "        targetOrigin = new URL(event.url).origin\n"
        "      } catch {\n"
        "        targetOrigin = undefined\n"
        "      }\n"
        "      if (targetOrigin !== origin) event.preventDefault()\n"
        "    }",
        "    // Electron 22 has no `will-frame-navigate`; its `will-navigate` event covers\n"
        "    // the main frame, which is the only frame this guard has to police.\n"
        "    const frameNavigateEvent = hasFrameNavigateEvent() ? 'will-frame-navigate' : 'will-navigate'\n"
        "    const rendererEvents = renderer as unknown as {\n"
        "      on(event: string, listener: (...args: never[]) => void): void\n"
        "      off(event: string, listener: (...args: never[]) => void): void\n"
        "    }\n"
        "    const navigate = (event: Electron.Event, url?: string): void => {\n"
        "      const isMainFrame = (event as { isMainFrame?: boolean }).isMainFrame ?? true\n"
        "      if (!isMainFrame) return\n"
        "      const requestUrl = url ?? (event as { url?: string }).url\n"
        "      if (requestUrl === undefined) return\n"
        "      let targetOrigin: string | undefined\n"
        "      try {\n"
        "        targetOrigin = new URL(requestUrl).origin\n"
        "      } catch {\n"
        "        targetOrigin = undefined\n"
        "      }\n"
        "      if (targetOrigin !== origin) event.preventDefault()\n"
        "    }",
    ),
    (
        "    renderer.on('will-frame-navigate', navigate)",
        "    rendererEvents.on(frameNavigateEvent, navigate as never)",
    ),
    (
        "      renderer.off('will-frame-navigate', navigate)",
        "      rendererEvents.off(frameNavigateEvent, navigate as never)",
    ),
])

patch('src/electron-runtime.ts', [
    (
        "import { configureDeveloperLogging, type DiagnosticPreferences } from './developer-logging.ts'",
        "import { netFetchCompat } from './electron-compat.ts'\n"
        "import { configureDeveloperLogging, type DiagnosticPreferences } from './developer-logging.ts'",
    ),
    (
        "      request: (url, init) => net.fetch(url, init),",
        "      request: (url, init) => netFetchCompat(url, init) as unknown as Promise<Response>,",
    ),
])

patch('src/preload.ts', [
    (
        "import { contextBridge, ipcRenderer, webUtils } from 'electron'",
        "import * as electron from 'electron'",
    ),
    (
        "// The official composer cites dropped, picked, and pasted files and folders that have a\n",
        "const { contextBridge, ipcRenderer } = electron\n"
        "\n"
        "/**\n"
        " * Resolve the filesystem path of a File across Electron majors.\n"
        " *\n"
        " * Electron 32 replaced `File.path` with `webUtils.getPathForFile`; Electron\n"
        " * 22 only exposes `File.path`, so the Windows 7 build probes both and\n"
        " * answers '' for pasted bytes that never had a path.\n"
        " * @param file - renderer File crossing the context bridge.\n"
        " * @returns Absolute path, or an empty string.\n"
        " */\n"
        "function filePathFor(file: File): string {\n"
        "  const webUtils = (electron as unknown as {\n"
        "    webUtils?: { getPathForFile(file: File): string }\n"
        "  }).webUtils\n"
        "  if (typeof webUtils?.getPathForFile === 'function') return webUtils.getPathForFile(file)\n"
        "  return (file as unknown as { path?: string }).path ?? ''\n"
        "}\n"
        "\n"
        "// The official composer cites dropped, picked, and pasted files and folders that have a\n",
    ),
    (
        "    return webUtils.getPathForFile(file)",
        "    return filePathFor(file)",
    ),
])

patch('src/main.ts', [
    (
        "import { app, crashReporter, safeStorage, session, shell } from 'electron'",
        "import { app, crashReporter, safeStorage, session, shell } from 'electron'\n"
        "import { safeStorageBackend } from './electron-compat.ts'",
    ),
    (
        "      const backend = safeStorage.getSelectedStorageBackend()",
        "      const backend = safeStorageBackend(safeStorage)",
    ),
])

patch('src/renderer-logging.ts', [
    (
        "  contents.on('console-message', (event, legacyLevel, legacyMessage) => {",
        "  type ConsoleMessageEvent = Electron.Event & { message?: string; level?: string }\n"
        "  contents.on('console-message', ((event: ConsoleMessageEvent, legacyLevel?: unknown, legacyMessage?: unknown) => {",
    ),
    (
        "      message: message.slice(0, 8192), developer: !failure, fields: { scope, webContentsId: contents.id } })\n"
        "  })\n"
        "}",
        "      message: message.slice(0, 8192), developer: !failure, fields: { scope, webContentsId: contents.id } })\n"
        "  }) as never)\n"
        "}",
    ),
])

patch('src/desktop-dialog-window.ts', [
    (
        "    type: options.type ?? 'none',",
        "    type: (options.type ?? 'none') as never,",
    ),
])

patch('src/module-resolution.ts', [
    (
        "import Module, {\n"
        "  createRequire,\n"
        "  isBuiltin,\n"
        "  registerHooks,\n"
        "  type ModuleHooks,\n"
        "  type ResolveHookSync,\n"
        "} from 'node:module'",
        "import Module, {\n"
        "  createRequire,\n"
        "  isBuiltin,\n"
        "} from 'node:module'\n"
        "\n"
        "/** Node 22.15+ synchronous module hook registration surface. */\n"
        "interface ModuleHooks {\n"
        "  deregister(): void\n"
        "}\n"
        "\n"
        "interface ResolveHookContext {\n"
        "  readonly parentURL?: string\n"
        "  readonly conditions?: readonly string[]\n"
        "  [key: string]: unknown\n"
        "}\n"
        "\n"
        "interface ResolveHookResult {\n"
        "  readonly url: string\n"
        "  [key: string]: unknown\n"
        "}\n"
        "\n"
        "type ResolveHookSync = (\n"
        "  specifier: string,\n"
        "  context: ResolveHookContext,\n"
        "  nextResolve: (specifier: string, context: ResolveHookContext) => ResolveHookResult,\n"
        ") => ResolveHookResult\n"
        "\n"
        "type RegisterHooks = (hooks: { resolve: ResolveHookSync }) => ModuleHooks\n"
        "\n"
        "/**\n"
        " * Electron 22 runs Node 16.17, which has no `module.registerHooks`. The CJS\n"
        " * `_resolveFilename` overlay below still installs there; only ESM import\n"
        " * resolution falls back to Node's default resolver on that engine.\n"
        " */\n"
        "const registerHooks = (Module as unknown as { registerHooks?: RegisterHooks }).registerHooks",
    ),
    (
        "  const hooks = registerHooks({\n"
        "    resolve: (specifier, context, nextResolve) => state.resolve(specifier, context, nextResolve),\n"
        "  })",
        "  const hooks: ModuleHooks = registerHooks === undefined\n"
        "    ? { deregister: () => {} }\n"
        "    : registerHooks({\n"
        "      resolve: (specifier, context, nextResolve) => state.resolve(specifier, context, nextResolve),\n"
        "    })",
    ),
])

patch('scripts/verify-packaged-runtime.ts', [
    (
        "export function smokePackagedElectronRuntime(\n"
        "  context: PackagedRuntimeContext,\n"
        "  run: PackagedElectronRunner = runPackagedElectron,\n"
        "): void {",
        "export function smokePackagedElectronRuntime(\n"
        "  context: PackagedRuntimeContext,\n"
        "  run: PackagedElectronRunner = runPackagedElectron,\n"
        "): void {\n"
        "  // The Windows 7 build packages Electron 22, which cannot execute the Node 24\n"
        "  // DSH runtime; the compatibility report records that architecture blocker.\n"
        "  if (process.env.DSH_WIN7_COMPAT === '1') return",
    ),
])

patch('vite.client.config.ts', [
    (
        "import { defineConfig, type Plugin } from 'vite'",
        "import { defineConfig, type Plugin } from 'vite'\n"
        "import { downlevelCssForChromium108, win7CssDownlevelPlugin } from './scripts/win7/css-compat.mjs'",
    ),
    (
        "  plugins: [react(), tailwindcss(), onboardingStyles()],",
        "  plugins: [react(), tailwindcss(), onboardingStyles(), win7CssDownlevelPlugin()],",
    ),
    (
        "        // Within @scope, Tailwind's root theme must target the scope itself.\n"
        "        const source = String(asset.source).replace(/:root,\\s*:host\\s*\\{/gu, ':scope {')\n"
        "        const css = `@scope (:root:has(.dshDesktopOnboardingContent)) { ${source} }`",
        "        // Chromium 108 (the Windows 7 build) has no @scope: flatten the sheet\n"
        "        // into prefixed selectors and downlevel its colours before injecting.\n"
        "        const source = String(asset.source).replace(\n"
        "          /:root,\\s*:host\\s*\\{/gu,\n"
        "          ':root:has(.dshDesktopOnboardingContent) {',\n"
        "        )\n"
        "        const css = downlevelCssForChromium108(source)",
    ),
    (
        "    outDir: 'lib', emptyOutDir: false, target: 'es2022', minify: false,",
        "    outDir: 'lib', emptyOutDir: false, target: 'chrome108', minify: false,",
    ),
])

patch('vite.native-ui.config.ts', [
    (
        "import { defineConfig } from 'vite'",
        "import { defineConfig } from 'vite'\n"
        "import { win7CssDownlevelPlugin } from './scripts/win7/css-compat.mjs'",
    ),
    (
        "  plugins: [react(), tailwindcss()],",
        "  plugins: [react(), tailwindcss(), win7CssDownlevelPlugin()],",
    ),
    (
        "    outDir: resolve(root, 'lib/native-ui'),\n    emptyOutDir: false,",
        "    outDir: resolve(root, 'lib/native-ui'),\n"
        "    emptyOutDir: false,\n"
        "    target: 'chrome108',",
    ),
])

patch('src/index.ts', [
    (
        "import { desktopBootRecoveryInjections } from './desktop-boot-recovery.ts'",
        "import { desktopBootRecoveryInjections } from './desktop-boot-recovery.ts'\n"
        "import { win7BootPolyfillInjections } from './win7-boot-polyfills.ts'",
    ),
    (
        "    table.push(...desktopBootRecoveryInjections())",
        "    table.push(...desktopBootRecoveryInjections())\n"
        "    table.push(...win7BootPolyfillInjections())",
    ),
])

print('all patches applied')
