/** Custom rule editor (ABP syntax). */
import { sendMessage } from '../../shared/messages.ts';
import { errorText, fmt, h } from '../../ui/dom.ts';
import { panel, viewHead, type View } from '../context.ts';

const EXAMPLES: [string, string][] = [
  ['||ads.example.com^', 'Block a domain and its subdomains'],
  ['||example.com/banner/*$image', 'Block images under a path'],
  ['||tracker.example^$third-party', 'Block only when embedded by other sites'],
  ['example.com##.sponsored', 'Hide elements on one site'],
  ['##.ad-slot', 'Hide elements on every site'],
  ['@@||example.com^$document', 'Turn off all blocking on a site'],
  ['||popups.example^$popup', 'Close pop-ups to a domain'],
];

export const rulesView: View = async (root, ctx) => {
  const state = await sendMessage({ type: 'options:getState' });
  const editor = h('textarea', { rows: 16, spellcheck: false, placeholder: '! One rule per line. Lines starting with ! are comments.', value: state.settings.customFilters, attrs: { 'aria-label': 'Custom rules' } });
  const status = h('p', { className: 'hint' });
  let dirty = false;
  editor.addEventListener('input', () => {
    dirty = true;
    status.className = 'hint';
    status.textContent = 'Unsaved changes';
  });
  const save = h('button', { className: 'btn primary', textContent: 'Apply rules' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const res = await sendMessage({ type: 'customFilters:set', text: editor.value });
      const skipped = Object.entries(res.skipped);
      const skippedTotal = skipped.reduce((a, [, n]) => a + n, 0);
      status.className = skippedTotal ? 'hint err' : 'hint ok';
      status.textContent =
        `Applied ${fmt(res.networkRules)} network, ${fmt(res.cosmeticFilters)} hiding and ${fmt(res.popupFilters)} pop-up rule(s).` +
        (skippedTotal ? ` ${skippedTotal} rule(s) use unsupported syntax: ${skipped.map(([k, n]) => `${k} (${n})`).join(', ')}.` : '');
      dirty = false;
      ctx.toast('Custom rules applied');
    } catch (err) {
      status.className = 'hint err';
      status.textContent = `Not applied — your previous rules are still active. ${errorText(err)}`;
    } finally {
      save.disabled = false;
    }
  });

  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (dirty) e.preventDefault();
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  root.append(
    viewHead('Custom rules', 'Your own blocking and hiding rules in Adblock Plus syntax. They take precedence like any filter-list rule and are stored only on this device.'),
    h('section', { className: 'panel' }, editor, h('div', { style: 'display:flex;gap:12px;align-items:center;margin-top:10px' }, save, status)),
    panel(
      'Syntax quick reference',
      null,
      h('table', { className: 'data' }, h('tbody', {}, ...EXAMPLES.map(([code, text]) => h('tr', {}, h('td', {}, h('code', {}, code)), h('td', { className: 'muted' }, text))))),
    ),
  );
  return () => window.removeEventListener('beforeunload', onBeforeUnload);
};
