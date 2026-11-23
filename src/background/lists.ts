/**
 * Filter-list manager.
 *
 * Bundled lists (EasyList, EasyPrivacy) ship as static DNR rulesets compiled
 * at build time. They can still be refreshed between extension releases:
 * the new list is compiled, diffed against the bundled ruleset, and only the
 * difference is applied —
 *   - rules that are new upstream   → dynamic rules in the list's id slot
 *   - rules removed upstream        → disabled via updateStaticRules
 * This keeps rule usage low and means a failed download never touches the
 * working bundled rules.
 *
 * Non-bundled lists (presets and user-added URLs) are downloaded, compiled and
 * installed entirely as dynamic rules within the remaining dynamic budget.
 *
 * Every mutation goes through `serialize()` so concurrent UI actions and
 * alarm-driven updates cannot interleave.
 */
import { LIST_CATALOG, findListDefinition, isPrivacyCategory } from '../shared/catalog.ts';
import { desiredFeatureRulesets } from './privacy.ts';
import type { PriorityProfile } from '../filters/dnr-types.ts';
import {
  DEFAULT_LIST_EXPIRY_MS, DOWNLOAD_TIMEOUT_MS, LIMITS, UPDATE_RETRY_BACKOFF_MS, slotRange,
} from '../shared/constants.ts';
import { errorMessage, log } from '../shared/logger.ts';
import type { BundledListMeta, ListState, Settings } from '../shared/types.ts';
import { compileFilterList } from '../filters/compiler.ts';
import { ruleKey, type DnrRule } from '../filters/dnr-types.ts';
import { looksLikeFilterList, parseExpires, parseVersion } from '../filters/validate.ts';
import {
  clearListSlot, dynamicUsage, filterSupportedRegex, getDynamicRules, maxDynamicRules, maxRegexRules,
  setDisabledStaticRules, setEnabledRulesets, setListSlotRules,
} from './rules.ts';
import { getListData, getStoredLists, removeListData, saveListData, saveLists, type ListData } from './storage.ts';

let chain: Promise<unknown> = Promise.resolve();
/** Lists currently downloading (in-memory only; reported to the UI). */
const updating = new Set<string>();

/** Runs `fn` after every previously queued list operation has finished. */
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

let bundledMetaPromise: Promise<Record<string, BundledListMeta>> | null = null;

export function getBundledMeta(): Promise<Record<string, BundledListMeta>> {
  bundledMetaPromise ??= fetch(chrome.runtime.getURL('filters/bundled.json'))
    .then((r) => r.json() as Promise<Record<string, BundledListMeta>>)
    .catch((err) => {
      log.error('Could not read bundled list metadata', err);
      bundledMetaPromise = null;
      return {};
    });
  return bundledMetaPromise;
}

/** Ruleset ids declared in the manifest. */
export function availableRulesets(): string[] {
  const dnrManifest = chrome.runtime.getManifest().declarative_net_request as
    | { rule_resources?: { id: string }[] }
    | undefined;
  return dnrManifest?.rule_resources?.map((r) => r.id) ?? [];
}

export function isListActive(list: ListState, settings: Settings): boolean {
  return settings.enabled && list.enabled && (!isPrivacyCategory(list.category) || settings.trackingProtection);
}

/** Priority tier used when compiling a list (see PRIORITY in dnr-types.ts). */
export function profileFor(list: Pick<ListState, 'category'>): PriorityProfile {
  return list.category === 'privacy' ? 'privacy' : list.category === 'security' ? 'security' : 'standard';
}

