/**
 * Chromium 108 boot polyfills for the Windows 7 SP1 build.
 *
 * The application frontend is a prebuilt upstream bundle that targets a modern
 * Chromium, but the Windows 7 build ships Electron 22 (Chromium 108). A few
 * standard-library helpers used by the client plugins are newer than that
 * engine, and a missing helper throws at call time (approval dialogs, follow-up
 * questions, trajectory rendering), so they are installed as an inline classic
 * script in the served index before any application module runs.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Inline polyfill body, executed in the page's main world ahead of the app. */
const WIN7_BOOT_POLYFILL_SCRIPT = [
  ';(() => {',
  '  var define = function (target, name, value) {',
  '    if (typeof target[name] !== "function") {',
  '      Object.defineProperty(target, name, { value: value, configurable: true, writable: true });',
  '    }',
  '  };',
  '  define(Promise, "withResolvers", function withResolvers() {',
  '    var resolve, reject;',
  '    var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });',
  '    return { promise: promise, resolve: resolve, reject: reject };',
  '  });',
  '  define(AbortSignal, "timeout", function timeout(ms) {',
  '    var controller = new AbortController();',
  '    setTimeout(function () { controller.abort(new DOMException("The operation timed out.", "TimeoutError")); }, ms);',
  '    return controller.signal;',
  '  });',
  '  define(AbortSignal, "any", function any(signals) {',
  '    var controller = new AbortController();',
  '    var list = Array.prototype.slice.call(signals);',
  '    for (var i = 0; i < list.length; i += 1) {',
  '      var signal = list[i];',
  '      if (signal.aborted) { controller.abort(signal.reason); return controller.signal; }',
  '      signal.addEventListener("abort", function () { controller.abort(this.reason); }, { once: true });',
  '    }',
  '    return controller.signal;',
  '  });',
  '  var complex = function (method, build) {',
  '    define(Array.prototype, method, function () { return build(this, arguments); });',
  '  };',
  '  complex("toSorted", function (self, args) { return Array.prototype.slice.call(self).sort(args[0]); });',
  '  complex("toReversed", function (self) { return Array.prototype.slice.call(self).reverse(); });',
  '  complex("toSpliced", function (self, args) {',
  '    var copy = Array.prototype.slice.call(self);',
  '    Array.prototype.splice.apply(copy, Array.prototype.slice.call(args));',
  '    return copy;',
  '  });',
  '  complex("with", function (self, args) {',
  '    var index = args[0] < 0 ? self.length + args[0] : args[0];',
  '    if (index < 0 || index >= self.length) throw new RangeError("Invalid index");',
  '    var copy = Array.prototype.slice.call(self);',
  '    copy[index] = args[1];',
  '    return copy;',
  '  });',
  '  define(Object, "groupBy", function groupBy(items, callback) {',
  '    var groups = {};',
  '    var index = 0;',
  '    for (var item of items) {',
  '      var key = callback(item, index);',
  '      var bucket = groups[key];',
  '      if (bucket === undefined) { bucket = []; groups[key] = bucket; }',
  '      bucket.push(item);',
  '      index += 1;',
  '    }',
  '    return groups;',
  '  });',
  '  define(Map, "groupBy", function groupBy(items, callback) {',
  '    var groups = new Map();',
  '    var index = 0;',
  '    for (var item of items) {',
  '      var key = callback(item, index);',
  '      var bucket = groups.get(key);',
  '      if (bucket === undefined) { bucket = []; groups.set(key, bucket); }',
  '      bucket.push(item);',
  '      index += 1;',
  '    }',
  '    return groups;',
  '  });',
  '  if (typeof Array.fromAsync !== "function") {',
  '    define(Array, "fromAsync", async function fromAsync(items, callback) {',
  '      var result = [];',
  '      var index = 0;',
  '      for await (var item of items) {',
  '        result.push(callback === undefined ? item : await callback(item, index));',
  '        index += 1;',
  '      }',
  '      return result;',
  '    });',
  '  }',
  '  var setMethods = {',
  '    union: function (self, other) { var out = new Set(self); for (var value of other) out.add(value); return out; },',
  '    intersection: function (self, other) { var out = new Set(); for (var value of other) if (self.has(value)) out.add(value); return out; },',
  '    difference: function (self, other) { var out = new Set(self); for (var value of other) out.delete(value); return out; },',
  '    isSubsetOf: function (self, other) { for (var value of self) if (!other.has(value)) return false; return true; },',
  '    isSupersetOf: function (self, other) { for (var value of other) if (!self.has(value)) return false; return true; },',
  '    isDisjointFrom: function (self, other) { for (var value of other) if (self.has(value)) return false; return true; }',
  '  };',
  '  Object.keys(setMethods).forEach(function (name) {',
  '    define(Set.prototype, name, function (other) { return setMethods[name](this, other); });',
  '  });',
  '  define(String.prototype, "isWellFormed", function isWellFormed() {',
  '    return !/[\\uD800-\\uDFFF]/u.test(this.replace(/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]/gu, ""));',
  '  });',
  '  define(String.prototype, "toWellFormed", function toWellFormed() {',
  '    return String(this).replace(/[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/gu, "\\uFFFD");',
  '  });',
  '})();',
].join('\n')

/**
 * Boot injection rows installing the Chromium 108 helpers in the served page.
 * @returns Index injection rows for the upstream WebServer seam.
 */
export function win7BootPolyfillInjections(): readonly IndexInjection[] {
  return [{ kind: 'script', placement: 'head', text: WIN7_BOOT_POLYFILL_SCRIPT }]
}
