/**
 * Classifies a blocked request into a statistics category.
 *
 * DNR does not tell packed extensions which rule matched, so the category is
 * inferred locally: first from a host index built from the bundled lists'
 * domain rules (scripts/compile-filters.ts → filters/categories.json), then
 * from request type and URL heuristics. Labelled "estimated" in the UI.
 */
import type { BlockCategory } from '../shared/catalog.ts';
import type { DnrRule } from './dnr-types.ts';

export type CategoryIndexJson = Partial<Record<BlockCategory, string[]>>;

/** Precedence when a host appears in several lists. */
const PRECEDENCE: BlockCategory[] = ['malicious', 'fingerprinting', 'trackers', 'ads', 'annoyances'];

const TRACKER_HINT = /(?:analytic|track|pixel|beacon|collect|telemetry|metric|stats?[./?]|tag(?:manager)?|insight|fingerprint|\/log(?:ging)?[/?.]|event)/i;

/** Hosts targeted by a list's block rules (pure-domain and "||host" prefix rules). */
export function hostsFromRules(rules: Pick<DnrRule, 'action' | 'condition'>[]): Set<string> {
  const out = new Set<string>();
  for (const r of rules) {
    if (r.action.type !== 'block') continue;
    const c = r.condition;
    if (c.requestDomains && !c.urlFilter && !c.initiatorDomains) for (const d of c.requestDomains) out.add(d);
    const m = c.urlFilter ? /^\|\|([a-z0-9.-]+)[\^/]/.exec(c.urlFilter) : null;
    if (m && m[1]!.includes('.')) out.add(m[1]!);
  }
  return out;
}

export class Classifier {
  private readonly index = new Map<string, BlockCategory>();

  constructor(json: CategoryIndexJson) {
    // Insert lowest precedence first so higher precedence overwrites.
    for (const cat of [...PRECEDENCE].reverse()) for (const h of json[cat] ?? []) this.index.set(h, cat);
  }

  classify(url: string, type: string): BlockCategory {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return 'other';
    }
    for (let h = host; ; ) {
      const hit = this.index.get(h);
      if (hit) return hit;
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    if (type === 'main_frame') return 'malicious';
    if (type === 'ping' || type === 'csp_report') return 'trackers';
    if (TRACKER_HINT.test(url)) return 'trackers';
    return 'ads';
  }
}
