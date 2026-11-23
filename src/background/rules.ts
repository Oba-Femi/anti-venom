/**
 * Declarative Net Request controller: the only module that talks to
 * chrome.declarativeNetRequest. It owns the dynamic rule-id layout
 * (see RULE_IDS) and exposes idempotent "make it so" operations.
 */
import { LIMITS, RULE_IDS, slotRange } from '../shared/constants.ts';
import { log } from '../shared/logger.ts';
import { PRIORITY, type DnrRule } from '../filters/dnr-types.ts';
import type { QuotaInfo } from '../shared/types.ts';
import { buildPauseRules, buildSiteRules, SITE_RULE_IDS, type SiteOverrides } from '../shared/site-policy.ts';

type Rule = chrome.declarativeNetRequest.Rule;
const dnr = chrome.declarativeNetRequest;

export function maxDynamicRules(): number {
  return dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? LIMITS.dynamicRulesFallback;
}

export function maxRegexRules(): number {
  return dnr.MAX_NUMBER_OF_REGEX_RULES ?? LIMITS.regexRulesFallback;
}

// ---------------------------------------------------------------------------
// Static rulesets
// ---------------------------------------------------------------------------

/** Brings the set of enabled static rulesets in line with `desired`. */
export async function setEnabledRulesets(desired: string[], available: string[]): Promise<void> {
  const current = new Set(await dnr.getEnabledRulesets());
  const want = new Set(desired.filter((id) => available.includes(id)));
  const enableRulesetIds = [...want].filter((id) => !current.has(id));
  const disableRulesetIds = [...current].filter((id) => !want.has(id));
  if (!enableRulesetIds.length && !disableRulesetIds.length) return;
  try {
    await dnr.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    log.debug('rulesets updated', { enableRulesetIds, disableRulesetIds });
  } catch (err) {
    // Most likely the global static-rule pool is exhausted. Retry without the
    // additions so disabling (at least) takes effect, then surface the error.
    if (disableRulesetIds.length) await dnr.updateEnabledRulesets({ disableRulesetIds }).catch(() => {});
    throw err;
  }
}

export async function getDisabledStaticRuleIds(rulesetId: string): Promise<number[]> {
  try {
    return await dnr.getDisabledRuleIds({ rulesetId });
  } catch {
    return [];
  }
}

/** Replaces the set of individually disabled rules in a static ruleset. */
export async function setDisabledStaticRules(rulesetId: string, ids: number[]): Promise<void> {
  const current = await getDisabledStaticRuleIds(rulesetId);
  const want = new Set(ids.slice(0, LIMITS.disabledStaticPerRuleset));
  const enableRuleIds = current.filter((id) => !want.has(id));
  const currentSet = new Set(current);
  const disableRuleIds = [...want].filter((id) => !currentSet.has(id));
  if (!enableRuleIds.length && !disableRuleIds.length) return;
  await dnr.updateStaticRules({ rulesetId, enableRuleIds, disableRuleIds });
}

