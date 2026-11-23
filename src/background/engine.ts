/**
 * Orchestration: turns persisted settings + list state into DNR rules,
 * privacy features, cosmetic state and toolbar appearance. Every user action
 * funnels through here so the rest of the background code stays single-purpose.
 */
import { ALARMS, DEFAULT_SETTINGS, LIMITS, RULE_IDS } from '../shared/constants.ts';
import { log } from '../shared/logger.ts';
import type { CustomFiltersResult, PrivacySettings, Settings } from '../shared/types.ts';
import type { SettingsPatch } from '../shared/messages.ts';
import { normalizeSites, type SiteOverrides } from '../shared/site-policy.ts';
import { compileFilterList } from '../filters/compiler.ts';
import { countCosmetic } from '../filters/cosmetic.ts';
import { normalizeSiteInput } from '../filters/domains.ts';
import {
  clearAllDynamicRules, getDynamicRules, setGlobalPauseRule, setPauseRules, setSiteRules, setUserFilterRules,
} from './rules.ts';
import { getPauses, getSettings, getUserBundles, saveSettings, savePauses, saveUserBundles, updateSettings } from './storage.ts';
import { resetLists, serialize, syncListRules } from './lists.ts';
import { invalidateAssets } from './assets.ts';
import { refreshAllTabs } from './stats.ts';
import { desiredFeatureRulesets, syncGpcScript } from './privacy.ts';

/** Full reconciliation; idempotent. Runs on install, startup and settings changes. */
export function applyState(reason: string): Promise<void> {
  return serialize(async () => {
    const t0 = performance.now();
    const settings = await getSettings();
    await setGlobalPauseRule(!settings.enabled);
    await setSiteRules(settings.sites);
    await setPauseRules(await getPauses());
    await syncListRules(settings, desiredFeatureRulesets(settings));
    await ensureUserFilters(settings);
    await syncGpcScript(settings);
    invalidateAssets();
    await refreshAllTabs();
    log.debug(`state applied (${reason}) in ${Math.round(performance.now() - t0)} ms`);
  });
}

function compileUserFilters(text: string) {
  return compileFilterList(text, { maxRules: LIMITS.userFilterRules, maxRegexRules: LIMITS.userFilterRegex, format: 'abp' });
}

/**
 * Dynamic rules can be lost independently of storage (e.g. when an unpacked
 * extension is re-registered). Rebuild user-filter rules from the persisted
 * text if they are missing. Cheap no-op in the common case.
 */
async function ensureUserFilters(settings: Settings): Promise<void> {
  if (!settings.customFilters.trim()) return;
  const dynamic = await getDynamicRules();
  if (dynamic.some((r) => r.id >= RULE_IDS.userFiltersStart && r.id <= RULE_IDS.userFiltersEnd)) return;
  const compiled = compileUserFilters(settings.customFilters);
  if (compiled.rules.length) await setUserFilterRules(compiled.rules.map(({ id: _id, ...rest }) => rest));
  const existing = await getUserBundles();
  if (!existing.cosmetic && !existing.popup) await saveUserBundles(compiled.stats.cosmeticFilters ? compiled.cosmetic : null, compiled.popup);
  log.info('user filter rules restored');
}

export async function setGlobalEnabled(enabled: boolean): Promise<void> {
  await updateSettings({ enabled });
  await applyState('global toggle');
}

const BOOLEAN_SETTINGS = ['cosmeticFiltering', 'trackingProtection', 'popupBlocking', 'showBadge', 'autoUpdateLists', 'siteStats'] as const;

export async function patchSettings(patch: SettingsPatch): Promise<void> {
  const clean: Partial<Settings> = {};
  for (const k of BOOLEAN_SETTINGS) if (typeof patch[k] === 'boolean') clean[k] = patch[k];
  if (typeof patch.updateIntervalHours === 'number') clean.updateIntervalHours = patch.updateIntervalHours;
  const before = await getSettings();
  if (patch.privacy && typeof patch.privacy === 'object') {
    const p: Partial<PrivacySettings> = {};
    for (const k of ['stripTrackingParams', 'globalPrivacyControl', 'blockBeacons'] as const) {
      if (typeof patch.privacy[k] === 'boolean') p[k] = patch.privacy[k];
    }
    clean.privacy = { ...before.privacy, ...p };
  }
  const after = await updateSettings(clean);
  const needsApply =
    before.trackingProtection !== after.trackingProtection ||
    before.cosmeticFiltering !== after.cosmeticFiltering ||
    JSON.stringify(before.privacy) !== JSON.stringify(after.privacy);
  if (needsApply) await applyState('settings');
  else if (before.showBadge !== after.showBadge) await refreshAllTabs();
  if (before.popupBlocking !== after.popupBlocking) invalidateAssets();
}

