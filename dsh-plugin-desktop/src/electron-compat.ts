/**
 * Electron 22 compatibility boundary for the Windows 7 SP1 build.
 *
 * Electron 22 (Chromium 108 / Node 16.17.1) is the last release that runs on
 * Windows 7 SP1. This module centralises every API whose availability depends
 * on the Electron major so the shell keeps compiling and behaving on both the
 * mainstream Electron 44 build and the Windows 7 build:
 *
 * - `WebContentsView` / `BrowserWindow.contentView` arrived in Electron 30.
 * - `net.fetch` and `session.fetch` arrived after Electron 22; only
 *   `net.request` exists there.
 * - `webUtils.getPathForFile` replaced `File.path` in Electron 32.
 * - `safeStorage.getSelectedStorageBackend` is newer than Electron 22.
 * - `WebFrameMain.detached` is newer than Electron 22.
 * - `will-frame-navigate` is newer than Electron 22; Electron 22 only has
 *   `will-navigate` (main frame) and `will-redirect`.
 */

import { net, type Session } from 'electron'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The response shape this shell consumes from Electron's net stack. */
export interface CompatFetchResponse {
  readonly status: number
  readonly ok: boolean
  readonly url: string
  readonly headers: Headers
  text(): Promise<string>
  json(): Promise<unknown>
  /** Cancel the underlying request instead of draining the body. */
  readonly body?: { cancel(): Promise<void> }
}

/** Request options shared by the `net.request` adapters. */
interface NetRequestOptions {
  readonly method?: string | undefined
  readonly headers?: RequestInit['headers'] | undefined
  readonly body?: string | Buffer | undefined
  readonly signal?: AbortSignal | null | undefined
  readonly session?: Session | undefined
  readonly useSessionCookies?: boolean | undefined
}

/** Convert a fetch body into the string or Buffer `net.request` accepts. */
function requestBody(body: RequestInit['body']): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  return String(body)
}

/** Running Electron major version, parsed from `process.versions.electron`. */
export function electronMajorVersion(): number {
  const version = process.versions.electron
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(major) ? major : 0
}

/**
 * Whether `will-frame-navigate` (Electron 25+) is available.
 * @returns true when the running Electron emits the event.
 */
export function hasFrameNavigateEvent(): boolean {
  return electronMajorVersion() >= 25
}

/**
 * Resolve a package specifier to a file URL on both Node 20.6+ and Node 16.
 *
 * `import.meta.resolve` is unavailable in Node 16.17 (Electron 22), so the
 * fallback goes through `createRequire`, which resolves from this module's
 * own URL exactly like the ESM resolver does for bare specifiers.
 * @param specifier - bare package specifier such as `@deepseek-ai/cordis-plugin-loader`.
 * @returns Absolute file URL string.
 */
export function resolveModuleSpecifierUrl(specifier: string): string {
  const meta = import.meta as ImportMeta & { resolve?: (specifier: string) => string }
  if (typeof meta.resolve === 'function') return meta.resolve(specifier)
  return pathToFileURL(createRequire(import.meta.url).resolve(specifier)).href
}

/**
 * Whether a frame reference is detached, tolerating Electron 22's missing field.
 * @param frame - frame object reported by a webRequest listener.
 * @returns true only when the running Electron reports detachment.
 */
export function frameIsDetached(frame: object): boolean {
  return (frame as { detached?: boolean }).detached === true
}

/**
 * Resolve the filesystem path of a dropped or picked `File`.
 *
 * Electron 32 removed `File.path` and added `webUtils.getPathForFile`; Electron
 * 22 only has `File.path`, so both are probed and an empty string is returned
 * for pasted bytes that never had a path.
 * @param file - renderer File object crossing the context bridge.
 * @returns Absolute path, or '' when the File is not backed by a path.
 */
export function pathForFile(file: File): string {
  const candidate = (globalThis as unknown as {
    webUtils?: { getPathForFile?: (file: File) => string }
  }).webUtils
  if (typeof candidate?.getPathForFile === 'function') return candidate.getPathForFile(file)
  const legacy = (file as unknown as { path?: string }).path
  return typeof legacy === 'string' ? legacy : ''
}

