/**
 * Stacked daily activity bars (SVG, no dependencies).
 * Three series max — ads, trackers, other — using the validated categorical
 * slots 1–3. Legend always shown, hover tooltip per day, table alternative.
 */
import type { CategoryCounts } from '../shared/types.ts';
import { fmt, h, svg } from '../ui/dom.ts';

type Series = 'ads' | 'trackers' | 'other';
const SERIES: { key: Series; label: string }[] = [
  { key: 'ads', label: 'Ads' },
  { key: 'trackers', label: 'Trackers' },
  { key: 'other', label: 'Other' },
];

export function split(c: CategoryCounts): Record<Series, number> {
  const ads = c.ads ?? 0;
  const trackers = c.trackers ?? 0;
  let total = 0;
  for (const v of Object.values(c)) total += v ?? 0;
  return { ads, trackers, other: total - ads - trackers };
}

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function shortDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Rect path with rounded top corners only (data end), flat at the baseline. */
function topRoundedRect(x: number, y: number, w: number, hgt: number, r: number): string {
  const rr = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

export function activityChart(series: { day: string; counts: CategoryCounts }[]): HTMLElement {
  const wrap = h('div', { className: 'chart-wrap' });
  const legend = h('div', { className: 'legend', attrs: { 'aria-hidden': 'true' } }, ...SERIES.map((s) => h('span', {}, h('span', { className: `dot ${s.key}` }), s.label)));
  const chart = h('div', { className: 'chart' });
  const tooltip = h('div', { className: 'tooltip', hidden: true });
  const table = buildTable(series);
  table.hidden = true;

  const showTable = h('button', { className: 'btn small ghost', textContent: 'Show as table' });
  showTable.addEventListener('click', () => {
    table.hidden = !table.hidden;
    chart.hidden = !table.hidden;
    legend.hidden = !table.hidden;
    showTable.textContent = table.hidden ? 'Show as table' : 'Show as chart';
  });

  const data = series.map((d) => ({ day: d.day, ...split(d.counts) }));
  const maxTotal = Math.max(0, ...data.map((d) => d.ads + d.trackers + d.other));

  const draw = () => {
    const width = Math.max(300, chart.clientWidth || 640);
    const height = 200;
    const m = { top: 8, right: 4, bottom: 22, left: 40 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;
    const yMax = niceMax(maxTotal);
    const step = iw / data.length;
    const barW = Math.max(3, Math.min(22, step * 0.62));
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': `Blocked requests per day, last ${data.length} days` });

    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      const y = m.top + ih - (v / yMax) * ih;
      root.append(svg('line', { class: 'gridline', x1: m.left, x2: width - m.right, y1: y, y2: y }));
      root.append(svg('text', { class: 'axis', x: m.left - 8, y: y + 4, 'text-anchor': 'end' }, i === 0 ? '0' : compactAxis(v)));
    }

    data.forEach((d, i) => {
      const x = m.left + i * step + (step - barW) / 2;
      let yCursor = m.top + ih;
      const parts = SERIES.filter((s) => d[s.key] > 0);
      parts.forEach((s, idx) => {
        const hgt = (d[s.key] / yMax) * ih;
        const isTop = idx === parts.length - 1;
        // 2px surface gap between stacked segments.
        const gap = idx > 0 ? 2 : 0;
        const segH = Math.max(0, hgt - gap);
        const y = yCursor - hgt;
        const attrs = { fill: `var(--series-${s.key})` };
        if (isTop) root.append(svg('path', { ...attrs, d: topRoundedRect(x, y, barW, segH, 4) }));
        else root.append(svg('rect', { ...attrs, x, y, width: barW, height: segH }));
        yCursor = y;
      });
      // Sparse x labels: first, last and roughly weekly.
      const weekly = (data.length - 1 - i) % 7 === 0 && i >= 4;
      if (i === 0 || weekly) {
        root.append(svg('text', { class: 'axis', x: x + barW / 2, y: height - 6, 'text-anchor': 'middle' }, shortDay(d.day)));
      }
      // Hit target wider than the bar.
      const hit = svg('rect', { class: 'hit', x: m.left + i * step, y: m.top, width: step, height: ih, rx: 3 });
      hit.addEventListener('mouseenter', () => {
        tooltip.replaceChildren(
          h('div', { className: 't-day' }, shortDay(d.day)),
          ...SERIES.map((s) => h('div', { className: 't-row' }, h('span', {}, h('span', { className: `dot ${s.key}` }), s.label), h('strong', {}, fmt(d[s.key])))),
          h('div', { className: 't-row', style: 'margin-top:4px' }, h('span', {}, 'Total'), h('strong', {}, fmt(d.ads + d.trackers + d.other))),
        );
        tooltip.hidden = false;
        const left = Math.min(Math.max(m.left + i * step + step / 2 - 75, 0), width - 160);
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${legend.offsetHeight + 4}px`;
      });
      hit.addEventListener('mouseleave', () => (tooltip.hidden = true));
      root.append(hit);
    });
    chart.replaceChildren(root);
  };

  wrap.append(legend, chart, tooltip, table);
  const footer = h('div', { style: 'display:flex;justify-content:flex-end;margin-top:4px' }, showTable);

  if (maxTotal === 0) {
    chart.replaceChildren(h('div', { className: 'empty-chart' }, 'No blocking activity recorded yet. Browse a few websites and check back.'));
    return h('div', {}, wrap, footer);
  }
  const ro = new ResizeObserver(() => draw());
  ro.observe(chart);
  requestAnimationFrame(draw);
  return h('div', {}, wrap, footer);
}

function compactAxis(v: number): string {
  return v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v));
}

function buildTable(series: { day: string; counts: CategoryCounts }[]): HTMLTableElement {
  const rows = [...series].reverse().map((d) => {
    const s = split(d.counts);
    return h('tr', {}, h('td', {}, shortDay(d.day)), h('td', { className: 'num' }, fmt(s.ads)), h('td', { className: 'num' }, fmt(s.trackers)), h('td', { className: 'num' }, fmt(s.other)), h('td', { className: 'num' }, fmt(s.ads + s.trackers + s.other)));
  });
  return h(
    'table',
    { className: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', { className: 'num' }, 'Ads'), h('th', { className: 'num' }, 'Trackers'), h('th', { className: 'num' }, 'Other'), h('th', { className: 'num' }, 'Total'))),
    h('tbody', {}, ...rows),
  );
}
