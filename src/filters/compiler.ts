/**
 * Filter-list compiler: raw list text → { DNR rules, cosmetic bundle, stats }.
 * Used both at build time (Node, static rulesets) and at runtime (service
 * worker, list updates and user filters), so it must stay platform-neutral.
 */
import type { DnrRule, PriorityProfile } from './dnr-types.ts';
import { compilePopupFilters, type PopupBundle } from './matcher.ts';
import { badfilterKey, parseLine, type CosmeticFilter, type NetworkFilter } from './parser.ts';
import { convertNetworkFilter, optimizeRules } from './network.ts';
import { compileCosmetic, countCosmetic, type CosmeticBundle } from './cosmetic.ts';
import { hostMatches } from './domains.ts';

export interface CompileOptions {
  /** First rule id to assign (rule ids must be unique within a ruleset / dynamic set). */
  startId?: number;
  /** Maximum number of DNR rules to emit (excess rules are dropped, regex first). */
  maxRules?: number;
  /** Maximum number of regex rules (Chrome: 1000 per static ruleset / dynamic set). */
  maxRegexRules?: number;
  /** Priority tier for block rules (see PRIORITY in dnr-types.ts). */
  profile?: PriorityProfile;
  /** List syntax; 'auto' detects plain domain lists. */
  format?: 'abp' | 'domains' | 'auto';
}

/** Detects host-per-line lists (no ABP header, mostly bare hostnames). */
export function detectFormat(text: string): 'abp' | 'domains' {
  if (/^\s*\[Adblock/i.test(text)) return 'abp';
  let hosts = 0;
  let total = 0;
  for (const line of text.split(/\r?\n/, 2000)) {
    const t = line.replace(/\s+#.*$/, '').trim();
    if (!t || t.startsWith('!') || t.startsWith('#')) continue;
    total++;
    if (/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i.test(t)) hosts++;
    if (total >= 300) break;
  }
  return total > 0 && hosts / total >= 0.8 ? 'domains' : 'abp';
}

export interface CompileStats {
  lines: number;
  networkFilters: number;
  cosmeticFilters: number;
  rulesEmitted: number;
  regexRules: number;
  popupFilters: number;
  badfiltered: number;
  droppedForQuota: number;
  skipped: Record<string, number>;
  cosmetic: { generic: number; specific: number; exceptions: number };
}

export interface CompileResult {
  rules: DnrRule[];
  cosmetic: CosmeticBundle;
  popup: PopupBundle;
  stats: CompileStats;
}

const COSMETIC_HOST_RE = /^\|\|([a-z0-9.\-_]+)\^?\|?$/;

export function compileFilterList(text: string, options: CompileOptions = {}): CompileResult {
  const { startId = 1, maxRules = Infinity, maxRegexRules = 1000, profile = 'standard' } = options;
  const format = !options.format || options.format === 'auto' ? detectFormat(text) : options.format;
  const lines = text.split(/\r?\n/);
  const skipped: Record<string, number> = {};
  const network: NetworkFilter[] = [];
  const cosmetic: CosmeticFilter[] = [];
  const popups: NetworkFilter[] = [];
  const badfilters = new Set<string>();
  const flags = new Map<string, number>();

  for (const line of lines) {
    const res = parseLine(line, { format });
    switch (res.kind) {
      case 'popup':
        popups.push(res.filter);
        break;
      case 'network':
        network.push(res.filter);
        break;
      case 'cosmetic':
        cosmetic.push(res.filter);
        break;
      case 'badfilter':
        badfilters.add(res.key);
        break;
      case 'skip':
        skipped[res.reason] = (skipped[res.reason] ?? 0) + 1;
        break;
    }
  }

  let badfiltered = 0;
  const bodies: Omit<DnrRule, 'id'>[] = [];
  for (const f of network) {
    if (badfilters.size && badfilters.has(filterBadfilterKey(f.raw))) {
      badfiltered++;
      continue;
    }
    if (f.exception && f.cosmeticFlags) recordCosmeticFlags(f, flags);
    const res = convertNetworkFilter(f, profile);
    if (res.ok) bodies.push(res.rule);
    else if (res.reason !== 'cosmetic-only-exception') skipped[res.reason] = (skipped[res.reason] ?? 0) + 1;
  }

  let optimized = optimizeRules(bodies);

  // Enforce regex and total quotas. Regex rules are the most expensive and the
  // most likely to be rejected, so they are trimmed first.
  let regexCount = 0;
  let dropped = 0;
  optimized = optimized.filter((r) => {
    if (!r.condition.regexFilter) return true;
    if (regexCount < maxRegexRules) {
      regexCount++;
      return true;
    }
    dropped++;
    return false;
  });
  if (optimized.length > maxRules) {
    // Keep exceptions first (they prevent breakage), then blocks.
    const exceptions = optimized.filter((r) => r.action.type !== 'block');
    const blocks = optimized.filter((r) => r.action.type === 'block');
    const kept = [...exceptions, ...blocks].slice(0, maxRules);
    dropped += optimized.length - kept.length;
    optimized = kept;
    regexCount = optimized.filter((r) => r.condition.regexFilter).length;
  }

  const rules: DnrRule[] = optimized.map((r, i) => ({ id: startId + i, ...r }));
  const bundle = compileCosmetic(cosmetic, flags);

  const popup = compilePopupFilters(popups.filter((f) => !badfilters.has(filterBadfilterKey(f.raw))));

  return {
    rules,
    cosmetic: bundle,
    popup,
    stats: {
      lines: lines.length,
      networkFilters: network.length,
      cosmeticFilters: cosmetic.length,
      rulesEmitted: rules.length,
      regexRules: regexCount,
      popupFilters: popups.length,
      badfiltered,
      droppedForQuota: dropped,
      skipped,
      cosmetic: countCosmetic(bundle),
    },
  };
}

function filterBadfilterKey(raw: string): string {
  const exception = raw.startsWith('@@');
  const body = exception ? raw.slice(2) : raw;
  const idx = body.lastIndexOf('$');
  const pattern = idx > 0 ? body.slice(0, idx) : body;
  const opts = idx > 0 ? body.slice(idx + 1).split(',').map((o) => o.trim().toLowerCase()) : [];
  return badfilterKey((exception ? '@@' : '') + pattern, opts);
}

/** Maps `@@||host^$elemhide`-style exceptions to per-host cosmetic flags. */
function recordCosmeticFlags(f: NetworkFilter, flags: Map<string, number>): void {
  const hosts: string[] = [];
  const m = COSMETIC_HOST_RE.exec(f.pattern.toLowerCase());
  if (m) hosts.push(m[1]!);
  else if (!f.pattern && f.initiatorDomains) hosts.push(...f.initiatorDomains);
  for (const h of hosts) flags.set(h, (flags.get(h) ?? 0) | f.cosmeticFlags);
}

/** Convenience used by the UI: does a cosmetic flag apply to a host? */
export function flagsForHost(bundle: CosmeticBundle, host: string): number {
  let bits = 0;
  for (const [h, b] of Object.entries(bundle.flags)) if (hostMatches(host, h)) bits |= b;
  return bits;
}
