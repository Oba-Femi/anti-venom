/**
 * Persistence layer. Long-lived state lives in chrome.storage.local so it
 * survives browser restarts and extension updates; per-tab data and temporary
 * pauses live in chrome.storage.session (cleared when the browser closes).
 * Nothing is synced or sent off-device.
 *
 * Everything read from storage is treated as untrusted input and passed
 * through a sanitiser, which is also where schema migrations happen.
 */
import { DEFAULT_SETTINGS, LIMITS, STORAGE_KEYS } from '../shared/constants.ts';
import { SETTINGS_SCHEMA_VERSION, UPDATE_INTERVAL_CHOICES, type ListState, type PrivacySettings, type Settings } from '../shared/types.ts';
import { normalizeSites, type SiteOverrides } from '../shared/site-policy.ts';
import type { CosmeticBundle } from '../filters/cosmetic.ts';
import type { PopupBundle } from '../filters/matcher.ts';
import type { DnrRule } from '../filters/dnr-types.ts';
import { normalizeSiteInput } from '../filters/domains.ts';

let settingsCache: Settings | null = null;

function sanitizeSites(raw: unknown): Record<string, SiteOverrides> {
  const out: Record<string, SiteOverrides> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, LIMITS.maxSites)) {
    const host = normalizeSiteInput(key);
    if (!host || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const entry: SiteOverrides = {};
    for (const f of ['protection', 'tracking', 'cosmetic'] as const) if (typeof v[f] === 'boolean') entry[f] = v[f] as boolean;
    out[host] = { ...out[host], ...entry };
  }
  return normalizeSites(out);
}

/** Validates and migrates whatever is stored into a complete Settings object. */
export function sanitizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const p = (s.privacy && typeof s.privacy === 'object' ? s.privacy : {}) as Record<string, unknown>;
  const privacy: PrivacySettings = {
    stripTrackingParams: bool(p.stripTrackingParams, DEFAULT_SETTINGS.privacy.stripTrackingParams),
    globalPrivacyControl: bool(p.globalPrivacyControl, DEFAULT_SETTINGS.privacy.globalPrivacyControl),
    blockBeacons: bool(p.blockBeacons, DEFAULT_SETTINGS.privacy.blockBeacons),
  };

  // v1 → v2: the flat allowlist becomes per-site "protection off" entries.
  const sitesInput: Record<string, unknown> = { ...((s.sites as Record<string, unknown>) ?? {}) };
  if (Array.isArray(s.allowlist)) {
    for (const h of s.allowlist) if (typeof h === 'string') sitesInput[h] = { ...(sitesInput[h] as object), protection: false };
  }

  const interval = Number(s.updateIntervalHours);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: bool(s.enabled, DEFAULT_SETTINGS.enabled),
    cosmeticFiltering: bool(s.cosmeticFiltering, DEFAULT_SETTINGS.cosmeticFiltering),
    trackingProtection: bool(s.trackingProtection, DEFAULT_SETTINGS.trackingProtection),
    popupBlocking: bool(s.popupBlocking, DEFAULT_SETTINGS.popupBlocking),
    privacy,
    showBadge: bool(s.showBadge, DEFAULT_SETTINGS.showBadge),
    autoUpdateLists: bool(s.autoUpdateLists, DEFAULT_SETTINGS.autoUpdateLists),
    updateIntervalHours: (UPDATE_INTERVAL_CHOICES as readonly number[]).includes(interval) ? interval : DEFAULT_SETTINGS.updateIntervalHours,
    siteStats: bool(s.siteStats, DEFAULT_SETTINGS.siteStats),
    sites: sanitizeSites(sitesInput),
    customFilters: typeof s.customFilters === 'string' ? s.customFilters.slice(0, 500_000) : '',
  };
}

export async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const raw = stored[STORAGE_KEYS.settings] as Record<string, unknown> | undefined;
  settingsCache = sanitizeSettings(raw);
  // Persist migrations so older data is converted exactly once.
  if (raw && raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settingsCache });
  }
  return settingsCache;
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const clean = sanitizeSettings(settings);
  settingsCache = clean;
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: clean });
  return clean;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return saveSettings({ ...(await getSettings()), ...patch });
}

// Keep the cache coherent if another extension context writes settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.settings]) settingsCache = null;
});

export async function getStoredLists(): Promise<ListState[] | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.lists);
  const v = stored[STORAGE_KEYS.lists];
  return Array.isArray(v) ? (v as ListState[]) : null;
}

export async function saveLists(lists: ListState[]): Promise<void> {
  // `updating` is runtime-only state.
  await chrome.storage.local.set({ [STORAGE_KEYS.lists]: lists.map(({ updating: _u, ...rest }) => rest) });
}

/** Rules + cosmetics produced by a runtime download of a list. */
export interface ListData {
  /** Rules to install as dynamic rules (ids assigned at install time). */
  rules: Omit<DnrRule, 'id'>[];
  /** Static rule ids to disable (bundled lists only). */
  disabledStatic: number[];
  cosmetic: CosmeticBundle;
  popup?: PopupBundle;
}

export async function getListData(id: string): Promise<ListData | null> {
  const key = STORAGE_KEYS.listData + id;
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as ListData | undefined) ?? null;
}

export async function saveListData(id: string, data: ListData): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.listData + id]: data });
}

export async function removeListData(id: string): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.listData + id);
}

export async function getUserBundles(): Promise<{ cosmetic: CosmeticBundle | null; popup: PopupBundle | null }> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.userCosmetic, STORAGE_KEYS.userPopup]);
  return {
    cosmetic: (stored[STORAGE_KEYS.userCosmetic] as CosmeticBundle | undefined) ?? null,
    popup: (stored[STORAGE_KEYS.userPopup] as PopupBundle | undefined) ?? null,
  };
}

export async function saveUserBundles(cosmetic: CosmeticBundle | null, popup: PopupBundle | null): Promise<void> {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  if (cosmetic) set[STORAGE_KEYS.userCosmetic] = cosmetic;
  else remove.push(STORAGE_KEYS.userCosmetic);
  if (popup && (popup.domains.length || popup.rules.length)) set[STORAGE_KEYS.userPopup] = popup;
  else remove.push(STORAGE_KEYS.userPopup);
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  if (remove.length) await chrome.storage.local.remove(remove);
}

// --- Temporary pauses (storage.session: cleared on browser restart) ---------

export async function getPauses(): Promise<Record<string, number>> {
  const s = await chrome.storage.session.get(STORAGE_KEYS.pauses);
  const raw = s[STORAGE_KEYS.pauses] as Record<string, unknown> | undefined;
  const now = Date.now();
  const out: Record<string, number> = {};
  if (raw) for (const [h, v] of Object.entries(raw)) if (typeof v === 'number' && v > now) out[h] = v;
  return out;
}

export async function savePauses(pauses: Record<string, number>): Promise<void> {
  // JSON cannot hold Infinity; "until restart" is stored as Number.MAX_SAFE_INTEGER.
  await chrome.storage.session.set({ [STORAGE_KEYS.pauses]: pauses });
}
