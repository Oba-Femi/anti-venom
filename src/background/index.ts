/**
 * Service-worker entry point.
 *
 * MV3 service workers are started on demand and terminated when idle, so all
 * event listeners are registered synchronously at top level (Chrome only
 * dispatches events to listeners present on the first turn). No work happens
 * at start-up beyond that: DNR rules persist on their own, and state is only
 * reconciled on install, browser start-up, or when the user changes something.
 */
import { ALARMS, UPDATE_CHECK_PERIOD_MIN } from '../shared/constants.ts';
import { log } from '../shared/logger.ts';
import { applyState, onPauseExpiry } from './engine.ts';
import { resetBundledDeltas, updateDueLists } from './lists.ts';
import { onMessage } from './messaging.ts';
import { forgetTab, recordBlocked, startPage, updateTabAppearance } from './stats.ts';
import { getSettings } from './storage.ts';
import { installDiagnosticSink } from './diagnostics.ts';
import { invalidateAssets } from './assets.ts';
import { forgetPopupTab, onBeforeNavigate, onCreatedNavigationTarget } from './popups.ts';

installDiagnosticSink();

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARMS.listUpdate);
  if (!existing) {
    await chrome.alarms.create(ALARMS.listUpdate, { periodInMinutes: UPDATE_CHECK_PERIOD_MIN, delayInMinutes: 5 });
  }
}

function safely(label: string, fn: () => Promise<unknown>): void {
  fn().catch((err) => log.error(`${label} failed`, err));
}

chrome.runtime.onInstalled.addListener((details) => {
  safely('Initialisation', async () => {
    log.info('onInstalled', details.reason, details.previousVersion);
    if (details.reason === 'update') await resetBundledDeltas();
    await applyState(`installed:${details.reason}`);
    await ensureAlarm();
  });
});

chrome.runtime.onStartup.addListener(() => {
  safely('Start-up reconciliation', async () => {
    await applyState('startup');
    await ensureAlarm();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.pauseExpiry) {
    safely('Pause expiry', onPauseExpiry);
    return;
  }
  if (alarm.name !== ALARMS.listUpdate) return;
  safely('Scheduled list update', async () => {
    const updated = await updateDueLists(await getSettings());
    if (updated.length) {
      invalidateAssets();
      log.info('auto-updated lists', updated);
    }
  });
});

chrome.runtime.onMessage.addListener(onMessage);

// --- Statistics ------------------------------------------------------------

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.error === 'net::ERR_BLOCKED_BY_CLIENT' && details.tabId >= 0) {
      void recordBlocked({ tabId: details.tabId, url: details.url, type: details.type });
    }
  },
  { urls: ['<all_urls>'] },
);

// A new top-level navigation starts a fresh per-page summary.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0) void startPage(details.tabId, details.url);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTab(tabId);
  forgetPopupTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') void updateTabAppearance(tabId, tab.url);
});

// --- Pop-up blocking ----------------------------------------------------------

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => void onCreatedNavigationTarget(d));
chrome.webNavigation.onBeforeNavigate.addListener((d) => void onBeforeNavigate(d));
