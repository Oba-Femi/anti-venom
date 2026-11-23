/**
 * Cosmetic (element hiding) filters: compilation into a compact, indexed
 * bundle, and the runtime engine that answers "what should be hidden on this
 * frame?".
 *
 * MV3 design:
 *  - The background service worker injects CSS with chrome.scripting.insertCSS
 *    using the USER origin, so page styles (even !important) cannot override it
 *    and no DOM nodes are added to the page.
 *  - Domain-specific selectors and "unkeyed" generic selectors are injected once
 *    per frame at document_start.
 *  - Generic selectors that start from a class or id (the vast majority) are
 *    indexed by that token. The content script reports the classes/ids that
 *    actually occur in the page and only matching selectors are injected. This
 *    keeps per-frame CSS small instead of injecting ~15k generic selectors
 *    everywhere.
 */
import { CosmeticFlag, type CosmeticFilter } from './parser.ts';
import { hostLookupKeys } from './domains.ts';

export interface CosmeticBundle {
  /** Generic selectors keyed by ".class" or "#id" token. */
  genericKeyed: Record<string, string[]>;
  /** Generic selectors without a usable token; injected on every page. */
  genericUnkeyed: string[];
  /** Host (or "entity.*") → selectors to hide. */
  specific: Record<string, string[]>;
  /** Host → selectors that must NOT be hidden there (#@# and ~domain). */
  exceptions: Record<string, string[]>;
  /** Host → CosmeticFlag bits from $elemhide / $generichide / $specifichide / $document. */
  flags: Record<string, number>;
}

export function emptyCosmeticBundle(): CosmeticBundle {
  return { genericKeyed: {}, genericUnkeyed: [], specific: {}, exceptions: {}, flags: {} };
}

/** Splits a selector list on top-level commas (respecting (), [] and quotes). */
export function splitSelectorList(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\') i++;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(selector.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * Finds a ".class" or "#id" token that must be present in the document for the
 * selector to match. Only tokens outside of (), [] and quotes qualify, since
 * tokens inside :not()/:has()/attribute selectors are not necessary conditions.
 * Prefers ids (rarer, so fewer false lookups).
 */
export function extractSelectorKey(selector: string): string | undefined {
  let depth = 0;
  let quote = '';
  let firstClass: string | undefined;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '\\') i++;
    else if (depth === 0 && (ch === '.' || ch === '#')) {
      const m = /^[A-Za-z_-][\w-]*/.exec(selector.slice(i + 1));
      // Escaped identifiers (e.g. ".foo\:bar") are left unkeyed for safety.
      if (!m || selector[i + 1 + m[0].length] === '\\') continue;
      if (ch === '#') return `#${m[0]}`;
      firstClass ??= `.${m[0]}`;
      i += m[0].length;
    }
  }
  return firstClass;
}

function push(map: Record<string, string[]>, key: string, value: string): void {
  (map[key] ??= []).push(value);
}

/** Builds a CosmeticBundle from parsed cosmetic filters and exception flags. */
export function compileCosmetic(filters: CosmeticFilter[], flags: Map<string, number>): CosmeticBundle {
  const bundle = emptyCosmeticBundle();
  const globalExceptions = new Set<string>();
  const generic = new Set<string>();
  const specific = new Map<string, Set<string>>();
  const exceptions = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    s.add(v);
  };

  for (const f of filters) {
    for (const selector of splitSelectorList(f.selector)) {
      if (f.exception) {
        if (f.include.length === 0) globalExceptions.add(selector);
        for (const d of f.include) add(exceptions, d, selector);
        continue;
      }
      if (f.include.length === 0) generic.add(selector);
      for (const d of f.include) add(specific, d, selector);
      for (const d of f.exclude) add(exceptions, d, selector);
    }
  }

  for (const selector of [...generic].sort()) {
    if (globalExceptions.has(selector)) continue;
    const key = extractSelectorKey(selector);
    if (key) push(bundle.genericKeyed, key, selector);
    else bundle.genericUnkeyed.push(selector);
  }
  for (const [host, set] of [...specific].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const list = [...set].filter((s) => !globalExceptions.has(s)).sort();
    if (list.length) bundle.specific[host] = list;
  }
  for (const [host, set] of [...exceptions].sort(([a], [b]) => (a < b ? -1 : 1))) {
    bundle.exceptions[host] = [...set].sort();
  }
  for (const [host, bits] of [...flags].sort(([a], [b]) => (a < b ? -1 : 1))) bundle.flags[host] = bits;
  return bundle;
}

