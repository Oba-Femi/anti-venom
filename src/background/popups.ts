/**
 * Pop-up / pop-under blocking.
 *
 * DNR cannot tell a pop-up from a normal navigation, so `$popup` filters are
 * enforced here: when a page opens a new tab or window
 * (webNavigation.onCreatedNavigationTarget), its destination is checked —
 * including the first navigations shortly after, because pop-under scripts
 * often open about:blank and redirect — and the tab is closed if it matches.
 *
 * Safety: pop-ups to the opener's own site are never blocked (logins, print
 * views, OAuth on the same site), only third-party destinations matching an
 * ad-list $popup filter are.
 */
import { PopupMatcher } from '../filters/matcher.ts';
import { log } from '../shared/logger.ts';
import { getActiveAssets, onAssetsInvalidated } from './assets.ts';
import { getSettings } from './storage.ts';
import { hostOf, protectionActiveFor } from './policy.ts';
import { recordBlocked } from './stats.ts';

const WATCH_MS = 8_000;
const watched = new Map<number, { openerTabId: number; openerHost: string; until: number }>();
let matcherPromise: Promise<PopupMatcher> | null = null;
onAssetsInvalidated(() => (matcherPromise = null));

function getMatcher(): Promise<PopupMatcher> {
  matcherPromise ??= getActiveAssets().then((a) => new PopupMatcher(a.popup));
  return matcherPromise;
}

async function check(tabId: number, url: string): Promise<void> {
  const w = watched.get(tabId);
  if (!w) return;
  if (Date.now() > w.until) {
    watched.delete(tabId);
    return;
  }
  if (!hostOf(url)) return; // about:blank etc. — keep watching
  const matcher = await getMatcher();
  if (!matcher.shouldBlock(url, w.openerHost)) return;
  watched.delete(tabId);
  try {
    await chrome.tabs.remove(tabId);
    await recordBlocked({ tabId: w.openerTabId, url, type: 'popup' }, 'popups');
    log.debug('blocked pop-up', hostOf(url), 'from', w.openerHost);
  } catch {
    // Tab already closed.
  }
}

export async function onCreatedNavigationTarget(details: chrome.webNavigation.WebNavigationSourceCallbackDetails): Promise<void> {
  const settings = await getSettings();
  if (!settings.enabled || !settings.popupBlocking) return;
  const opener = await chrome.tabs.get(details.sourceTabId).catch(() => null);
  const openerHost = hostOf(opener?.url);
  if (!openerHost || !(await protectionActiveFor(openerHost))) return;
  watched.set(details.tabId, { openerTabId: details.sourceTabId, openerHost, until: Date.now() + WATCH_MS });
  await check(details.tabId, details.url);
}

export async function onBeforeNavigate(details: { tabId: number; frameId: number; url: string }): Promise<void> {
  if (details.frameId !== 0 || !watched.has(details.tabId)) return;
  await check(details.tabId, details.url);
}

export function forgetPopupTab(tabId: number): void {
  watched.delete(tabId);
}
