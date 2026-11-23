/** General settings, appearance, data and diagnostics. */
import { sendMessage, type SettingsPatch } from '../../shared/messages.ts';
import { fmt, h, toggle } from '../../ui/dom.ts';
import { getTheme, setTheme, type ThemeChoice } from '../../ui/theme.ts';
import { panel, settingRow, viewHead, type View } from '../context.ts';

export const settingsView: View = async (root, ctx) => {
  const state = await sendMessage({ type: 'options:getState' });
  const s = state.settings;
  const save = (patch: SettingsPatch, msg: string) => ctx.act(() => sendMessage({ type: 'settings:update', patch }), msg).then(() => ctx.rerender());

  const theme = h('div', { className: 'segmented', attrs: { role: 'group', 'aria-label': 'Theme' } });
  const current = getTheme();
  for (const [value, label] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as [ThemeChoice, string][]) {
    const b = h('button', { textContent: label, attrs: { 'aria-pressed': String(current === value) } });
    b.addEventListener('click', () => {
      setTheme(value);
      for (const x of theme.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    });
    theme.append(b);
  }

  const resetStats = h('button', { className: 'btn', textContent: 'Reset statistics' });
  resetStats.addEventListener('click', () => {
    if (confirm('Reset all blocking statistics? This cannot be undone.')) void ctx.act(() => sendMessage({ type: 'stats:reset' }), 'Statistics reset');
  });
  const clearSites = h('button', { className: 'btn', textContent: 'Clear website history' });
  clearSites.addEventListener('click', () => void ctx.act(() => sendMessage({ type: 'stats:clearSites' }), 'Per-website counts cleared'));
  const restore = h('button', { className: 'btn danger', textContent: 'Restore defaults' });
  restore.addEventListener('click', () => {
    if (confirm('Restore all settings, filter lists, website exceptions and custom rules to their defaults? Statistics are kept.')) {
      void ctx.act(() => sendMessage({ type: 'settings:reset' }), 'Defaults restored').then(() => ctx.rerender());
    }
  });

  root.append(
    viewHead('Settings'),
    panel(
      'Protection',
      null,
      settingRow({
        title: 'Protection',
        sub: 'Master switch for all blocking on every website.',
        control: toggle({ checked: s.enabled, label: 'Protection', onChange: (v) => void ctx.act(() => sendMessage({ type: 'settings:setEnabled', enabled: v }), v ? 'Protection resumed' : 'Protection paused').then(() => ctx.rerender()) }),
      }),
      settingRow({
        title: 'Hide ad placeholders',
        sub: 'Hides ad containers and empty spaces left behind by blocked ads (cosmetic filtering).',
        control: toggle({ checked: s.cosmeticFiltering, label: 'Hide ad placeholders', onChange: (v) => void save({ cosmeticFiltering: v }, 'Saved') }),
      }),
      settingRow({
        title: 'Block pop-up ads',
        sub: 'Closes new tabs and windows that open ad or pop-under pages. Pop-ups to the same website (sign-in, print) are never closed.',
        control: toggle({ checked: s.popupBlocking, label: 'Block pop-up ads', onChange: (v) => void save({ popupBlocking: v }, 'Saved') }),
      }),
      settingRow({
        title: 'Show count on toolbar icon',
        sub: 'Number of blocked requests on the current page.',
        control: toggle({ checked: s.showBadge, label: 'Show count on toolbar icon', onChange: (v) => void save({ showBadge: v }, 'Saved') }),
      }),
    ),
    panel('Appearance', null, settingRow({ title: 'Theme', sub: 'Applies to the popup and this page on this device.', control: theme })),
    panel(
      'Statistics',
      `${fmt(state.stats.totalBlocked)} blocked since ${new Date(state.stats.since).toLocaleDateString()}. All statistics stay on this device.`,
      settingRow({
        title: 'Keep per-website counts',
        sub: 'Records which websites had the most blocks, for the dashboard. Only hostnames and counts are kept — never pages or URLs.',
        control: toggle({ checked: s.siteStats, label: 'Keep per-website counts', onChange: (v) => void save({ siteStats: v }, 'Saved') }),
      }),
      settingRow({ title: 'Clear website history', sub: 'Deletes per-website counts but keeps totals.', control: clearSites }),
      settingRow({ title: 'Reset statistics', sub: 'Deletes all counters.', control: resetStats }),
    ),
    panel('Reset', null, settingRow({ title: 'Restore defaults', sub: 'Resets settings, filter lists, website exceptions and custom rules. Statistics are kept.', control: restore })),
    panel(
      'Diagnostics',
      'Recent warnings from this browser session, stored locally to help troubleshoot. Never sent anywhere.',
      h(
        'ul',
        { className: 'diagnostics' },
        ...(state.diagnostics.length
          ? state.diagnostics.map((d) => h('li', { className: d.level }, `${new Date(d.time).toLocaleTimeString()}  ${d.message}`))
          : [h('li', { className: 'empty' }, 'No problems recorded.')]),
      ),
    ),
  );
};
