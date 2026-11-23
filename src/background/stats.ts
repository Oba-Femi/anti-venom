/**
 * Blocking statistics and toolbar state.
 *
 * Counting: DNR does not report matches to packed extensions without the
 * declarativeNetRequestFeedback permission (and getMatchedRules is heavily
 * rate-limited). Instead we passively observe webRequest.onErrorOccurred for
 * net::ERR_BLOCKED_BY_CLIENT, which is how DNR-blocked requests surface.
 *
 * What is stored:
 *  - storage.local: counts per category, per day, and per top-level site
 *    hostname (site counts can be disabled in settings).
 *  - storage.session: per-tab summaries (blocked third-party hostnames and
 *    counts for the page currently open) so the popup can show details.
 * Full URLs are never stored.
 *
 * Caveat: other blockers (or a browser's built-in tracking prevention) also
 * produce ERR_BLOCKED_BY_CLIENT, so counts may include their blocks.
 */
import { MAX_TAB_ENTRIES, STORAGE_KEYS } from '../shared/constants.ts';
import type { BlockCategory } from '../shared/catalog.ts';
import { Classifier, type CategoryIndexJson } from '../filters/classify.ts';
import { applyEvents, dayKey, pruneStats, sanitizeStats, sumCounts, type BlockEvent } from '../shared/stats-model.ts';
import { isProtectionOff, resolveSitePolicy } from '../shared/site-policy.ts';
import type { StatsStore, TabStats } from '../shared/types.ts';
import { log } from '../shared/logger.ts';
import { getPauses, getSettings } from './storage.ts';
import { hostOf } from './policy.ts';

// --- Classifier --------------------------------------------------------------

let classifierPromise: Promise<Classifier> | null = null;
function getClassifier(): Promise<Classifier> {
  classifierPromise ??= fetch(chrome.runtime.getURL('filters/categories.json'))
    .then((r) => r.json() as Promise<CategoryIndexJson>)
    .then((j) => new Classifier(j))
    .catch((err) => {
      log.warn('Category index unavailable', err);
      return new Classifier({});
    });
  return classifierPromise;
}

// --- Persistent store ----------------------------------------------------------

let storePromise: Promise<StatsStore> | null = null;
let pending: BlockEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function loadStore(): Promise<StatsStore> {
  storePromise ??= chrome.storage.local
    .get([STORAGE_KEYS.statsV2, STORAGE_KEYS.stats])
    .then((s) => sanitizeStats(s[STORAGE_KEYS.statsV2], s[STORAGE_KEYS.stats]));
  return storePromise;
}

/** Store with not-yet-flushed events applied (callers must not mutate). */
export async function getStatsStore(): Promise<StatsStore> {
  await flush();
  return loadStore();
}

async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const tabWrite = writeTabs();
  if (!pending.length) return tabWrite;
  const events = pending;
  pending = [];
  const store = await loadStore();
  applyEvents(store, events, dayKey());
  pruneStats(store);
  await Promise.all([chrome.storage.local.set({ [STORAGE_KEYS.statsV2]: store }), tabWrite]);
}

function scheduleFlush(): void {
  flushTimer ??= setTimeout(() => void flush().catch((e) => log.warn('stats flush failed', e)), 1500);
}

export async function resetStats(): Promise<void> {
  pending = [];
  const store = sanitizeStats(undefined);
  storePromise = Promise.resolve(store);
  await chrome.storage.local.set({ [STORAGE_KEYS.statsV2]: store });
  await chrome.storage.local.remove(STORAGE_KEYS.stats);
}

export async function clearSiteStats(): Promise<void> {
  await flush();
  const store = await loadStore();
  store.sites = {};
  await chrome.storage.local.set({ [STORAGE_KEYS.statsV2]: store });
}

// --- Per-tab state -------------------------------------------------------------------

interface TabState {
  top: string | null;
  stats: TabStats;
}

const tabs = new Map<number, TabState>();
let tabsLoaded: Promise<void> | null = null;
let tabsDirty = false;
const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();

function emptyTab(top: string | null): TabState {
  return { top, stats: { total: 0, byCategory: {}, entries: [] } };
}

function ensureTabs(): Promise<void> {
  tabsLoaded ??= chrome.storage.session.get(STORAGE_KEYS.tabStats).then((s) => {
    const saved = s[STORAGE_KEYS.tabStats] as Record<string, TabState> | undefined;
    if (saved) for (const [k, v] of Object.entries(saved)) if (!tabs.has(+k)) tabs.set(+k, v);
  });
  return tabsLoaded;
}

