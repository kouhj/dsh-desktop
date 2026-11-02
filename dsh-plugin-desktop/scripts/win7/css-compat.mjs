/**
 * Chromium 108 CSS downlevel for the Windows 7 SP1 build.
 *
 * Electron 22 ships Chromium 108, so two families of CSS that the app emits
 * today cannot be evaluated by the target engine:
 *
 * - `@scope` (Chrome 118+) — the client build wraps the whole onboarding
 *   Tailwind sheet in `@scope (:root:has(.dshDesktopOnboardingContent))`.
 *   Chromium 108 drops the entire block, so the sheet must be flattened into
 *   ordinary prefixed selectors.
 * - `color-mix()` (Chrome 111+) — Tailwind 4 emits it for every alpha modifier.
 *   Most uses blend a runtime `var(--dsw-alias-*)` value whose sRGB value is
 *   only known once the upstream stylesheet is applied, so the mix cannot be
 *   precomputed. The build instead emits an equivalent declaration with the
 *   first solid operand as a static fallback; Chromium 108 uses that fallback
 *   and later engines keep the exact mix.
 *
 * `oklch()` literals are converted to sRGB when their arguments are static.
 */

import postcss from 'postcss'

/** Prefix every selector inside one scope with the flattened scope root. */
function prefixSelectorList(selectors, scopeRoot) {
  return selectors
    .map(selector => {
      const trimmed = selector.trim()
      if (trimmed === ':root' || trimmed === ':host' || trimmed === ':root, :host') return scopeRoot
      if (trimmed.startsWith(':root ') || trimmed.startsWith(':host ')) {
        return `${scopeRoot}${trimmed.slice(trimmed.indexOf(' '))}`
      }
      return `${scopeRoot} ${trimmed}`
    })
    .join(', ')
}

/**
 * Replace every `@scope (root) { ... }` block with prefixed selectors.
 * @param root - PostCSS root being rewritten in place.
 * @param scopeRoot - Selector that reproduces the scope root condition.
 */
function flattenScopes(root, scopeRoot) {
  root.walkAtRules('scope', atRule => {
    const replacements = []
    atRule.each(node => {
      if (node.type === 'rule') node.selector = prefixSelectorList(node.selectors, scopeRoot)
      replacements.push(node.clone())
    })
    atRule.replaceWith(...replacements)
  })
}

/** Convert one `oklch(L C H [/ A])` argument list to an sRGB CSS colour. */
function oklchToRgb(args) {
  const tokens = args.replace('/', ' ').trim().split(/\s+/u).filter(Boolean)
  const l = Number.parseFloat(tokens[0] ?? '')
  const c = Number.parseFloat(tokens[1] ?? '')
  const h = Number.parseFloat(tokens[2] ?? '')
  if (![l, c, h].every(Number.isFinite)) return undefined
  const hRad = (h * Math.PI) / 180
  const a = c * Math.cos(hRad)
  const b = c * Math.sin(hRad)
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b
  const lCube = lPrime ** 3
  const mCube = mPrime ** 3
  const sCube = sPrime ** 3
  const linear = [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ]
  const channel = value => {
    const clamped = Math.min(1, Math.max(0, value))
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
  }
  const [red, green, blue] = linear.map(channel)
  const alpha = Number.parseFloat(tokens[3] ?? '')
  if (Number.isFinite(alpha)) {
    return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${String(alpha)})`
  }
  return `rgb(${String(red)}, ${String(green)}, ${String(blue)})`
}

/** Replace every static `oklch()` literal with its sRGB equivalent. */
function downlevelOklch(root) {
  root.walkDecls(declaration => {
    if (!declaration.value.includes('oklch(')) return
    declaration.value = declaration.value.replace(/oklch\(([^()]*)\)/gu, (match, args) => (
      oklchToRgb(args) ?? match
    ))
  })
}

/**
 * Pick the static stand-in for one `color-mix()` expression.
 *
 * `transparent` operands fall back to the other colour; a single colour keeps
 * its identity and loses only the blended alpha, which is the closest static
 * approximation Chromium 108 can render.
 */
function colorMixFallback(expression) {
  const open = expression.indexOf('(')
  const inner = expression.slice(open + 1, -1)
  const parts = inner.split(',')
  if (parts.length < 3) return undefined
  const operands = parts.slice(1).map(part => part.trim().split(/\s+/u)[0]).filter(Boolean)
  const solid = operands.filter(operand => operand.toLowerCase() !== 'transparent')
  return solid[0]
}

/** Insert static fallbacks ahead of declarations using `color-mix()`. */
function downlevelColorMix(root) {
  root.walkDecls(declaration => {
    if (!declaration.value.includes('color-mix(')) return
    const fallback = declaration.value.replace(/color-mix\((?:[^()]|\([^()]*\))*\)/gu, (match) => (
      colorMixFallback(match) ?? match
    ))
    if (fallback === declaration.value || fallback.includes('color-mix(')) return
    declaration.cloneBefore({ value: fallback })
  })
}

/**
 * Flatten scopes and downlevel colours for Chromium 108.
 * @param css - CSS text emitted by Vite or injected into the client factory.
 * @param options - Optional scope root selector to flatten `@scope` blocks into.
 * @returns Downlevelled CSS text.
 */
export function downlevelCssForChromium108(css, options = {}) {
  const root = postcss.parse(css)
  const scopeRoot = options.scopeRoot
  if (scopeRoot !== undefined) flattenScopes(root, scopeRoot)
  downlevelOklch(root)
  downlevelColorMix(root)
  return root.toString()
}

/**
 * Vite plugin applying the Chromium 108 downlevel to every emitted CSS asset.
 * @returns Vite plugin object.
 */
export function win7CssDownlevelPlugin() {
  return {
    name: 'dsh-win7-css-downlevel',
    enforce: 'post',
    generateBundle(_outputOptions, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !String(asset.fileName).endsWith('.css')) continue
        const source = typeof asset.source === 'string'
          ? asset.source
          : Buffer.from(asset.source).toString('utf8')
        asset.source = downlevelCssForChromium108(source)
      }
    },
  }
}
