/**
 * Stacked native view abstraction that works on both Electron 30+ (where
 * `WebContentsView` replaced `BrowserView`) and Electron 22, the last release
 * that runs on Windows 7 SP1 (Chromium 108 / Node 16.17).
 *
 * The Windows 7 compatibility build pins Electron 22 and therefore has to use
 * the legacy `BrowserView` API. Both shapes keep the same "view over the
 * window" semantics this shell relies on: explicit bounds, transparent
 * background, stacking order, and ownership of the page for teardown.
 */

import * as electron from 'electron'
import type { BrowserView, BrowserWindow, WebContents, WebPreferences } from 'electron'

/** The subset of a native child view this shell drives. */
export interface DesktopChildView {
  readonly webContents: WebContents
  setBounds(bounds: Electron.Rectangle): void
  setBackgroundColor(color: string): void
  remove(): void
  isDestroyed(): boolean
}

/** Two stacked child views: the application page below, the chrome above. */
export interface DesktopViewStack {
  readonly content: DesktopChildView
  readonly chrome: DesktopChildView
  destroy(): void
}

/** Structural view of the Electron 30+ `WebContentsView` instance. */
interface ModernView {
  readonly webContents: WebContents
  setBounds(bounds: Electron.Rectangle): void
  setBackgroundColor(color: string): void
}

/** Structural view of `BrowserWindow.contentView` on Electron 30+. */
interface ModernViewContainer {
  addChildView(view: ModernView): void
  removeChildView(view: ModernView): void
}

type ModernViewConstructor = new (options: { webPreferences: WebPreferences }) => ModernView

/**
 * Whether the running Electron exposes the modern view API.
 *
 * Electron 30 removed `BrowserView` from the public API surface and replaced
 * it with `WebContentsView`; Electron 22 only has `BrowserView`. Probe the
 * runtime export instead of trusting the version string, so a future backport
 * or a downgraded binary keeps working.
 * @returns true when `WebContentsView` exists.
 */
export function hasModernViewApi(): boolean {
  const candidate = (electron as unknown as { WebContentsView?: unknown }).WebContentsView
  return typeof candidate === 'function'
}

/** Wrap one Electron 30+ `WebContentsView` in the shell-facing shape. */
function modernChildView(window: BrowserWindow, webPreferences: WebPreferences): DesktopChildView {
  const Modern = (electron as unknown as { WebContentsView: ModernViewConstructor }).WebContentsView
  const container = (window as unknown as { contentView: ModernViewContainer }).contentView
  const view = new Modern({ webPreferences })
  container.addChildView(view)
  return {
    webContents: view.webContents,
    setBounds: bounds => { view.setBounds(bounds) },
    setBackgroundColor: color => { view.setBackgroundColor(color) },
    remove: () => { container.removeChildView(view) },
    isDestroyed: () => view.webContents.isDestroyed(),
  }
}

/** Wrap one legacy `BrowserView` and report whether it is still attached. */
function legacyChildView(window: BrowserWindow, view: BrowserView): DesktopChildView {
  return {
    webContents: view.webContents,
    setBounds: bounds => { view.setBounds(bounds) },
    setBackgroundColor: color => { view.setBackgroundColor(color) },
    remove: () => {
      window.removeBrowserView(view)
      const disposable = view.webContents as unknown as { destroy(): void }
      if (!view.webContents.isDestroyed()) disposable.destroy()
    },
    isDestroyed: () => view.webContents.isDestroyed(),
  }
}

/** Create the legacy stack with the chrome view explicitly raised above the page. */
function legacyStack(
  window: BrowserWindow,
  contentPreferences: WebPreferences,
  chromePreferences: WebPreferences,
): DesktopViewStack {
  const contentView = new electron.BrowserView({ webPreferences: contentPreferences })
  const chromeView = new electron.BrowserView({ webPreferences: chromePreferences })
  window.addBrowserView(contentView)
  window.addBrowserView(chromeView)
  // `addBrowserView` appends to the top of the stack; assert the order the
  // shell relies on for pointer input.
  window.setTopBrowserView(chromeView)
  const content = legacyChildView(window, contentView)
  const chrome = legacyChildView(window, chromeView)
  return {
    content,
    chrome,
    destroy: () => {
      content.remove()
      chrome.remove()
    },
  }
}

/**
 * Create the two child views stacked over a window.
 *
 * The chrome view is raised above the content view so the command bar keeps
 * receiving pointer input; the legacy path has to reassert the order after
 * every attach because `addBrowserView` appends to the top of the stack.
 * @param window - Owning application window.
 * @param contentPreferences - Web preferences of the application page.
 * @param chromePreferences - Web preferences of the compatibility chrome page.
 * @returns Both views plus a single teardown entry point.
 */
export function createDesktopViewStack(
  window: BrowserWindow,
  contentPreferences: WebPreferences,
  chromePreferences: WebPreferences,
): DesktopViewStack {
  if (!hasModernViewApi()) return legacyStack(window, contentPreferences, chromePreferences)
  const content = modernChildView(window, contentPreferences)
  const chrome = modernChildView(window, chromePreferences)
  return {
    content,
    chrome,
    destroy: () => {
      content.remove()
      chrome.remove()
    },
  }
}
