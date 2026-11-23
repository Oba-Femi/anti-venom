import { sendMessage } from '../../shared/messages.ts';
import type { DashboardData } from '../../shared/types.ts';
import { sumCounts } from '../../shared/stats-model.ts';
import { compact, fmt, h, infoTip } from '../../ui/dom.ts';
import { activityChart, split } from '../chart.ts';
import { panel, viewHead, type View } from '../context.ts';

function kpi(label: string, value: number, sub: string, dot?: string, tip?: string): HTMLElement {
  return h(
    'div',
    { className: 'kpi' },
    h('div', { className: 'k-label' }, dot ? h('span', { className: `dot ${dot}` }) : null, label, tip ? infoTip(tip) : null),
    h('div', { className: 'k-value', title: fmt(value) }, compact(value)),
    h('div', { className: 'k-sub' }, sub),
  );
}

function statusPanel(d: DashboardData): HTMLElement {
  const features: HTMLElement[] = [
    h('span', { className: d.enabled ? 'tag good' : 'tag' }, d.enabled ? 'Ad blocking on' : 'Ad blocking paused'),
    h('span', { className: d.enabled && d.trackingProtection ? 'tag good' : 'tag warn' }, d.trackingProtection ? 'Tracking protection on' : 'Tracking protection off'),
    h('span', { className: d.enabled && d.cosmeticFiltering ? 'tag good' : 'tag' }, d.cosmeticFiltering ? 'Placeholder hiding on' : 'Placeholder hiding off'),
  ];
  const problems = d.lists.filter((l) => l.lastError && !/skipped/.test(l.lastError));
  if (problems.length) features.push(h('span', { className: 'tag bad' }, `${problems.length} list issue${problems.length > 1 ? 's' : ''}`));
  const toggleBtn = h('button', { className: d.enabled ? 'btn' : 'btn primary', textContent: d.enabled ? 'Pause protection' : 'Resume protection' });
  toggleBtn.addEventListener('click', async () => {
    toggleBtn.disabled = true;
    await sendMessage({ type: 'settings:setEnabled', enabled: !d.enabled }).catch(() => {});
    location.reload();
  });
  return h(
    'section',
    { className: 'panel' },
    h(
      'div',
      { className: 'status-hero' },
      h(
        'div',
        {},
        h('span', { className: d.enabled ? 'pill' : 'pill off' }, d.enabled ? 'Protected' : 'Paused'),
        h('h2', {}, d.enabled ? 'Protection is active on all websites' : 'Protection is paused everywhere'),
        h('div', { className: 'muted' }, `${d.lists.filter((l) => l.active).length} filter lists active · ${fmt(d.lists.filter((l) => l.active).reduce((a, l) => a + l.ruleCount, 0))} network rules`),
      ),
      toggleBtn,
    ),
    h('div', { className: 'feature-list' }, ...features),
  );
}

function topSitesPanel(d: DashboardData): HTMLElement {
  if (!d.siteStats) {
    return panel('Websites with the most blocks', null, h('p', { className: 'muted' }, 'Per-website statistics are turned off in Settings.'));
  }
  if (!d.topSites.length) {
    return panel('Websites with the most blocks', null, h('p', { className: 'muted' }, 'Nothing recorded yet.'));
  }
  const max = d.topSites[0]!.stat.total || 1;
  const rows = d.topSites.map(({ host, stat }) => {
    const s = split(stat.byCategory);
    const pct = (n: number) => `${(n / max) * 100}%`;
    return h(
      'tr',
      {},
      h('td', { className: 'host' }, host),
      h('td', { className: 'bar-cell' }, h('div', { className: 'hbar', title: `Ads ${fmt(s.ads)} · Trackers ${fmt(s.trackers)} · Other ${fmt(s.other)}` }, s.ads ? h('span', { className: 'ads', style: `width:${pct(s.ads)}` }) : null, s.trackers ? h('span', { className: 'trackers', style: `width:${pct(s.trackers)}` }) : null, s.other ? h('span', { className: 'other', style: `width:${pct(s.other)}` }) : null)),
      h('td', { className: 'num' }, fmt(stat.total)),
    );
  });
  const legend = h('div', { className: 'legend' }, h('span', {}, h('span', { className: 'dot ads' }), 'Ads'), h('span', {}, h('span', { className: 'dot trackers' }), 'Trackers'), h('span', {}, h('span', { className: 'dot other' }), 'Other'));
  return panel(
    'Websites with the most blocks',
    'Counts are kept on this device only.',
    legend,
    h('table', { className: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Website'), h('th', {}, 'Breakdown'), h('th', { className: 'num' }, 'Blocked'))), h('tbody', {}, ...rows)),
  );
}

function listsPanel(d: DashboardData): HTMLElement {
  const rows = d.lists.map((l) =>
    h(
      'tr',
      {},
      h('td', {}, l.title),
      h('td', {}, h('span', { className: l.active ? 'tag good' : 'tag' }, l.active ? 'Active' : 'Inactive')),
      h('td', { className: 'num' }, fmt(l.ruleCount)),
    ),
  );
  const link = h('a', { href: '#lists', className: 'btn small', textContent: 'Manage lists' });
  return h(
    'section',
    { className: 'panel' },
    h('div', { className: 'panel-head' }, h('h2', {}, 'Enabled filter lists'), link),
    h('table', { className: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'List'), h('th', {}, 'Status'), h('th', { className: 'num' }, 'Rules'))), h('tbody', {}, ...rows)),
  );
}

export const dashboardView: View = async (root) => {
  const d = await sendMessage({ type: 'dashboard:get' });
  const since = new Date(d.since).toLocaleDateString();
  const tip = 'Categories are estimated locally from the filter lists that list the blocked domain.';
  const other = d.totalBlocked - (d.totals.ads ?? 0) - (d.totals.trackers ?? 0);
  root.append(
    viewHead('Dashboard', 'What Anti-Venom has blocked on this device. Nothing here ever leaves your browser.'),
    statusPanel(d),
    h(
      'div',
      { className: 'kpis' },
      kpi('Ads blocked', d.totals.ads ?? 0, `since ${since}`, 'ads', tip),
      kpi('Trackers blocked', (d.totals.trackers ?? 0), `${fmt((d.totals.fingerprinting ?? 0))} fingerprinting · ${fmt(d.totals.malicious ?? 0)} malicious`, 'trackers', tip),
      kpi('Blocked today', sumCounts(d.today), 'since midnight'),
      kpi('Total blocked', d.totalBlocked, `${fmt(d.totals.popups ?? 0)} pop-ups · ${fmt(other - (d.totals.popups ?? 0))} other`),
    ),
    h(
      'div',
      { className: 'grid-2' },
      h('section', { className: 'panel' }, h('h2', {}, 'Activity'), h('p', { className: 'sub' }, 'Blocked per day, last 30 days'), activityChart(d.series)),
      listsPanel(d),
    ),
    topSitesPanel(d),
  );
};
