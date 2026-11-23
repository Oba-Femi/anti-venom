/**
 * Dashboard / settings app: hash-routed views over the background state.
 * Each view renders into #view and may return a cleanup function.
 */
import { STORAGE_KEYS } from '../shared/constants.ts';
import { errorText, h } from '../ui/dom.ts';
import type { ViewContext, View } from './context.ts';
import { dashboardView } from './views/dashboard.ts';
import { sitesView } from './views/sites.ts';
import { listsView } from './views/lists.ts';
import { privacyView } from './views/privacy.ts';
import { rulesView } from './views/rules.ts';
import { settingsView } from './views/settings.ts';
import { aboutView } from './views/about.ts';
import { sendMessage } from '../shared/messages.ts';

const VIEWS: Record<string, { title: string; view: View }> = {
  dashboard: { title: 'Dashboard', view: dashboardView },
  sites: { title: 'Websites', view: sitesView },
  lists: { title: 'Filter lists', view: listsView },
  privacy: { title: 'Privacy', view: privacyView },
  rules: { title: 'Custom rules', view: rulesView },
  settings: { title: 'Settings', view: settingsView },
  about: { title: 'About', view: aboutView },
};

const viewEl = document.getElementById('view')!;
const toastEl = document.getElementById('toast')!;
let toastTimer: number | undefined;
let cleanup: (() => void) | void;
let current = '';
let renderSeq = 0;

const ctx: ViewContext = {
  toast(message: string) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2800);
  },
  async act(fn, success) {
    try {
      const result = await fn();
      if (success) ctx.toast(success);
      return result;
    } catch (err) {
      ctx.toast(errorText(err));
      return undefined;
    } finally {
      void refreshStatus();
    }
  },
  rerender: () => void route(true),
};

async function refreshStatus(): Promise<void> {
  try {
    const s = await sendMessage({ type: 'options:getState' });
    const el = document.getElementById('sidebar-status')!;
    el.replaceChildren(h('span', { className: s.settings.enabled ? 'pill' : 'pill off' }, s.settings.enabled ? 'Protection on' : 'Paused'), h('div', { style: 'margin-top:8px' }, `Version ${s.version}`));
    (document.getElementById('brand-icon') as HTMLImageElement).src = s.settings.enabled ? '../icons/on-48.png' : '../icons/off-48.png';
  } catch {
    // Background not ready yet; the next action refreshes it.
  }
}

async function route(force = false): Promise<void> {
  const name = location.hash.slice(1).split('?')[0] || 'dashboard';
  const entry = VIEWS[name] ?? VIEWS.dashboard!;
  const key = VIEWS[name] ? name : 'dashboard';
  if (key === current && !force) return;
  const isNewView = key !== current;
  current = key;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.sidebar a')) {
    if (a.dataset.view === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${entry.title} – Anti-Venom`;
  const seq = ++renderSeq;
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  const container = h('div');
  try {
    const result = await entry.view(container, ctx);
    if (seq !== renderSeq) {
      if (typeof result === 'function') result();
      return;
    }
    const scroll = isNewView ? 0 : window.scrollY;
    viewEl.replaceChildren(container);
    cleanup = result;
    window.scrollTo(0, scroll);
    if (isNewView) viewEl.focus({ preventScroll: true });
  } catch (err) {
    viewEl.replaceChildren(h('div', { className: 'panel error' }, `Could not load this page: ${errorText(err)}`));
  }
}

window.addEventListener('hashchange', () => void route());
void route();
void refreshStatus();

// Keep list status (update progress, errors) live while the lists view is open.
let storageTimer: number | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!(STORAGE_KEYS.lists in changes) && !(STORAGE_KEYS.settings in changes)) return;
  if (current !== 'lists' && current !== 'sites') return;
  clearTimeout(storageTimer);
  storageTimer = window.setTimeout(() => {
    // Don't clobber a focused text field the user is typing in.
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && (active as HTMLInputElement).type !== 'checkbox') return;
    void route(true);
  }, 250);
});
