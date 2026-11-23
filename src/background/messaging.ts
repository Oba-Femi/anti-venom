/**
 * Message router. Privileged requests are accepted only from the extension's
 * own pages; content scripts (which run inside untrusted web pages) may only
 * use the cosmetic-filtering messages. All inputs are validated here or in
 * the engine before use.
 */
import { CONTENT_MESSAGES, type Envelope, type MessageType, type Request, type Response, type SitePatch } from '../shared/messages.ts';
import { errorMessage, log } from '../shared/logger.ts';
import type { DashboardData, OptionsState, PopupState, SiteRow } from '../shared/types.ts';
import { isProtectionOff, resolveSitePolicy } from '../shared/site-policy.ts';
import { dailySeries, dayKey, sumCounts, topSites } from '../shared/stats-model.ts';
import { getPauses, getSettings } from './storage.ts';
import {
  addCustomList, getLists, isListActive, removeCustomList, setListEnabled, updateDueLists, updateList,
} from './lists.ts';
import { getQuotaInfo } from './rules.ts';
import { clearSiteStats, getStatsStore, getTabStats, resetStats } from './stats.ts';
import { handleCosmeticInit, handleCosmeticTokens } from './cosmetic-service.ts';
import { invalidateAssets } from './assets.ts';
import {
  patchSettings, pauseSite, removeSite, restoreDefaultLists, restoreDefaults, resumeSite, setCustomFilters,
  setGlobalEnabled, setSitePolicy,
} from './engine.ts';
import { getDiagnostics } from './diagnostics.ts';
import { hostOf } from './policy.ts';

type Handler<K extends MessageType> = (msg: Request<K>, sender: chrome.runtime.MessageSender) => Promise<Response<K>>;
type HandlerMap = { [K in MessageType]: Handler<K> };

async function popupState(tabId: number): Promise<PopupState> {
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const host = hostOf(tab?.url);
  const policy = host ? resolveSitePolicy(settings.sites, host, await getPauses()) : null;
  const store = await getStatsStore();
  return {
    enabled: settings.enabled,
    host,
    policy,
    active: settings.enabled && !(policy && isProtectionOff(policy)),
    tab: await getTabStats(tabId),
    today: sumCounts(store.daily[dayKey()]),
    blockedTotal: sumCounts(store.totals),
    trackingProtection: settings.trackingProtection,
  };
}

async function dashboard(): Promise<DashboardData> {
  const settings = await getSettings();
  const store = await getStatsStore();
  const lists = await getLists();
  return {
    enabled: settings.enabled,
    trackingProtection: settings.trackingProtection,
    cosmeticFiltering: settings.cosmeticFiltering,
    totals: store.totals,
    totalBlocked: sumCounts(store.totals),
    today: store.daily[dayKey()] ?? {},
    since: store.since,
    series: dailySeries(store, 30),
    topSites: topSites(store, 10),
    lists: lists
      .filter((l) => l.enabled)
      .map((l) => ({ id: l.id, title: l.title, category: l.category, ruleCount: l.ruleCount, enabled: l.enabled, active: isListActive(l, settings), lastError: l.lastError })),
    siteStats: settings.siteStats,
    quota: await getQuotaInfo(),
  };
}

async function sitesList(): Promise<SiteRow[]> {
  const settings = await getSettings();
  const pauses = await getPauses();
  const store = await getStatsStore();
  const hosts = new Set([...Object.keys(settings.sites), ...Object.keys(pauses)]);
  return [...hosts].sort().map((host) => ({
    host,
    overrides: settings.sites[host] ?? {},
    pausedUntil: pauses[host],
    stat: store.sites[host] ?? store.sites[`www.${host}`],
  }));
}

async function optionsState(): Promise<OptionsState> {
  const store = await getStatsStore();
  return {
    settings: await getSettings(),
    lists: await getLists(),
    stats: { totalBlocked: sumCounts(store.totals), since: store.since },
    quota: await getQuotaInfo(),
    diagnostics: await getDiagnostics(),
    pauses: await getPauses(),
    version: chrome.runtime.getManifest().version,
  };
}

function sitePatch(raw: unknown): SitePatch {
  const out: SitePatch = {};
  if (raw && typeof raw === 'object') {
    for (const f of ['protection', 'tracking', 'cosmetic'] as const) {
      const v = (raw as Record<string, unknown>)[f];
      if (typeof v === 'boolean' || v === null) out[f] = v;
    }
  }
  return out;
}

const handlers: HandlerMap = {
  'popup:getState': (m) => popupState(Number(m.tabId)),
  'settings:setEnabled': (m) => setGlobalEnabled(!!m.enabled),
  'site:setPolicy': (m) => setSitePolicy(String(m.host), sitePatch(m.patch)),
  'site:pause': (m) => pauseSite(String(m.host), Math.max(0, Number(m.minutes) || 0)),
  'site:resume': (m) => resumeSite(String(m.host)),
  'site:remove': (m) => removeSite(String(m.host)),
  'sites:list': () => sitesList(),
  'dashboard:get': () => dashboard(),
  'options:getState': () => optionsState(),
  'settings:update': (m) => patchSettings(m.patch ?? {}),
  'settings:reset': () => restoreDefaults(),
  'lists:setEnabled': async (m) => {
    await setListEnabled(String(m.id), !!m.enabled, await getSettings());
    invalidateAssets();
  },
  'lists:update': async (m) => {
    const settings = await getSettings();
    if (m.id) await updateList(String(m.id), settings);
    else await updateDueLists(settings, true);
    invalidateAssets();
    return getLists();
  },
  'lists:add': async (m) => {
    const list = await addCustomList(String(m.url), await getSettings());
    invalidateAssets();
    return list;
  },
  'lists:remove': async (m) => {
    await removeCustomList(String(m.id));
    invalidateAssets();
  },
  'lists:resetDefaults': () => restoreDefaultLists(),
  'customFilters:set': (m) => setCustomFilters(String(m.text ?? '')),
  'stats:reset': () => resetStats(),
  'stats:clearSites': () => clearSiteStats(),
  'cosmetic:init': (_m, sender) => handleCosmeticInit(sender),
  'cosmetic:tokens': (m, sender) => handleCosmeticTokens(sender, m.tokens),
};

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

export function onMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: Envelope<unknown>) => void,
): boolean {
  const type = (message as { type?: unknown })?.type;
  if (typeof type !== 'string' || !Object.hasOwn(handlers, type)) return false;
  if (sender.id !== chrome.runtime.id) return false;
  if (!CONTENT_MESSAGES.has(type as MessageType) && !isExtensionPage(sender)) {
    log.warn('Rejected privileged message from non-extension context', type);
    return false;
  }
  const handler = handlers[type as MessageType] as Handler<MessageType>;
  handler(message as Request, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => {
      log.error(`Handler ${type} failed`, err);
      sendResponse({ ok: false, error: errorMessage(err) });
    },
  );
  return true; // keep the channel open for the async response
}