export async function getAvailableStaticRuleCount(): Promise<number | null> {
  try {
    return await dnr.getAvailableStaticRuleCount();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dynamic rules
// ---------------------------------------------------------------------------

export async function getDynamicRules(): Promise<Rule[]> {
  return dnr.getDynamicRules();
}

/** Atomically replaces every dynamic rule whose id is within [start, end]. */
export async function replaceDynamicRange(start: number, end: number, rules: Rule[]): Promise<void> {
  const existing = await dnr.getDynamicRules();
  const removeRuleIds = existing.filter((r) => r.id >= start && r.id <= end).map((r) => r.id);
  for (const r of rules) {
    if (r.id < start || r.id > end) throw new Error(`Rule id ${r.id} outside range ${start}-${end}`);
  }
  if (!removeRuleIds.length && !rules.length) return;
  // updateDynamicRules is atomic: on failure nothing changes, so previously
  // working rules stay active.
  await dnr.updateDynamicRules({ removeRuleIds, addRules: rules });
}

/** Assigns sequential ids from `start` to rule bodies. */
export function withIds(rules: Omit<DnrRule, 'id'>[], start: number): Rule[] {
  return rules.map((r, i) => ({ ...r, id: start + i }) as Rule);
}

/**
 * Drops regex rules Chrome cannot compile. A single unsupported regex would
 * make updateDynamicRules reject the whole batch.
 */
export async function filterSupportedRegex<T extends Omit<DnrRule, 'id'>>(rules: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const r of rules) {
    const regex = r.condition.regexFilter;
    if (!regex) {
      out.push(r);
      continue;
    }
    try {
      const res = await dnr.isRegexSupported({ regex, isCaseSensitive: !!r.condition.isUrlFilterCaseSensitive });
      if (res.isSupported) out.push(r);
      else log.debug('dropping unsupported regex', regex, res.reason);
    } catch {
      // Treat as unsupported.
    }
  }
  return out;
}

/**
 * Global pause: a single top-priority allow rule overrides every block from
 * dynamic rules (static rulesets are additionally disabled by the caller).
 */
export async function setGlobalPauseRule(paused: boolean): Promise<void> {
  const rules: Rule[] = paused
    ? [
        {
          id: RULE_IDS.globalPause,
          priority: PRIORITY.globalPause,
          action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
          condition: { urlFilter: '*' },
        } as Rule,
      ]
    : [];
  await replaceDynamicRange(RULE_IDS.globalPause, RULE_IDS.globalPause, rules);
}

/** Persistent per-site policies (protection off / tracking off). */
export async function setSiteRules(sites: Record<string, SiteOverrides>): Promise<void> {
  await replaceDynamicRange(RULE_IDS.siteRulesStart, RULE_IDS.siteRulesEnd, buildSiteRules(sites) as Rule[]);
}

/** Temporary pauses as session rules: Chrome drops them on browser restart. */
export async function setPauseRules(pauses: Record<string, number>): Promise<void> {
  const existing = await dnr.getSessionRules();
  const removeRuleIds = existing.filter((r) => r.id === SITE_RULE_IDS.paused).map((r) => r.id);
  const addRules = buildPauseRules(pauses) as Rule[];
  if (!removeRuleIds.length && !addRules.length) return;
  await dnr.updateSessionRules({ removeRuleIds, addRules });
}

export async function setUserFilterRules(rules: Omit<DnrRule, 'id'>[]): Promise<number> {
  const supported = await filterSupportedRegex(rules);
  const capped = supported.slice(0, LIMITS.userFilterRules);
  await replaceDynamicRange(RULE_IDS.userFiltersStart, RULE_IDS.userFiltersEnd, withIds(capped, RULE_IDS.userFiltersStart));
  return capped.length;
}

export async function setListSlotRules(slot: number, rules: Omit<DnrRule, 'id'>[]): Promise<void> {
  const { start, end } = slotRange(slot);
  await replaceDynamicRange(start, end, withIds(rules, start));
}

export async function clearListSlot(slot: number): Promise<void> {
  const { start, end } = slotRange(slot);
  await replaceDynamicRange(start, end, []);
}

/** Counts dynamic rules (and regex rules) outside an optional excluded slot. */
export async function dynamicUsage(excludeSlot?: number): Promise<{ total: number; regex: number }> {
  const rules = await dnr.getDynamicRules();
  const range = excludeSlot === undefined ? null : slotRange(excludeSlot);
  let total = 0;
  let regex = 0;
  for (const r of rules) {
    if (range && r.id >= range.start && r.id <= range.end) continue;
    total++;
    if (r.condition.regexFilter) regex++;
  }
  return { total, regex };
}

export async function getQuotaInfo(): Promise<QuotaInfo> {
  const usage = await dynamicUsage();
  return {
    dynamicUsed: usage.total,
    dynamicMax: maxDynamicRules(),
    regexUsed: usage.regex,
    regexMax: maxRegexRules(),
    staticAvailable: await getAvailableStaticRuleCount(),
  };
}

/** Removes every dynamic and session rule (used by "restore defaults"). */
export async function clearAllDynamicRules(): Promise<void> {
  const existing = await dnr.getDynamicRules();
  if (existing.length) await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id) });
  const session = await dnr.getSessionRules();
  if (session.length) await dnr.updateSessionRules({ removeRuleIds: session.map((r) => r.id) });
}
