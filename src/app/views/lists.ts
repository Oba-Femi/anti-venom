/** Filter list management center. */
import { sendMessage } from '../../shared/messages.ts';
import type { ListCategory } from '../../shared/catalog.ts';
import type { ListState, OptionsState } from '../../shared/types.ts';
import { UPDATE_INTERVAL_CHOICES } from '../../shared/types.ts';
import { errorText, fmt, h, relativeTime, toggle } from '../../ui/dom.ts';
import { viewHead, type View } from '../context.ts';

/** Human explanations for converter skip reasons. */
const REASONS: Record<string, string> = {
  'procedural-cosmetic': 'Procedural cosmetic filters (:has-text, :xpath…) — need code execution that Manifest V3 forbids',
  'snippet/css-injection': 'Snippet / CSS-injection filters — not supported',
  'scriptlet/html-filter': 'Scriptlet or HTML filters — would require injecting scripts',
  'unsupported-type-only': 'Filters for request types DNR cannot see (e.g. WebRTC)',
  'document-block': 'Whole-page blocks for ad domains (skipped to avoid blocking navigation)',
  'option:redirect': '$redirect — replacing resources is not supported',
  'option:csp': '$csp — header injection is not supported',
  'option:removeparam': '$removeparam — use the built-in tracking-parameter protection instead',
  'option:rewrite': '$rewrite — not supported',
  'inner-pipe': 'Patterns using "|" in the middle — not valid in DNR',
  'domain-option': 'Entity domains (example.*) that DNR cannot express',
  'regex-unsupported': 'Regular expressions not compatible with Chrome (RE2)',
  'unsafe-selector': 'Cosmetic filters with style rules — skipped for safety',
  'pattern-too-short': 'Patterns too short to be safe',
  'popup-regex': 'Regex pop-up filters',
};

function reasonText(key: string): string {
  return REASONS[key] ?? (key.startsWith('option:') ? `$${key.slice(7)} — not supported` : key.replace(/-/g, ' '));
}

const GROUPS: { key: ListCategory; title: string }[] = [
  { key: 'ads', title: 'Ads' },
  { key: 'privacy', title: 'Privacy' },
  { key: 'security', title: 'Security' },
  { key: 'annoyances', title: 'Annoyances' },
  { key: 'custom', title: 'Your subscriptions' },
];

function intervalLabel(hours: number): string {
  if (hours === 0) return 'As each list requests';
  if (hours < 24) return `Every ${hours} hours`;
  if (hours === 24) return 'Daily';
  if (hours === 168) return 'Weekly';
  return `Every ${hours / 24} days`;
}