/** Updates one website's overrides. `null` for a field means "inherit". */
export async function setSitePolicy(hostInput: string, patch: Partial<Record<keyof SiteOverrides, boolean | null>>): Promise<void> {
  const host = normalizeSiteInput(hostInput);
  if (!host) throw new Error('Invalid hostname');
  const settings = await getSettings();
  const sites = { ...settings.sites };
  const entry: SiteOverrides = { ...sites[host] };
  for (const f of ['protection', 'tracking', 'cosmetic'] as const) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (v === null) delete entry[f];
    else if (typeof v === 'boolean') entry[f] = v;
  }
  // Re-enabling protection on a host also ends any temporary pause for it.
  if (patch.protection === true) await resumeSite(host, false);
  sites[host] = entry;
  if (Object.keys(sites).length > LIMITS.maxSites) throw new Error(`At most ${LIMITS.maxSites} website rules are supported`);
  await updateSettings({ sites: normalizeSites(sites) });
  await applyState('site policy');
}

export async function removeSite(hostInput: string): Promise<void> {
  const host = normalizeSiteInput(hostInput);
  if (!host) return;
  const settings = await getSettings();
  const sites = { ...settings.sites };
  delete sites[host];
  await updateSettings({ sites });
  await resumeSite(host, false);
  await applyState('site removed');
}

/** Pauses protection on a site for `minutes` (0 = until the browser restarts). */
export async function pauseSite(hostInput: string, minutes: number): Promise<number> {
  const host = normalizeSiteInput(hostInput);
  if (!host) throw new Error('Invalid hostname');
  const until = minutes > 0 ? Date.now() + Math.min(minutes, 7 * 24 * 60) * 60_000 : Number.MAX_SAFE_INTEGER;
  const pauses = { ...(await getPauses()), [host]: until };
  await savePauses(pauses);
  await schedulePauseExpiry(pauses);
  await applyState('site paused');
  return until;
}

export async function resumeSite(hostInput: string, apply = true): Promise<void> {
  const host = normalizeSiteInput(hostInput);
  if (!host) return;
  const pauses = await getPauses();
  if (!(host in pauses)) return;
  delete pauses[host];
  await savePauses(pauses);
  await schedulePauseExpiry(pauses);
  if (apply) await applyState('site resumed');
}

/** Alarm at the earliest finite pause expiry; the handler re-applies state. */
async function schedulePauseExpiry(pauses: Record<string, number>): Promise<void> {
  const next = Math.min(...Object.values(pauses).filter((v) => v < Number.MAX_SAFE_INTEGER));
  await chrome.alarms.clear(ALARMS.pauseExpiry);
  if (Number.isFinite(next)) await chrome.alarms.create(ALARMS.pauseExpiry, { when: Math.max(next, Date.now() + 1000) });
}

export async function onPauseExpiry(): Promise<void> {
  const pauses = await getPauses(); // getPauses() drops expired entries
  await savePauses(pauses);
  await schedulePauseExpiry(pauses);
  await applyState('pause expired');
}

/** Compiles and installs user-authored filters; previous rules stay on failure. */
export async function setCustomFilters(text: string): Promise<CustomFiltersResult> {
  const compiled = compileUserFilters(text);
  const bodies = compiled.rules.map(({ id: _id, ...rest }) => rest);
  const installed = await serialize(() => setUserFilterRules(bodies));
  await saveUserBundles(compiled.stats.cosmeticFilters ? compiled.cosmetic : null, compiled.popup);
  await updateSettings({ customFilters: text });
  invalidateAssets();
  const c = countCosmetic(compiled.cosmetic);
  return {
    networkRules: installed,
    cosmeticFilters: c.generic + c.specific + c.exceptions,
    popupFilters: compiled.stats.popupFilters,
    skipped: compiled.stats.skipped,
  };
}

/** Restores the default subscriptions only (custom lists removed, defaults re-enabled). */
export async function restoreDefaultLists(): Promise<void> {
  await resetLists();
  await applyState('restore default lists');
}

/** Restores defaults: settings, lists, site rules, user filters. Statistics are kept. */
export async function restoreDefaults(): Promise<void> {
  await serialize(async () => {
    await clearAllDynamicRules();
    await saveUserBundles(null, null);
    await savePauses({});
    await saveSettings({ ...DEFAULT_SETTINGS, privacy: { ...DEFAULT_SETTINGS.privacy }, sites: {} });
  });
  await resetLists();
  await applyState('restore defaults');
}
