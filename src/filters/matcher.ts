/**
 * URL matching for ABP patterns outside of DNR: used by the pop-up blocker
 * (DNR cannot distinguish pop-ups) and kept small and allocation-light.
 */
import type { NetworkFilter } from './parser.ts';
import { hostMatches } from './domains.ts';

/** Converts an ABP pattern (e.g. "||ads.example^") into a RegExp. */
export function patternToRegExp(pattern: string, matchCase = false): RegExp {
  let p = pattern;
  let prefix = '';
  let suffix = '';
  if (p.startsWith('||')) {
    prefix = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?';
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    prefix = '^';
    p = p.slice(1);
  }
  if (p.endsWith('|')) {
    suffix = '$';
    p = p.slice(0, -1);
  }
  const body = p
    .replace(/[.+?${}()[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\^/g, '(?:[^\\w\\-.%]|$)');
  return new RegExp(prefix + body + suffix, matchCase ? '' : 'i');
}

export interface PopupRule {
  pattern: string;
  matchCase?: boolean;
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  thirdParty?: boolean;
}

export interface PopupBundle {
  /** Hosts whose pop-ups are always blocked (pure "||host^$popup"). */
  domains: string[];
  rules: PopupRule[];
  exceptions: PopupRule[];
}

export function emptyPopupBundle(): PopupBundle {
  return { domains: [], rules: [], exceptions: [] };
}

const PURE_HOST_RE = /^\|\|([a-z0-9.\-_]+)\^\|?$/i;

export function compilePopupFilters(filters: NetworkFilter[]): PopupBundle {
  const bundle = emptyPopupBundle();
  const domains = new Set<string>();
  for (const f of filters) {
    const pure = PURE_HOST_RE.exec(f.pattern);
    const constrained = f.initiatorDomains || f.excludedInitiatorDomains || f.thirdParty !== undefined;
    if (!f.exception && pure && !constrained) {
      domains.add(pure[1]!.toLowerCase());
      continue;
    }
    if (f.pattern.replace(/[|*^]/g, '').length < 4) continue; // too broad to be safe
    const rule: PopupRule = { pattern: f.pattern };
    if (f.matchCase) rule.matchCase = true;
    if (f.initiatorDomains) rule.initiatorDomains = f.initiatorDomains;
    if (f.excludedInitiatorDomains) rule.excludedInitiatorDomains = f.excludedInitiatorDomains;
    if (f.thirdParty !== undefined) rule.thirdParty = f.thirdParty;
    (f.exception ? bundle.exceptions : bundle.rules).push(rule);
  }
  bundle.domains = [...domains].sort();
  return bundle;
}

/** Registrable-domain approximation used for first/third-party decisions. */
export function siteOf(host: string): string {
  const labels = host.split('.');
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1]!)) return host;
  // Handle common two-label public suffixes (co.uk, com.au, …) without a PSL.
  const sld = labels[labels.length - 2]!;
  const take = sld.length <= 3 && labels[labels.length - 1]!.length === 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}

export function isThirdParty(requestHost: string, documentHost: string): boolean {
  return siteOf(requestHost) !== siteOf(documentHost);
}

export class PopupMatcher {
  private readonly domains: Set<string>;
  private readonly rules: { rule: PopupRule; re: RegExp }[];
  private readonly exceptions: { rule: PopupRule; re: RegExp }[];

  constructor(bundles: PopupBundle[]) {
    this.domains = new Set(bundles.flatMap((b) => b.domains));
    const compile = (r: PopupRule) => {
      try {
        return { rule: r, re: patternToRegExp(r.pattern, r.matchCase) };
      } catch {
        return null;
      }
    };
    this.rules = bundles.flatMap((b) => b.rules).map(compile).filter((x): x is NonNullable<typeof x> => !!x);
    this.exceptions = bundles.flatMap((b) => b.exceptions).map(compile).filter((x): x is NonNullable<typeof x> => !!x);
  }

  get size(): number {
    return this.domains.size + this.rules.length;
  }

  private applies(rule: PopupRule, targetHost: string, openerHost: string): boolean {
    if (rule.initiatorDomains && !rule.initiatorDomains.some((d) => hostMatches(openerHost, d))) return false;
    if (rule.excludedInitiatorDomains?.some((d) => hostMatches(openerHost, d))) return false;
    if (rule.thirdParty !== undefined && rule.thirdParty !== isThirdParty(targetHost, openerHost)) return false;
    return true;
  }

  /** Should a pop-up to `url`, opened by a page on `openerHost`, be blocked? */
  shouldBlock(url: string, openerHost: string): boolean {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return false;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    const host = target.hostname;
    // Never block pop-ups to the opener's own site (login flows, print views, …).
    if (!isThirdParty(host, openerHost)) return false;
    for (const e of this.exceptions) if (e.re.test(url) && this.applies(e.rule, host, openerHost)) return false;
    let h = host;
    for (;;) {
      if (this.domains.has(h)) return true;
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    return this.rules.some((r) => r.re.test(url) && this.applies(r.rule, host, openerHost));
  }
}
