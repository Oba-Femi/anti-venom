/** About, privacy statement, permissions and attributions. */
import { sendMessage } from '../../shared/messages.ts';
import { LIST_CATALOG } from '../../shared/catalog.ts';
import { h } from '../../ui/dom.ts';
import { panel, viewHead, type View } from '../context.ts';

const PERMISSIONS: [string, string][] = [
  ['declarativeNetRequest', 'Blocks requests inside the browser using filter-list rules. Anti-Venom never sees the requests themselves.'],
  ['host access (all sites)', 'Injects hiding styles into pages, counts blocked requests, and applies redirect / header rules (tracking parameters, GPC).'],
  ['webRequest', 'Observes (never modifies) failed requests to count blocks. Only counts and hostnames are kept.'],
  ['webNavigation', 'Detects new tabs opened by a page so pop-up ads can be closed.'],
  ['scripting', 'Inserts hiding styles and the Global Privacy Control signal into pages.'],
  ['storage, unlimitedStorage', 'Keeps settings, statistics and downloaded filter lists on this device.'],
  ['alarms', 'Schedules filter-list updates and the end of temporary pauses.'],
];

export const aboutView: View = async (root) => {
  const state = await sendMessage({ type: 'options:getState' });
  root.append(
    viewHead('About Anti-Venom', `Version ${state.version}`),
    panel(
      'Privacy',
      null,
      h(
        'ul',
        { className: 'prose' },
        h('li', {}, 'Blocking happens inside your browser. Anti-Venom does not collect, sell or share your browsing information.'),
        h('li', {}, 'There is no analytics, telemetry, account or remote logging. Settings and statistics stay on this device.'),
        h('li', {}, 'The only network requests Anti-Venom makes are filter-list downloads from their publishers, without cookies or referrer.'),
        h('li', {}, 'Downloaded lists are data only: they are validated and converted to rules. Anti-Venom never runs downloaded code.'),
      ),
    ),
    panel('Permissions', 'Why Anti-Venom needs each permission it asks for.', h('table', { className: 'data' }, h('tbody', {}, ...PERMISSIONS.map(([p, why]) => h('tr', {}, h('td', {}, h('code', {}, p)), h('td', { className: 'muted' }, why)))))),
    panel(
      'Filter list credits',
      null,
      h(
        'table',
        { className: 'data' },
        h('tbody', {}, ...LIST_CATALOG.map((l) => h('tr', {}, h('td', {}, l.homepage ? h('a', { href: l.homepage, target: '_blank', rel: 'noopener noreferrer', textContent: l.title }) : l.title), h('td', { className: 'muted' }, `${l.attribution} · ${l.license}`)))),
      ),
    ),
  );
};