export const listsView: View = async (root, ctx) => {
  const state: OptionsState = await sendMessage({ type: 'options:getState' });
  const s = state.settings;

  const card = (list: ListState): HTMLElement => {
    const privacyInactive = list.enabled && list.category === 'privacy' && !s.trackingProtection;
    const title = h('div', { className: 'title' }, list.title);
    if (list.bundled) title.append(h('span', { className: 'tag good', title: 'Compiled into the extension; works offline' }, 'Built-in'));
    if (list.custom) title.append(h('span', { className: 'tag' }, 'Custom'));
    if (privacyInactive) title.append(h('span', { className: 'tag warn', title: 'Tracking protection is turned off' }, 'Inactive'));
    if (list.updating) title.append(h('span', { className: 'tag' }, 'Updating…'));

    const meta = h('div', { className: 'meta' });
    if (list.ruleCount || list.cosmeticCount || list.bundled) {
      meta.append(h('span', {}, h('strong', {}, fmt(list.ruleCount)), ' network rules'));
      meta.append(h('span', {}, h('strong', {}, fmt(list.cosmeticCount)), ' hiding rules'));
      if (list.popupCount) meta.append(h('span', {}, h('strong', {}, fmt(list.popupCount)), ' pop-up rules'));
    } else {
      meta.append(h('span', {}, 'Downloaded when enabled'));
    }
    meta.append(h('span', { title: list.lastSuccess ? new Date(list.lastSuccess).toLocaleString() : '' }, list.url ? `Updated ${relativeTime(list.lastSuccess ?? list.lastUpdated)}` : 'Updates with Anti-Venom'));
    if (list.version && list.version !== 'unknown') meta.append(h('span', {}, `Version ${list.version}`));
    if (list.dynamicRuleCount || list.disabledStaticCount) meta.append(h('span', { title: 'Applied on top of the built-in copy since the last extension update' }, `+${fmt(list.dynamicRuleCount)} / −${fmt(list.disabledStaticCount)} changes`));

    const info = h('div', {}, title, list.description ? h('div', { className: 'desc' }, list.description) : null, meta);

    const unsupported = Object.entries(list.unsupported ?? {}).sort((a, b) => b[1] - a[1]);
    const unsupportedTotal = unsupported.reduce((a, [, n]) => a + n, 0);
    if (unsupportedTotal) {
      info.append(
        h(
          'details',
          {},
          h('summary', {}, `${fmt(unsupportedTotal)} filters use syntax Chrome extensions can't run`),
          h('ul', {}, ...unsupported.slice(0, 12).map(([k, n]) => h('li', {}, `${fmt(n)} × ${reasonText(k)}`))),
        ),
      );
    }
    const attribution: (Node | string)[] = [];
    if (list.attribution) attribution.push(list.attribution);
    if (list.license) attribution.push(` · ${list.license}`);
    if (list.homepage) {
      attribution.push(' · ');
      attribution.push(h('a', { href: list.homepage, target: '_blank', rel: 'noopener noreferrer', textContent: 'Homepage' }));
    }
    if (attribution.length) info.append(h('div', { className: 'meta', style: 'margin-top:4px' }, ...attribution));
    if (list.lastError) info.append(h('div', { className: /skipped/.test(list.lastError) ? 'notice' : 'err' }, list.lastError));

    const buttons = h('div', { className: 'buttons' });
    if (list.url) {
      const update = h('button', { className: 'btn small', textContent: 'Update', disabled: !!list.updating || !list.enabled });
      update.addEventListener('click', () => {
        update.disabled = true;
        update.textContent = 'Updating…';
        void ctx.act(() => sendMessage({ type: 'lists:update', id: list.id }), `${list.title} checked for updates`).then(() => ctx.rerender());
      });
      buttons.append(update);
    }
    if (list.custom) {
      const remove = h('button', { className: 'btn small danger', textContent: 'Remove' });
      remove.addEventListener('click', () => {
        if (confirm(`Remove the subscription "${list.title}"?`)) void ctx.act(() => sendMessage({ type: 'lists:remove', id: list.id }), 'Subscription removed').then(() => ctx.rerender());
      });
      buttons.append(remove);
    }
    const sw = toggle({
      checked: list.enabled,
      label: `Enable ${list.title}`,
      onChange: (v) => void ctx.act(() => sendMessage({ type: 'lists:setEnabled', id: list.id, enabled: v }), `${list.title} ${v ? 'enabled' : 'disabled'}`).then(() => ctx.rerender()),
    });
    return h('div', { className: 'list-card' }, sw, info, buttons);
  };

  const groups = GROUPS.map((g) => ({ ...g, lists: state.lists.filter((l) => l.category === g.key) })).filter((g) => g.lists.length);

  // Schedule controls.
  const auto = toggle({
    checked: s.autoUpdateLists,
    label: 'Update lists automatically',
    onChange: (v) => void ctx.act(() => sendMessage({ type: 'settings:update', patch: { autoUpdateLists: v } }), v ? 'Automatic updates on' : 'Automatic updates off').then(() => ctx.rerender()),
  });
  const interval = h('select', { disabled: !s.autoUpdateLists, attrs: { 'aria-label': 'Update schedule' } }, ...UPDATE_INTERVAL_CHOICES.map((v) => h('option', { value: String(v), selected: v === s.updateIntervalHours }, intervalLabel(v))));
  interval.addEventListener('change', () => void ctx.act(() => sendMessage({ type: 'settings:update', patch: { updateIntervalHours: Number(interval.value) } }), 'Update schedule saved'));

  const updateAll = h('button', { className: 'btn', textContent: 'Update all now' });
  updateAll.addEventListener('click', () => {
    updateAll.disabled = true;
    updateAll.textContent = 'Updating…';
    void ctx.act(() => sendMessage({ type: 'lists:update' }), 'Filter lists updated').then(() => ctx.rerender());
  });
  const resetBtn = h('button', { className: 'btn ghost', textContent: 'Restore default subscriptions' });
  resetBtn.addEventListener('click', () => {
    if (confirm('Restore the default filter lists? Custom subscriptions are removed and built-in lists return to their default state. Your other settings are kept.')) {
      void ctx.act(() => sendMessage({ type: 'lists:resetDefaults' }), 'Default subscriptions restored').then(() => ctx.rerender());
    }
  });

  // Add subscription.
  const urlInput = h('input', { type: 'url', placeholder: 'https://example.com/filters.txt', required: true, attrs: { 'aria-label': 'Filter list URL' } });
  const addStatus = h('p', { className: 'hint' }, 'Adblock Plus syntax or plain domain lists. Downloaded lists are validated before anything changes.');
  const addForm = h('form', { className: 'inline-form' }, urlInput, h('button', { className: 'btn primary', type: 'submit', textContent: 'Subscribe' }));
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    addStatus.className = 'hint';
    addStatus.textContent = 'Downloading and checking…';
    void (async () => {
      try {
        const list = await sendMessage({ type: 'lists:add', url: urlInput.value });
        ctx.toast(`Subscribed to "${list.title}" (${fmt(list.ruleCount)} rules)`);
        ctx.rerender();
      } catch (err) {
        addStatus.className = 'hint err';
        addStatus.textContent = errorText(err);
      }
    })();
  });

  const q = state.quota;
  root.append(
    viewHead('Filter lists', 'Subscriptions that decide what gets blocked. Updates are verified first; a failed update never removes working rules.', resetBtn, updateAll),
    h(
      'section',
      { className: 'panel' },
      h('h2', {}, 'Updates'),
      h('div', { className: 'row' }, h('div', {}, h('div', { className: 'row-title' }, 'Update automatically'), h('div', { className: 'row-sub' }, 'Downloads come straight from each list publisher. No browsing data is sent.')), auto),
      h('div', { className: 'row' }, h('div', {}, h('div', { className: 'row-title' }, 'Schedule'), h('div', { className: 'row-sub' }, 'How often to check for new versions of enabled lists.')), interval),
    ),
    h('section', { className: 'panel' }, ...groups.map((g) => h('div', { className: 'list-group' }, h('h3', {}, g.title), ...g.lists.map(card)))),
    h('section', { className: 'panel' }, h('h2', {}, 'Add a subscription'), addForm, addStatus),
    h(
      'p',
      { className: 'hint' },
      `Rule capacity: ${fmt(q.dynamicUsed)} of ${fmt(q.dynamicMax)} runtime rules in use (regex ${q.regexUsed}/${q.regexMax})` +
        (q.staticAvailable !== null ? ` · ${fmt(q.staticAvailable)} built-in rule slots free` : ''),
    ),
  );
};