async function writeTabs(): Promise<void> {
  if (!tabsDirty) return;
  tabsDirty = false;
  await chrome.storage.session.set({ [STORAGE_KEYS.tabStats]: Object.fromEntries(tabs) });
}

export interface BlockedRequest {
  tabId: number;
  url: string;
  type: string;
}

/** Records a request blocked by the browser on behalf of an extension. */
export async function recordBlocked(req: BlockedRequest, forcedCategory?: BlockCategory): Promise<void> {
  await ensureTabs();
  const settings = await getSettings();
  let tab = tabs.get(req.tabId);
  if (!tab) tabs.set(req.tabId, (tab = emptyTab(null)));
  const category = forcedCategory ?? (await getClassifier()).classify(req.url, req.type);
  const host = hostOf(req.url) ?? 'unknown';

  tab.stats.total++;
  tab.stats.byCategory[category] = (tab.stats.byCategory[category] ?? 0) + 1;
  let entry = tab.stats.entries.find((e) => e.host === host);
  if (!entry && tab.stats.entries.length < MAX_TAB_ENTRIES) {
    entry = { host, category, count: 0, types: [] };
    tab.stats.entries.push(entry);
  }
  if (entry) {
    entry.count++;
    if (!entry.types.includes(req.type) && entry.types.length < 6) entry.types.push(req.type);
  }
  tabsDirty = true;

  pending.push({ category, site: settings.siteStats ? tab.top : null });
  scheduleFlush();
  scheduleBadge(req.tabId);
}

/** A new top-level navigation starts a fresh per-page summary. */
export async function startPage(tabId: number, url: string): Promise<void> {
  await ensureTabs();
  tabs.set(tabId, emptyTab(hostOf(url)));
  tabsDirty = true;
  scheduleFlush();
  scheduleBadge(tabId);
}

export async function forgetTab(tabId: number): Promise<void> {
  await ensureTabs();
  tabs.delete(tabId);
  badgeTimers.delete(tabId);
  tabsDirty = true;
  scheduleFlush();
}

export async function getTabStats(tabId: number): Promise<TabStats> {
  await ensureTabs();
  const s = tabs.get(tabId)?.stats ?? { total: 0, byCategory: {}, entries: [] };
  return { ...s, entries: [...s.entries].sort((a, b) => b.count - a.count) };
}

export async function getTodayTotal(): Promise<number> {
  const store = await getStatsStore();
  return sumCounts(store.daily[dayKey()]);
}

// --- Badge and icon -------------------------------------------------------------------

function formatCount(n: number): string {
  if (n <= 0) return '';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.min(99, Math.floor(n / 1000))}k`;
}

function scheduleBadge(tabId: number): void {
  if (badgeTimers.has(tabId)) return;
  badgeTimers.set(
    tabId,
    setTimeout(() => {
      badgeTimers.delete(tabId);
      void updateBadge(tabId);
    }, 300),
  );
}

async function updateBadge(tabId: number): Promise<void> {
  const settings = await getSettings();
  const total = tabs.get(tabId)?.stats.total ?? 0;
  const text = settings.showBadge && settings.enabled ? formatCount(total) : '';
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

const ICONS = {
  on: { 16: 'icons/on-16.png', 32: 'icons/on-32.png', 48: 'icons/on-48.png', 128: 'icons/on-128.png' },
  off: { 16: 'icons/off-16.png', 32: 'icons/off-32.png', 48: 'icons/off-48.png', 128: 'icons/off-128.png' },
};

/** Sets the per-tab icon: grey when paused globally or on this site. */
export async function updateTabAppearance(tabId: number, url: string | undefined): Promise<void> {
  const settings = await getSettings();
  const host = hostOf(url);
  const siteOff = host ? isProtectionOff(resolveSitePolicy(settings.sites, host, await getPauses())) : false;
  const active = settings.enabled && !siteOff;
  await chrome.action.setIcon({ tabId, path: active ? ICONS.on : ICONS.off }).catch(() => {});
  await chrome.action
    .setTitle({
      tabId,
      title: !settings.enabled ? 'Anti-Venom – protection paused' : active ? 'Anti-Venom – protection active' : 'Anti-Venom – off on this site',
    })
    .catch(() => {});
  await updateBadge(tabId);
}

/** Refreshes global and per-tab toolbar state after a settings change. */
export async function refreshAllTabs(): Promise<void> {
  const settings = await getSettings();
  await chrome.action.setIcon({ path: settings.enabled ? ICONS.on : ICONS.off }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: '#0c7a60' }).catch(() => {});
  const all = await chrome.tabs.query({});
  await Promise.all(all.map((t) => (t.id !== undefined ? updateTabAppearance(t.id, t.url) : undefined)));
}
