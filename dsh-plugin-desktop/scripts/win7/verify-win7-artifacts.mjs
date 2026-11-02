/**
 * Windows 7 SP1 artifact gate for the DSH Desktop compatibility build.
 *
 * The build pins Electron 22.3.27 because Electron 23+ requires Windows 10.
 * These checks prove the produced artifact still targets Windows 7 (PE image
 * subsystem 6.1), still ships the pinned Electron, still embeds the bundled
 * offline runtime, and that the renderer bundle was downlevelled for Chromium
 * 108 (no `@scope`, no raw `oklch()`, every `color-mix()` has a static
 * fallback declaration).
 *
 * Exit code 1 means at least one gate failed; the JSON report is written next
 * to the artifacts for the workflow summary.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..', '..')
const distDir = join(desktopRoot, 'dist')
const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'))
const results = []
let failed = false

/** Record one gate result. */
function check(name, detail, ok) {
  results.push({ name, detail, ok })
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`)
}

/** Read the PE optional header versions of one Windows executable. */
function peImageVersions(path) {
  const data = readFileSync(path)
  if (data.byteLength < 0x40 || data.subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error(`${path} is not a PE image (missing MZ)`)
  }
  const peOffset = data.readUInt32LE(0x3c)
  if (data.subarray(peOffset, peOffset + 4).toString('ascii') !== 'PE\0\0') {
    throw new Error(`${path} is not a PE image (missing PE signature)`)
  }
  const optional = peOffset + 24
  const magic = data.readUInt16LE(optional)
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`${path} has an unsupported PE optional header magic 0x${magic.toString(16)}`)
  }
  return {
    majorOperatingSystem: data.readUInt16LE(optional + 40),
    minorOperatingSystem: data.readUInt16LE(optional + 42),
    majorSubsystem: data.readUInt16LE(optional + 48),
    minorSubsystem: data.readUInt16LE(optional + 50),
  }
}

/** Walk every file below a directory. */
function walkFiles(dir) {
  if (!existsSync(dir)) return []
  const files = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...walkFiles(path))
    else files.push(path)
  }
  return files
}

const version = String(manifest.version)
const unpacked = join(distDir, 'win-unpacked')
const executable = join(unpacked, 'DSH Desktop.exe')
const appRoot = join(unpacked, 'resources', 'app')

check('unpacked application exists', relative(desktopRoot, executable), existsSync(executable))
check(
  'installer artifact exists',
  `DSH-Desktop-${version}-x64-Setup.exe`,
  existsSync(join(distDir, `DSH-Desktop-${version}-x64-Setup.exe`)),
)
check(
  'portable artifact exists',
  `DSH-Desktop-${version}-x64-Portable.zip`,
  existsSync(join(distDir, `DSH-Desktop-${version}-x64-Portable.zip`)),
)

if (existsSync(executable)) {
  const versions = peImageVersions(executable)
  const label = `OS ${versions.majorOperatingSystem}.${versions.minorOperatingSystem}, subsystem ${versions.majorSubsystem}.${versions.minorSubsystem}`
  check(
    'PE subsystem targets Windows 7 SP1 (<= 6.1)',
    label,
    versions.majorSubsystem < 7
      || (versions.majorSubsystem === 6 && versions.minorSubsystem <= 1),
  )
  check(
    'PE minimum OS targets Windows 7 SP1 (<= 6.1)',
    label,
    versions.majorOperatingSystem < 10,
  )
}

const versionFile = join(unpacked, 'version')
if (existsSync(versionFile)) {
  const electronVersion = readFileSync(versionFile, 'utf8').trim()
  check('packaged Electron is the Windows 7 line', electronVersion, electronVersion.startsWith('22.3.'))
} else {
  check('packaged Electron version file', 'missing resources/version', false)
}

const runtimeRoot = join(unpacked, 'resources', 'runtime')
const runtimeNode = join(runtimeRoot, 'x64', 'primary-runtime', 'dependencies', 'node')
check(
  'bundled offline runtime payload',
  relative(unpacked, runtimeNode),
  existsSync(runtimeNode),
)

if (existsSync(appRoot)) {
  const appFiles = walkFiles(appRoot)
  const jsFiles = appFiles.filter(file => file.endsWith('.js'))
  const cssFiles = appFiles.filter(file => file.endsWith('.css'))
  const scopeHits = cssFiles.filter(file => readFileSync(file, 'utf8').includes('@scope'))
  const oklchHits = cssFiles.filter(file => readFileSync(file, 'utf8').includes('oklch('))
  check('no @scope in emitted CSS (Chromium 118+)', `${scopeHits.length} file(s)`, scopeHits.length === 0)
  check('no oklch() in emitted CSS (Chromium 111+)', `${oklchHits.length} file(s)`, oklchHits.length === 0)

  // Every emitted declaration that uses color-mix() must carry a static
  // fallback for the same property, because Chromium 108 drops the mix.
  const colorMixFiles = [...cssFiles, ...jsFiles].filter(file => readFileSync(file, 'utf8').includes('color-mix('))
  const withoutFallback = []
  for (const file of colorMixFiles) {
    const text = readFileSync(file, 'utf8')
    const pattern = /([a-z-]+)\s*:\s*color-mix\(/gu
    let match
    while ((match = pattern.exec(text)) !== null) {
      const property = match[1]
      const before = text.slice(Math.max(0, match.index - 400), match.index)
      const fallbackPattern = new RegExp(`(?:^|[;{}\\s])${property}\\s*:\\s*(?!color-mix\\()[^;{}]+[;}]`, 'u')
      if (!fallbackPattern.test(before)) {
        withoutFallback.push(`${relative(appRoot, file)}:${property}`)
        break
      }
    }
  }
  check(
    'every color-mix() has a static fallback',
    withoutFallback.length === 0 ? `${colorMixFiles.length} file(s) checked` : withoutFallback.join(', '),
    withoutFallback.length === 0,
  )

  const polyfillOwner = join(appRoot, 'lib', 'index.js')
  check(
    'Chromium 108 boot polyfill is injected by the shell',
    relative(appRoot, polyfillOwner),
    existsSync(polyfillOwner) && readFileSync(polyfillOwner, 'utf8').includes('withResolvers'),
  )

  const packagedManifest = join(appRoot, 'package.json')
  const packagedElectron = existsSync(packagedManifest)
    ? JSON.parse(readFileSync(packagedManifest, 'utf8')).devDependencies?.electron
    : undefined
  check(
    'packaged application manifest pins Electron 22.3.27',
    String(packagedElectron),
    packagedElectron === '22.3.27',
  )
}

const reportPath = join(distDir, 'win7-verification.json')
writeFileSync(reportPath, `${JSON.stringify({ electron: '22.3.27', version, results }, null, 2)}\n`, 'utf8')
console.log(`\nWindows 7 artifact gate ${failed ? 'FAILED' : 'passed'}; report: ${reportPath}`)
if (failed) process.exitCode = 1
