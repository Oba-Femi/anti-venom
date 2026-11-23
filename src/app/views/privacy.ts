/** Privacy protection settings. */
import { sendMessage, type SettingsPatch } from '../../shared/messages.ts';
import { h, toggle } from '../../ui/dom.ts';
import { panel, settingRow, viewHead, type View } from '../context.ts';

export const privacyView: View = async (root, ctx) => {
  const state = await sendMessage({ type: 'options:getState' });
  const s = state.settings;
  const master = s.trackingProtection;
  const list = (id: string) => state.lists.find((l) => l.id === id);
  const save = (patch: SettingsPatch, msg: string) => ctx.act(() => sendMessage({ type: 'settings:update', patch }), msg).then(() => ctx.rerender());
  const listToggle = (id: string, label: string) => {
    const l = list(id);
    return toggle({
      checked: !!l?.enabled && master,
      disabled: !master || !l,
      label,
      onChange: (v) => void ctx.act(() => sendMessage({ type: 'lists:setEnabled', id, enabled: v }), `${label} ${v ? 'on' : 'off'}`).then(() => ctx.rerender()),
    });
  };

  root.append(
    viewHead('Privacy', 'Protection against tracking across websites. Each feature can also be switched off for a single site from the popup or the Websites page.'),
    panel(
      'Tracking protection',
      null,
      settingRow({
        title: 'Block trackers',
        sub: 'Master switch for everything on this page except Global Privacy Control. Blocks known trackers, analytics, tracking pixels and telemetry endpoints (EasyPrivacy).',
        control: toggle({ checked: master, label: 'Tracking protection', onChange: (v) => void save({ trackingProtection: v }, v ? 'Tracking protection on' : 'Tracking protection off') }),
      }),
      settingRow({
        title: 'Block fingerprinting scripts',
        sub: 'Blocks third-party scripts that identify your browser from its characteristics. Fraud-prevention services used by banks and payment providers are deliberately not blocked.',
        control: listToggle('anti-venom-fingerprinting', 'Fingerprinting protection'),
        disabled: !master,
      }),
      settingRow({
        title: 'Remove tracking parameters from links',
        sub: 'Strips click identifiers and campaign tags such as fbclid, gclid, msclkid and utm_* when you open a link. The page you open is unchanged.',
        control: toggle({ checked: s.privacy.stripTrackingParams && master, disabled: !master, label: 'Remove tracking parameters', onChange: (v) => void save({ privacy: { stripTrackingParams: v } }, 'Saved') }),
        disabled: !master,
      }),
      settingRow({
        title: 'Block third-party beacons',
        sub: 'Blocks navigator.sendBeacon and hyperlink-auditing pings sent to other companies. Off by default because a few checkout and anti-fraud systems report this way.',
        control: toggle({ checked: s.privacy.blockBeacons && master, disabled: !master, label: 'Block third-party beacons', onChange: (v) => void save({ privacy: { blockBeacons: v } }, 'Saved') }),
        disabled: !master,
      }),
    ),
    panel(
      'Signals',
      null,
      settingRow({
        title: 'Send Global Privacy Control',
        sub: 'Tells websites you do not want your data sold or shared (Sec-GPC header and navigator.globalPrivacyControl). Legally binding in some places, such as California.',
        control: toggle({ checked: s.privacy.globalPrivacyControl, label: 'Global Privacy Control', onChange: (v) => void save({ privacy: { globalPrivacyControl: v } }, 'Saved') }),
      }),
    ),
    panel(
      'Security',
      null,
      settingRow({
        title: 'Block malicious domains',
        sub: 'Stops pages and downloads from domains currently distributing malware (abuse.ch URLhaus, refreshed every 12 hours). Chrome shows a "blocked" page instead.',
        control: (() => {
          const l = list('urlhaus-domains');
          return toggle({ checked: !!l?.enabled, disabled: !l, label: 'Block malicious domains', onChange: (v) => void ctx.act(() => sendMessage({ type: 'lists:setEnabled', id: 'urlhaus-domains', enabled: v }), 'Saved').then(() => ctx.rerender()) });
        })(),
      }),
    ),
    panel(
      'Not covered',
      null,
      h(
        'ul',
        { className: 'prose' },
        h('li', {}, 'Third-party cookies: use Chrome\'s own setting (Settings → Privacy and security → Third-party cookies). Removing cookies in an extension breaks sign-in on many sites.'),
        h('li', {}, 'Link-wrapping redirects (e.g. google.com/url?q=…): DNR cannot decode the destination safely, so these are left alone.'),
      ),
    ),
  );
};
