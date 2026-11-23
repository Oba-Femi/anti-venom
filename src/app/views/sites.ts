/** Website control center: per-site exceptions, pauses and per-site stats. */
import { sendMessage, type SitePatch } from '../../shared/messages.ts';
import type { SiteRow } from '../../shared/types.ts';
import { normalizeSiteInput } from '../../filters/domains.ts';
import { fmt, h, infoTip, toggle } from '../../ui/dom.ts';
import { viewHead, type View } from '../context.ts';

function pauseText(until?: number): string | null {
  if (!until) return null;
  if (until >= Number.MAX_SAFE_INTEGER) return 'Paused until restart';
  return `Paused until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export const sitesView: View = async (root, ctx) => {
  const [rows, dash] = await Promise.all([sendMessage({ type: 'sites:list' }), sendMessage({ type: 'dashboard:get' })]);
  let filter = '';

  const setPolicy = (host: string, patch: SitePatch, msg: string) =>
    ctx.act(() => sendMessage({ type: 'site:setPolicy', host, patch }), msg).then(() => ctx.rerender());

  // --- Add form ---------------------------------------------------------------
  const input = h('input', { type: 'text', placeholder: 'example.com or https://example.com/page', attrs: { 'aria-label': 'Website' } });
  const action = h(
    'select',
    { attrs: { 'aria-label': 'Exception type' } },
    h('option', { value: 'protection' }, 'Turn off all blocking'),
    h('option', { value: 'tracking' }, 'Turn off tracking protection only'),
    h('option', { value: 'cosmetic' }, 'Turn off placeholder hiding only'),
  );
  const status = h('p', { className: 'hint' });
  const form = h('form', { className: 'inline-form' }, input, action, h('button', { className: 'btn primary', type: 'submit', textContent: 'Add exception' }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const host = normalizeSiteInput(input.value);
    if (!host) {
      status.className = 'hint err';
      status.textContent = 'Enter a valid hostname, e.g. example.com';
      return;
    }
    const field = action.value as keyof SitePatch;
    void setPolicy(host, { [field]: false }, `Exception added for ${host}`);
  });

  // --- Table --------------------------------------------------------------------
  const tbody = h('tbody');
  const cell = (row: SiteRow, field: 'protection' | 'tracking' | 'cosmetic', label: string) => {
    const explicit = row.overrides[field];
    const effective = explicit ?? true;
    const disabled = field !== 'protection' && row.overrides.protection === false;
    const t = toggle({
      checked: effective && !disabled,
      disabled,
      label: `${label} on ${row.host}`,
      onChange: (v) => void setPolicy(row.host, { [field]: v }, `${label} ${v ? 'on' : 'off'} for ${row.host}`),
    });
    return h('td', { className: 'toggle-cell' }, t, explicit === undefined ? h('span', { className: 'inherit' }, 'default') : null);
  };

  const renderRows = () => {
    const visible = rows.filter((r) => !filter || r.host.includes(filter));
    if (!visible.length) {
      tbody.replaceChildren(h('tr', {}, h('td', { attrs: { colspan: '6' }, className: 'muted' }, rows.length ? 'No matching websites.' : 'No website exceptions yet. Blocking applies everywhere.')));
      return;
    }
    tbody.replaceChildren(
      ...visible.map((r) => {
        const remove = h('button', { className: 'btn small ghost', textContent: 'Reset', title: 'Remove all exceptions for this website' });
        remove.addEventListener('click', () => void ctx.act(() => sendMessage({ type: 'site:remove', host: r.host }), `${r.host} reset to defaults`).then(() => ctx.rerender()));
        const paused = pauseText(r.pausedUntil);
        const resume = paused ? h('button', { className: 'btn small', textContent: 'Resume' }) : null;
        resume?.addEventListener('click', () => void ctx.act(() => sendMessage({ type: 'site:resume', host: r.host }), `${r.host} resumed`).then(() => ctx.rerender()));
        return h(
          'tr',
          {},
          h('td', { className: 'host' }, r.host, paused ? h('div', { className: 'hint', style: 'color:var(--warn)' }, paused) : null),
          cell(r, 'protection', 'Blocking'),
          cell(r, 'tracking', 'Tracking protection'),
          cell(r, 'cosmetic', 'Placeholder hiding'),
          h('td', { className: 'num' }, r.stat ? fmt(r.stat.total) : '—'),
          h('td', { className: 'num' }, resume, remove),
        );
      }),
    );
  };
  renderRows();

  const search = h('input', { type: 'search', className: 'search', placeholder: 'Filter websites', attrs: { 'aria-label': 'Filter websites' } });
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    renderRows();
  });

  // --- Suggestions: busiest sites without rules -------------------------------------
  const known = new Set(rows.map((r) => r.host));
  const suggestions = dash.topSites.filter((s) => !known.has(s.host.replace(/^www\./, '')) && !known.has(s.host)).slice(0, 6);

  root.append(
    viewHead('Websites', 'Turn protection off, or switch off individual features, for specific websites. Rules apply to subdomains too.'),
    h(
      'section',
      { className: 'panel' },
      h('h2', {}, 'Add a website exception'),
      h('p', { className: 'sub' }, 'Use this when a site breaks or when you want to support it by allowing its ads. Temporary pauses are available from the toolbar popup.'),
      form,
      status,
    ),
    h(
      'section',
      { className: 'panel' },
      h('div', { className: 'panel-head' }, h('h2', {}, `Exceptions (${rows.length})`), search),
      h(
        'table',
        { className: 'data' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Website'),
            h('th', { className: 'toggle-cell' }, 'Blocking ', infoTip('Off: nothing is blocked or hidden on this site.')),
            h('th', { className: 'toggle-cell' }, 'Tracking ', infoTip('Off: trackers, fingerprinting scripts and tracking parameters are allowed; ads stay blocked.')),
            h('th', { className: 'toggle-cell' }, 'Hiding ', infoTip('Off: empty ad placeholders are not hidden; network blocking is unchanged.')),
            h('th', { className: 'num' }, 'Blocked'),
            h('th', {}),
          ),
        ),
        tbody,
      ),
    ),
    suggestions.length
      ? h(
          'section',
          { className: 'panel' },
          h('h2', {}, 'Most-blocked websites'),
          h('p', { className: 'sub' }, 'Sites where Anti-Venom blocks the most. Add an exception if one of them misbehaves.'),
          h(
            'table',
            { className: 'data' },
            h(
              'tbody',
              {},
              ...suggestions.map((s) => {
                const add = h('button', { className: 'btn small', textContent: 'Allow ads here' });
                add.addEventListener('click', () => void setPolicy(s.host, { protection: false }, `Blocking turned off on ${s.host}`));
                return h('tr', {}, h('td', { className: 'host' }, s.host), h('td', { className: 'num' }, fmt(s.stat.total)), h('td', { className: 'num' }, add));
              }),
            ),
          ),
        )
      : '',
  );
};