/**
 * Report the active `safeStorage` backend without requiring Electron 25+.
 * @param storage - the `safeStorage` namespace object.
 * @returns Backend name, or 'unknown' when the running Electron cannot report one.
 */
export function safeStorageBackend(storage: object): string {
  const candidate = storage as { getSelectedStorageBackend?: () => string }
  if (typeof candidate.getSelectedStorageBackend !== 'function') return 'unknown'
  return candidate.getSelectedStorageBackend()
}

function headerEntries(headers: RequestInit['headers']): Array<[string, string]> {
  if (headers === undefined) return []
  if (headers instanceof Headers) return [...headers.entries()]
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, String(value)])
  return Object.entries(headers).map(([name, value]) => [name, String(value)])
}

function responseHeaders(source: Record<string, string | string[]> | undefined): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(source ?? {})) {
    const joined = Array.isArray(value) ? value.join(', ') : value
    if (typeof joined === 'string') result.set(name, joined)
  }
  return result
}

/**
 * Execute one request over Electron's `net.request` and expose a fetch-like view.
 *
 * Redirects are followed by Electron's network stack; the response body is
 * buffered because every consumer in this shell reads bounded JSON or text.
 * @param url - absolute request URL.
 * @param options - method, headers, body, abort signal and session binding.
 * @returns Buffered response.
 */
function requestCompat(url: string, options: NetRequestOptions): Promise<CompatFetchResponse> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? 'GET'
    const request = net.request({
      url,
      method,
      redirect: 'follow',
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.useSessionCookies === true ? { useSessionCookies: true } : {}),
    })
    let settled = false
    let aborted = false
    const fail = (cause: unknown): void => {
      if (settled) return
      settled = true
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
    const cancel = async (): Promise<void> => {
      if (settled || aborted) return
      aborted = true
      settled = true
      request.abort()
      reject(new Error('dsh-plugin-desktop: compatible request was cancelled'))
    }
    const onAbort = (): void => { void cancel() }
    if (options.signal !== undefined && options.signal !== null) {
      if (options.signal.aborted) { onAbort(); return }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    for (const [name, value] of headerEntries(options.headers)) request.setHeader(name, value)
    request.on('error', (cause: Error) => { fail(cause) })
    request.on('response', incoming => {
      const chunks: Uint8Array[] = []
      const status = incoming.statusCode ?? 0
      incoming.on('data', (chunk: Uint8Array) => { chunks.push(chunk) })
      incoming.on('end', () => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener('abort', onAbort)
        const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
        const text = async (): Promise<string> => body.toString('utf8')
        resolve({
          status,
          ok: status >= 200 && status < 300,
          url,
          headers: responseHeaders(incoming.headers as Record<string, string[]>),
          text,
          json: async () => JSON.parse(await text()) as unknown,
          body: { cancel },
        })
      })
      incoming.on('error', (cause: Error) => { fail(cause) })
    })
    if (options.body === undefined) request.end()
    else request.end(options.body)
  })
}

/**
 * `net.fetch` replacement over `net.request` for Electron 22.
 * @param url - absolute request URL.
 * @param init - fetch-style request initialiser (method, headers, body, signal).
 * @returns Buffered fetch-like response.
 */
export function netFetchCompat(url: string, init?: RequestInit): Promise<CompatFetchResponse> {
  return requestCompat(url, {
    method: init?.method,
    headers: init?.headers,
    body: requestBody(init?.body),
    signal: init?.signal,
  })
}

/**
 * `session.fetch` replacement over `net.request` bound to a session's cookies.
 * @param session - Electron session whose cookie jar authenticates the request.
 * @param url - absolute request URL.
 * @param init - fetch-style request initialiser.
 * @returns Buffered fetch-like response.
 */
export function sessionFetchCompat(
  session: Session,
  url: string,
  init?: RequestInit,
): Promise<CompatFetchResponse> {
  return requestCompat(url, {
    method: init?.method,
    headers: init?.headers,
    body: requestBody(init?.body),
    signal: init?.signal,
    session,
    useSessionCookies: true,
  })
}
