/**
 * Platform-neutral mirror of the subset of chrome.declarativeNetRequest.Rule
 * that the converter emits. Kept separate from @types/chrome so the compiler
 * can run in Node at build time; the shapes are structurally compatible.
 */

export type DnrResourceType =
  | 'main_frame' | 'sub_frame' | 'stylesheet' | 'script' | 'image' | 'font'
  | 'object' | 'xmlhttprequest' | 'ping' | 'csp_report' | 'media'
  | 'websocket' | 'webtransport' | 'webbundle' | 'other';

export type DnrActionType = 'block' | 'allow' | 'allowAllRequests' | 'redirect' | 'modifyHeaders';

export interface DnrCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  domainType?: 'firstParty' | 'thirdParty';
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  resourceTypes?: DnrResourceType[];
  excludedResourceTypes?: DnrResourceType[];
  requestMethods?: string[];
  excludedRequestMethods?: string[];
}

export interface DnrAction {
  type: DnrActionType;
  redirect?: { transform?: { queryTransform?: { removeParams?: string[] } } };
  requestHeaders?: { header: string; operation: 'set' | 'remove' | 'append'; value?: string }[];
}

export interface DnrRule {
  id: number;
  priority: number;
  action: DnrAction;
  condition: DnrCondition;
}

/**
 * Rule priority tiers. Higher wins; at equal priority Chrome prefers
 * allow > allowAllRequests > block > redirect/modifyHeaders.
 *
 * Tiering by *category* is what makes per-site controls possible with DNR:
 * a per-site `allowAllRequests` rule at `siteTrackingAllow` overrides
 * privacy blocks (below it) but not ad blocks (above it), so a user can turn
 * tracking protection off for one site while still blocking its ads.
 *
 *   privacyBlock (10) < siteTrackingAllow (20) < block (30) < exception (40)
 *     < important (50) < security (60) < user site allow (1e6) < global pause (2e6)
 *
 * Filter-list exceptions (`@@`) sit above every ordinary block, matching
 * ABP semantics where an exception from any list cancels blocks from all
 * lists. `$important` blocks override exceptions, and malicious-domain blocks
 * override both. Only an explicit user decision (site disabled, paused) beats
 * security blocks.
 */
export const PRIORITY = {
  privacyBlock: 10,
  siteTrackingAllow: 20,
  block: 30,
  exception: 40,
  important: 50,
  security: 60,
  /** Per-site "disable protection here" and temporary pauses. */
  userAllowlist: 1_000_000,
  /** Global pause switch. */
  globalPause: 2_000_000,
} as const;

/** Which tier a list's ordinary block rules use. */
export type PriorityProfile = 'standard' | 'privacy' | 'security';

export function blockPriority(profile: PriorityProfile, important: boolean): number {
  if (profile === 'security') return PRIORITY.security;
  if (important) return PRIORITY.important;
  return profile === 'privacy' ? PRIORITY.privacyBlock : PRIORITY.block;
}

/** Every resource type except main_frame: Chrome's default when resourceTypes is omitted. */
export const ALL_RESOURCE_TYPES: readonly DnrResourceType[] = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];

export const ALL_SUBRESOURCE_TYPES: readonly DnrResourceType[] = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
];

/** Stable identity of a rule, ignoring its id. Used for de-duplication and diffing. */
export function ruleKey(rule: Omit<DnrRule, 'id'> | DnrRule): string {
  const { priority, action, condition } = rule;
  return JSON.stringify([priority, action, condition]);
}