export function countCosmetic(b: CosmeticBundle): { generic: number; specific: number; exceptions: number } {
  let generic = b.genericUnkeyed.length;
  for (const list of Object.values(b.genericKeyed)) generic += list.length;
  let specific = 0;
  for (const list of Object.values(b.specific)) specific += list.length;
  let exceptions = 0;
  for (const list of Object.values(b.exceptions)) exceptions += list.length;
  return { generic, specific, exceptions };
}

// ---------------------------------------------------------------------------
// Runtime engine
// ---------------------------------------------------------------------------

const HIDE_DECLARATION = '{display:none!important}';

/**
 * Emits one rule per selector. A single invalid selector in a grouped rule
 * would invalidate the whole group, and per-selector rules let Chrome bucket
 * them by their rightmost id/class for fast style matching.
 */
export function selectorsToCss(selectors: Iterable<string>): string {
  let css = '';
  for (const s of selectors) css += `${s}${HIDE_DECLARATION}\n`;
  return css;
}

export interface FrameCosmetics {
  /** CSS to inject immediately (specific + unkeyed generic). */
  css: string;
  /** Whether the content script should collect tokens for generic filters. */
  generic: boolean;
}

export class CosmeticEngine {
  private readonly keyed = new Map<string, string[]>();
  private readonly unkeyed: string[] = [];
  private readonly specific = new Map<string, string[]>();
  private readonly exceptions = new Map<string, string[]>();
  private readonly flags = new Map<string, number>();
  private unkeyedCss: string | null = null;

  constructor(bundles: CosmeticBundle[]) {
    const unkeyedSet = new Set<string>();
    for (const b of bundles) {
      for (const [k, list] of Object.entries(b.genericKeyed)) appendUnique(this.keyed, k, list);
      for (const s of b.genericUnkeyed) unkeyedSet.add(s);
      for (const [k, list] of Object.entries(b.specific)) appendUnique(this.specific, k, list);
      for (const [k, list] of Object.entries(b.exceptions)) appendUnique(this.exceptions, k, list);
      for (const [k, bits] of Object.entries(b.flags)) this.flags.set(k, (this.flags.get(k) ?? 0) | bits);
    }
    this.unkeyed = [...unkeyedSet];
  }

  get stats(): { keyedTokens: number; unkeyed: number; specificHosts: number } {
    return { keyedTokens: this.keyed.size, unkeyed: this.unkeyed.length, specificHosts: this.specific.size };
  }

  private context(host: string): { flags: number; exceptions: Set<string> | null; keys: string[] } {
    const keys = hostLookupKeys(host);
    let flags = 0;
    let exceptions: Set<string> | null = null;
    for (const k of keys) {
      flags |= this.flags.get(k) ?? 0;
      const ex = this.exceptions.get(k);
      if (ex) {
        exceptions ??= new Set();
        for (const s of ex) exceptions.add(s);
      }
    }
    return { flags, exceptions, keys };
  }

  /** Cosmetics to inject when a frame for `host` starts loading. */
  getFrameCosmetics(host: string): FrameCosmetics {
    const { flags, exceptions, keys } = this.context(host);
    if (flags & CosmeticFlag.ELEMHIDE) return { css: '', generic: false };

    const selectors: string[] = [];
    if (!(flags & CosmeticFlag.SPECIFICHIDE)) {
      for (const k of keys) {
        const list = this.specific.get(k);
        if (list) for (const s of list) if (!exceptions?.has(s)) selectors.push(s);
      }
    }
    const generic = !(flags & CosmeticFlag.GENERICHIDE);
    let css = selectorsToCss(selectors);
    if (generic) {
      if (!exceptions) css += (this.unkeyedCss ??= selectorsToCss(this.unkeyed));
      else css += selectorsToCss(this.unkeyed.filter((s) => !exceptions.has(s)));
    }
    return { css, generic };
  }

  /** CSS for generic selectors keyed by tokens observed in the page. */
  getGenericCssForTokens(host: string, tokens: string[]): string {
    const { flags, exceptions } = this.context(host);
    if (flags & (CosmeticFlag.ELEMHIDE | CosmeticFlag.GENERICHIDE)) return '';
    const selectors: string[] = [];
    for (const t of tokens) {
      const list = this.keyed.get(t);
      if (list) for (const s of list) if (!exceptions?.has(s)) selectors.push(s);
    }
    return selectorsToCss(selectors);
  }
}

function appendUnique(map: Map<string, string[]>, key: string, list: string[]): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, list.slice());
    return;
  }
  const seen = new Set(existing);
  for (const s of list) if (!seen.has(s)) existing.push(s);
}