function freeSlot(lists: ListState[]): number {
  const used = new Set(lists.map((l) => l.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

/** Loads list state, reconciling it with the catalog (new lists get added, retired ones removed). */
export async function getLists(): Promise<ListState[]> {
  const stored = (await getStoredLists()) ?? [];
  const meta = await getBundledMeta();
  const out: ListState[] = [];
  let changed = stored.length === 0;

  for (const def of LIST_CATALOG) {
    let state = stored.find((l) => l.id === def.id);
    if (!state) {
      changed = true;
      state = {
        id: def.id,
        title: def.title,
        url: def.url,
        homepage: def.homepage,
        category: def.category,
        blockCategory: def.blockCategory,
        bundled: def.bundled,
        custom: false,
        enabled: def.defaultEnabled,
        slot: freeSlot([...stored, ...out]),
        ruleCount: 0,
        cosmeticCount: 0,
        dynamicRuleCount: 0,
        disabledStaticCount: 0,
      };
    }
    // Catalog metadata is authoritative for built-in lists.
    state = {
      ...state,
      title: def.title,
      description: def.description,
      url: def.url,
      homepage: def.homepage,
      license: def.license,
      attribution: def.attribution,
      category: def.category,
      blockCategory: def.blockCategory,
      bundled: def.bundled,
    };
    const m = meta[def.id];
    if (def.bundled && m && state.dynamicRuleCount === 0 && state.disabledStaticCount === 0) {
      state.ruleCount = m.ruleCount;
      state.cosmeticCount = m.cosmeticCount;
      state.popupCount = m.popupCount;
      state.unsupported ??= m.unsupported;
      state.version ??= m.version;
      state.lastUpdated ??= m.compiledAt;
    }
    out.push(state);
  }
  for (const s of stored) if (s.custom) out.push(s);
  for (const s of out) s.updating = updating.has(s.id);
  if (changed) await saveLists(out);
  return out;
}

async function mutateList(id: string, fn: (l: ListState) => void): Promise<ListState[]> {
  const lists = await getLists();
  const list = lists.find((l) => l.id === id);
  if (!list) throw new Error(`Unknown filter list: ${id}`);
  fn(list);
  await saveLists(lists);
  return lists;
}

// ---------------------------------------------------------------------------
// Applying list state to DNR
// ---------------------------------------------------------------------------

/**
 * Makes DNR reflect which lists are active: static rulesets for bundled lists
 * and dynamic slots for runtime data. Idempotent and cheap when nothing changed.
 */
export async function syncListRules(settings: Settings, featureRulesets: string[] = []): Promise<void> {
  const lists = await getLists();
  const available = availableRulesets();
  const listRulesets = lists.filter((l) => l.bundled && isListActive(l, settings)).map((l) => l.id);
  const desired = [...listRulesets, ...featureRulesets];
  try {
    await setEnabledRulesets(desired, available);
  } catch (err) {
    log.error('Failed to enable static rulesets', err);
    for (const l of lists) if (listRulesets.includes(l.id)) l.lastError = `Could not enable ruleset: ${errorMessage(err)}`;
  }

  const dynamic = await getDynamicRules();
  const slotCount = (slot: number) => {
    const { start, end } = slotRange(slot);
    return dynamic.filter((r) => r.id >= start && r.id <= end).length;
  };

  for (const list of lists) {
    const active = isListActive(list, settings);
    const installed = slotCount(list.slot);
    if (!active) {
      if (installed) await clearListSlot(list.slot).catch((e) => log.warn('clear slot failed', list.id, e));
      continue;
    }
    const data = await getListData(list.id);
    if (!data) continue;
    try {
      if (installed !== list.dynamicRuleCount) await installListData(list, data);
      if (list.bundled) await setDisabledStaticRules(list.id, data.disabledStatic);
    } catch (err) {
      list.lastError = `Could not apply rules: ${errorMessage(err)}`;
      log.error('Failed to install list rules', list.id, err);
    }
  }
  await saveLists(lists);
}

/** Installs a list's dynamic rules, trimming to the available budget. */
async function installListData(list: ListState, data: ListData): Promise<{ installed: number; trimmed: number }> {
  const usage = await dynamicUsage(list.slot);
  const budget = Math.max(0, maxDynamicRules() - LIMITS.reservedDynamic - usage.total);
  const regexBudget = Math.max(0, maxRegexRules() - LIMITS.reservedRegex - usage.regex);

  let rules = await filterSupportedRegex(data.rules);
  let regexSeen = 0;
  rules = rules.filter((r) => !r.condition.regexFilter || ++regexSeen <= regexBudget);
  let trimmed = data.rules.length - rules.length;
  if (rules.length > budget) {
    // Prefer exceptions (they prevent breakage), then blocks.
    rules = [...rules.filter((r) => r.action.type !== 'block'), ...rules.filter((r) => r.action.type === 'block')].slice(0, budget);
    trimmed = data.rules.length - rules.length;
  }
  if (rules.length) await setListSlotRules(list.slot, rules);
  else await clearListSlot(list.slot);
  list.dynamicRuleCount = rules.length;
  return { installed: rules.length, trimmed };
}

// ---------------------------------------------------------------------------
// Downloading and compiling
// ---------------------------------------------------------------------------

async function download(url: string): Promise<string> {
  const res = await fetch(url, {
    cache: 'no-cache',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  const text = await res.text();
  const check = looksLikeFilterList(text);
  if (!check.ok) throw new Error(`Invalid filter list: ${check.reason}`);
  return text;
}

const staticRulesCache = new Map<string, Promise<DnrRule[]>>();

function loadStaticRules(rulesetId: string): Promise<DnrRule[]> {
  let p = staticRulesCache.get(rulesetId);
  if (!p) {
    p = fetch(chrome.runtime.getURL(`rules/${rulesetId}.json`)).then((r) => r.json() as Promise<DnrRule[]>);
    staticRulesCache.set(rulesetId, p);
    p.catch(() => staticRulesCache.delete(rulesetId));
  }
  return p;
}

/** Compiles list text into runtime data, diffing against the static ruleset for bundled lists. */
async function buildListData(list: ListState, text: string): Promise<ListData & { unsupported: Record<string, number> }> {
  const def = findListDefinition(list.id);
  const compiled = compileFilterList(text, {
    maxRegexRules: LIMITS.reservedRegex * 3,
    profile: profileFor(list),
    format: def?.format ?? 'auto',
  });
  let rules: Omit<DnrRule, 'id'>[] = compiled.rules.map(({ id: _id, ...rest }) => rest);
  let disabledStatic: number[] = [];

  if (list.bundled) {
    const staticRules = await loadStaticRules(list.id);
    const staticKeys = new Set(staticRules.map(ruleKey));
    const newKeys = new Set(rules.map(ruleKey));
    rules = rules.filter((r) => !staticKeys.has(ruleKey(r)));
    disabledStatic = staticRules.filter((r) => !newKeys.has(ruleKey(r))).map((r) => r.id);
    if (disabledStatic.length > LIMITS.disabledStaticPerRuleset) {
      log.warn(`${list.id}: ${disabledStatic.length} obsolete static rules, only ${LIMITS.disabledStaticPerRuleset} can be disabled`);
      disabledStatic = disabledStatic.slice(0, LIMITS.disabledStaticPerRuleset);
    }
  }
  return { rules, disabledStatic, cosmetic: compiled.cosmetic, popup: compiled.popup, unsupported: compiled.stats.skipped };
}

/**
 * Downloads, compiles and activates one list. On any failure the previously
 * active rules are left untouched and the error is recorded on the list.
 */
async function performUpdate(id: string, settings: Settings): Promise<void> {
  const lists = await getLists();
  const list = lists.find((l) => l.id === id);
  if (!list) throw new Error(`Unknown filter list: ${id}`);
  updating.add(id);
  list.lastAttempt = Date.now();
  await saveLists(lists);

  try {
    if (!list.url) throw new Error('This list is maintained with Anti-Venom and updates with the extension');
    const text = await download(list.url);
    const { unsupported, ...data } = await buildListData(list, text);
    list.unsupported = unsupported;
    list.popupCount = (data.popup?.domains.length ?? 0) + (data.popup?.rules.length ?? 0);
    const meta = (await getBundledMeta())[list.id];
    let notice: string | undefined;

    if (isListActive(list, settings)) {
      const { trimmed } = await installListData(list, data);
      if (list.bundled) await setDisabledStaticRules(list.id, data.disabledStatic);
      if (trimmed) notice = `${trimmed} rules skipped (dynamic rule quota or unsupported regex)`;
    } else {
      list.dynamicRuleCount = data.rules.length;
    }
    await saveListData(list.id, data);

    if (list.custom) {
      const title = /^!\s*Title\s*:\s*(.+)$/im.exec(text.slice(0, 4096))?.[1]?.trim();
      if (title) list.title = title.slice(0, 120);
    }
    const disabled = list.bundled ? data.disabledStatic.length : 0;
    list.disabledStaticCount = disabled;
    list.ruleCount = (list.bundled ? (meta?.ruleCount ?? 0) - disabled : 0) + list.dynamicRuleCount;
    let cosmeticCount = data.cosmetic.genericUnkeyed.length;
    for (const v of Object.values(data.cosmetic.genericKeyed)) cosmeticCount += v.length;
    for (const v of Object.values(data.cosmetic.specific)) cosmeticCount += v.length;
    list.cosmeticCount = cosmeticCount;
    list.version = parseVersion(text);
    list.expiresMs = parseExpires(text, DEFAULT_LIST_EXPIRY_MS);
    list.lastUpdated = Date.now();
    list.lastSuccess = list.lastUpdated;
    list.lastError = notice;
    log.info(`list ${list.id} updated`, { dynamic: list.dynamicRuleCount, disabledStatic: disabled });
  } catch (err) {
    list.lastError = errorMessage(err);
    log.warn(`Update of ${list.id} failed; keeping previous rules`, err);
  } finally {
    updating.delete(id);
    list.updating = false;
    const fresh = await getLists();
    const idx = fresh.findIndex((l) => l.id === id);
    if (idx >= 0) {
      fresh[idx] = list;
      await saveLists(fresh);
    }
  }
}

export function updateList(id: string, settings: Settings): Promise<void> {
  return serialize(() => performUpdate(id, settings));
}

/** Updates every enabled list whose data has expired (alarm handler). */
export async function updateDueLists(settings: Settings, force = false): Promise<string[]> {
  if (!force && !settings.autoUpdateLists) return [];
  const now = Date.now();
  const lists = await getLists();
  const due = lists.filter((l) => {
    if (!l.enabled || !l.url) return false;
    if (force) return true;
    const expires = settings.updateIntervalHours > 0 ? settings.updateIntervalHours * 3_600_000 : (l.expiresMs ?? DEFAULT_LIST_EXPIRY_MS);
    const stale = !l.lastUpdated || now - l.lastUpdated >= expires;
    const backoff = l.lastAttempt && l.lastError && now - l.lastAttempt < UPDATE_RETRY_BACKOFF_MS;
    return stale && !backoff;
  });
  for (const l of due) await updateList(l.id, settings);
  return due.map((l) => l.id);
}

export function setListEnabled(id: string, enabled: boolean, settings: Settings): Promise<void> {
  return serialize(async () => {
    await mutateList(id, (l) => {
      l.enabled = enabled;
      if (enabled) l.lastError = undefined;
    });
    await syncListRules(settings, desiredFeatureRulesets(settings));
    // A non-bundled list has no rules until it is downloaded for the first time.
    const list = (await getLists()).find((l) => l.id === id);
    if (enabled && list && !list.bundled && !(await getListData(id))) await performUpdate(id, settings);
  });
}

export function addCustomList(url: string, settings: Settings): Promise<ListState> {
  return serialize(async () => {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new Error('Please enter a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only http(s) URLs are supported');
    const lists = await getLists();
    if (lists.some((l) => l.url === parsed.href)) throw new Error('This list is already added');
    const preset = LIST_CATALOG.find((d) => d.url === parsed.href);
    if (preset) throw new Error(`This is the built-in "${preset.title}" list; enable it instead`);
    if (lists.filter((l) => l.custom).length >= LIMITS.maxCustomLists) {
      throw new Error(`At most ${LIMITS.maxCustomLists} custom lists are supported`);
    }
    const list: ListState = {
      id: `custom-${Date.now().toString(36)}`,
      title: parsed.hostname,
      url: parsed.href,
      category: 'custom',
      blockCategory: 'ads',
      bundled: false,
      custom: true,
      enabled: true,
      slot: freeSlot(lists),
      ruleCount: 0,
      cosmeticCount: 0,
      dynamicRuleCount: 0,
      disabledStaticCount: 0,
    };
    await saveLists([...lists, list]);
    await performUpdate(list.id, settings);
    const result = (await getLists()).find((l) => l.id === list.id)!;
    if (!(await getListData(list.id))) {
      // First download failed: do not keep a list that never worked.
      await saveLists((await getLists()).filter((l) => l.id !== list.id));
      throw new Error(`Could not add list: ${result.lastError ?? 'download failed'}`);
    }
    return result;
  });
}

export function removeCustomList(id: string): Promise<void> {
  return serialize(async () => {
    const lists = await getLists();
    const list = lists.find((l) => l.id === id);
    if (!list) return;
    if (!list.custom) throw new Error('Built-in lists can be disabled but not removed');
    await clearListSlot(list.slot);
    await removeListData(id);
    await saveLists(lists.filter((l) => l.id !== id));
  });
}

/**
 * After an extension update the bundled rulesets are fresh, so any runtime
 * delta computed against the old bundle is obsolete. Chrome resets disabled
 * static rules on update; we drop the matching dynamic rules and data.
 */
export function resetBundledDeltas(): Promise<void> {
  return serialize(async () => {
    const lists = await getLists();
    const meta = await getBundledMeta();
    for (const list of lists.filter((l) => l.bundled)) {
      await clearListSlot(list.slot).catch(() => {});
      await removeListData(list.id);
      const m = meta[list.id];
      list.dynamicRuleCount = 0;
      list.disabledStaticCount = 0;
      list.ruleCount = m?.ruleCount ?? 0;
      list.cosmeticCount = m?.cosmeticCount ?? 0;
      list.version = m?.version;
      list.lastUpdated = m?.compiledAt;
      list.lastError = undefined;
    }
    await saveLists(lists);
  });
}

/** Restores catalog defaults, removing custom lists and all runtime data. */
export function resetLists(): Promise<void> {
  return serialize(async () => {
    const lists = (await getStoredLists()) ?? [];
    for (const l of lists) {
      await removeListData(l.id);
      await clearListSlot(l.slot).catch(() => {});
    }
    for (const id of availableRulesets()) await setDisabledStaticRules(id, []).catch(() => {});
    await chrome.storage.local.remove('lists');
    await getLists();
  });
}

export { findListDefinition };
