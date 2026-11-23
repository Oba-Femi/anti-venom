/**
 * End-to-end test: loads dist/ into a real Chromium browser and verifies
 * blocking, cosmetic filtering, privacy features, pop-up blocking, website
 * controls, statistics, list updates, persistence and compatibility on a
 * local fixture and on live websites of different kinds.
 *
 *   npm run build && npm run test:e2e
 *   BROWSER="C:/path/to/chrome.exe" npm run test:e2e     (Chrome 126+, Edge, Brave…)
 *   E2E_LIVE=0 npm run test:e2e                          (skip live-site checks)
 *   E2E_HEADLESS=0 npm run test:e2e                      (show the browser)
 *
 * Uses a throwaway profile in the OS temp dir; never touches your real profile.
 */
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, Page, sleep } from './cdp.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'dist');
const LIVE = process.env.E2E_LIVE !== '0';
const HEADLESS = process.env.E2E_HEADLESS !== '0';

function findBrowser(): string {
  if (process.env.BROWSER) return process.env.BROWSER;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const edgeCore = 'C:/Program Files (x86)/Microsoft/EdgeCore';
  if (existsSync(edgeCore)) for (const v of readdirSync(edgeCore).sort().reverse()) candidates.push(`${edgeCore}/${v}/msedge.exe`);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('No Chromium browser found; set BROWSER=/path/to/chrome');
  return found;
}

// --- Reporting --------------------------------------------------------------

let failures = 0;
let passes = 0;
function check(name: string, passed: unknown, detail = ''): void {
  const ok = !!passed;
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? `  (${detail})` : ''}`);
}
const section = (t: string) => console.log(`\n${t}`);

// --- Fixture server ---------------------------------------------------------

const fixture = readFileSync(join(import.meta.dirname, 'fixture.html'), 'utf8');
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(fixture);
  else if (path === '/static/app.js' || path === '/custom-blocked.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end('void 0;');
  else if (path === '/headers') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.headers));
  else res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const PORT = (server.address() as { port: number }).port;
const FIXTURE_URL = `http://127.0.0.1:${PORT}/`;

// --- Helpers ----------------------------------------------------------------

interface FixtureResult {
  results: Record<string, string>;
  hidden: Record<string, boolean>;
}

async function inspectFixture(page: Page, url = FIXTURE_URL): Promise<FixtureResult> {
  await page.goto(url, 3500);
  return page.eval<FixtureResult>(`(() => {
    const ids = ['content', 't-keyed-class', 'ad-slot', 'div-gpt-ad-1234', 't-custom', 't-dynamic-inner'];
    const hidden = {};
    for (const id of ids) { const el = document.getElementById(id); hidden[id] = !el || getComputedStyle(el).display === 'none'; }
    return { results: window.results, hidden };
  })()`);
}

async function extensionId(browser: Browser): Promise<string | null> {
  const sw = (await browser.targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
  return sw ? new URL(sw.url).host : null;
}

function messenger(page: Page) {
  return async <T = any>(msg: object): Promise<T> => {
    const env = await page.eval<{ ok: boolean; data?: T; error?: string }>(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
    if (!env?.ok) throw new Error(`message ${JSON.stringify(msg)} failed: ${env?.error}`);
    return env.data as T;
  };
}

async function openExtensionPage(browser: Browser, id: string): Promise<Page> {
  const page = await browser.newPage(`chrome-extension://${id}/app/app.html#settings`);
  await sleep(1000);
  return page;
}

async function tabIdOf(ext: Page, urlPrefix: string): Promise<number> {
  const host = new URL(urlPrefix).host;
  return ext.eval<number>(`chrome.tabs.query({}).then(ts => (ts.find(t => t.url && new URL(t.url).host === ${JSON.stringify(host)}) || {}).id ?? -1)`);
}

const COMPAT = ['compat-stripe', 'compat-paypal', 'compat-google-signin', 'compat-recaptcha', 'compat-turnstile', 'compat-apple-signin'];

// --- Run ----------------------------------------------------------------------

const executable = findBrowser();
const profile = mkdtempSync(join(tmpdir(), 'anti-venom-e2e-'));
const launchArgs = HEADLESS ? ['--headless=new'] : [];
console.log(`Browser: ${executable}\nProfile: ${profile}\nFixture: ${FIXTURE_URL}`);

let browser = await Browser.launch(executable, profile, launchArgs);
const swErrors: string[] = [];

try {
  const version = await browser.send('Browser.getVersion');
  console.log(`${version.product}`);

  // 1. Install ----------------------------------------------------------------
  section('Install');
  const { id } = await browser.send<{ id: string }>('Extensions.loadUnpacked', { path: DIST });
  check('extension loads unpacked', !!id, id);
  const swTarget = await browser.waitForTarget((t) => t.type === 'service_worker' && t.url.includes(id));
  const sw = await browser.attach(swTarget.targetId);
  await sleep(3000); // onInstalled reconciliation
  let ext = await openExtensionPage(browser, id);
  let send = messenger(ext);

  const rulesets = await ext.eval<string[]>('chrome.declarativeNetRequest.getEnabledRulesets()');
  const expected = ['easylist', 'easyprivacy', 'anti-venom-fingerprinting', 'urlhaus-domains', 'anti-venom-strip-params', 'anti-venom-gpc'];
  check('default rulesets enabled', expected.every((r) => rulesets.includes(r)) && !rulesets.includes('anti-venom-beacons'), rulesets.join(','));
  const available = await ext.eval<number>('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
  check('static rule quota has headroom', available > 0, `${available} available`);
  const regexReport = await ext.eval<{ total: number; bad: string[] }>(`(async () => {
    const res = chrome.runtime.getManifest().declarative_net_request.rule_resources;
    let total = 0; const bad = [];
    for (const r of res) {
      const rules = await fetch(chrome.runtime.getURL(r.path)).then(x => x.json());
      for (const rule of rules) {
        if (!rule.condition.regexFilter) continue;
        total++;
        const s = await chrome.declarativeNetRequest.isRegexSupported({ regex: rule.condition.regexFilter, isCaseSensitive: !!rule.condition.isUrlFilterCaseSensitive });
        if (!s.isSupported) bad.push(r.id + '#' + rule.id + ':' + s.reason);
      }
    }
    return { total, bad };
  })()`);
  check('every bundled regex rule is accepted by Chrome', regexReport.bad.length === 0, `${regexReport.total} checked${regexReport.bad.length ? '; rejected: ' + regexReport.bad.join(', ') : ''}`);
  const gpcScript = await ext.eval<any[]>(`chrome.scripting.getRegisteredContentScripts()`);
  check('GPC page script registered (MAIN world)', gpcScript.some((s) => s.id === 'anti-venom-gpc' && s.world === 'MAIN'));

  // 2. Blocking + cosmetics ---------------------------------------------------
  section('Blocking and cosmetic filtering');
  const page = await browser.newPage();
  let r = await inspectFixture(page);
  check('ad script blocked', r.results.adsense === 'blocked');
  check('tracker script blocked', r.results.gtm === 'blocked');
  check('tracking pixel blocked', r.results.fbpixel === 'blocked');
  check('fingerprinting script blocked', r.results.fingerprint === 'blocked');
  check('third-party CDN control loads', r.results['control-cdn'] === 'loaded', r.results['control-cdn']);
  check('first-party control loads', r.results['control-local'] === 'loaded');
  for (const c of COMPAT) check(`compatibility: ${c.slice(7)} loads`, r.results[c] === 'loaded', r.results[c] ?? 'no result');
  check('article content visible', !r.hidden.content);
  check('generic keyed class hidden', r.hidden['t-keyed-class']);
  check('generic keyed id hidden', r.hidden['ad-slot']);
  check('generic unkeyed selector hidden', r.hidden['div-gpt-ad-1234']);
  check('dynamically inserted ad hidden', r.hidden['t-dynamic-inner']);
  check('unmatched element visible', !r.hidden['t-custom']);

  const fixtureTab = await tabIdOf(ext, FIXTURE_URL);
  let ps = await send<any>({ type: 'popup:getState', tabId: fixtureTab });
  check('popup: per-page count', ps.tab.total >= 4, `${ps.tab.total} blocked`);
  check('popup: categories (ads, trackers, fingerprinting)', ps.tab.byCategory.ads >= 1 && ps.tab.byCategory.trackers >= 1 && ps.tab.byCategory.fingerprinting >= 1, JSON.stringify(ps.tab.byCategory));
  check('popup: blocked domains listed (hostnames only)', ps.tab.entries.some((e: any) => e.host === 'pagead2.googlesyndication.com') && ps.tab.entries.every((e: any) => !e.host.includes('/')));
  check('popup: host and active state', ps.host === '127.0.0.1' && ps.active === true);

  // 3. Privacy features ----------------------------------------------------------
  section('Privacy protection');
  await page.goto(`${FIXTURE_URL}?id=7&utm_source=newsletter&fbclid=abc123&keep=1`, 1500);
  const search = await page.eval<string>('location.search');
  check('tracking parameters stripped, others kept', search === '?id=7&keep=1', search);
  const headers = await page.eval<Record<string, string>>(`fetch('/headers').then(r => r.json())`);
  check('Sec-GPC header sent', headers['sec-gpc'] === '1', headers['sec-gpc']);
  const gpcJs = await page.eval<boolean>('navigator.globalPrivacyControl === true');
  check('navigator.globalPrivacyControl exposed', gpcJs);

  // 4. Custom filters ---------------------------------------------------------
  section('Custom rules');
  const cf = await send<any>({ type: 'customFilters:set', text: '! test\n/custom-blocked.js$script\n127.0.0.1##.custom-hide\n' });
  check('custom rules compiled', cf.networkRules === 1 && cf.cosmeticFilters === 1, JSON.stringify(cf));
  r = await inspectFixture(page);
  check('custom network rule blocks', r.results.custom === 'blocked');
  check('custom hiding rule hides', r.hidden['t-custom']);

  // 5. Website controls ----------------------------------------------------------
  section('Website controls');
  await send({ type: 'site:setPolicy', host: '127.0.0.1', patch: { tracking: false } });
  r = await inspectFixture(page);
  check('tracking off for site: tracker and fingerprinting allowed', r.results.gtm === 'loaded' && r.results.fingerprint === 'loaded', `${r.results.gtm}/${r.results.fingerprint}`);
  check('tracking off for site: ads still blocked, hiding still on', r.results.adsense === 'blocked' && r.hidden['t-keyed-class']);
  await page.goto(`${FIXTURE_URL}?utm_source=x`, 1200);
  check('tracking off for site: parameters not stripped', (await page.eval<string>('location.search')) === '?utm_source=x');
  await send({ type: 'site:setPolicy', host: '127.0.0.1', patch: { tracking: null, cosmetic: false } });
  r = await inspectFixture(page);
  check('hiding off for site: elements visible, network blocking on', !r.hidden['t-keyed-class'] && r.results.adsense === 'blocked' && r.results.gtm === 'blocked');
  await send({ type: 'site:setPolicy', host: '127.0.0.1', patch: { cosmetic: null, protection: false } });
  r = await inspectFixture(page);
  check('protection off for site: everything loads', r.results.adsense === 'loaded' && r.results.custom === 'loaded' && r.results.gtm === 'loaded', JSON.stringify(r.results));
  check('protection off for site: no hiding', !r.hidden['t-keyed-class'] && !r.hidden['t-custom']);
  ps = await send<any>({ type: 'popup:getState', tabId: fixtureTab });
  check('popup reflects site exception', ps.active === false && ps.policy.protection === false);
  await send({ type: 'site:setPolicy', host: '127.0.0.1', patch: { protection: true } });
  r = await inspectFixture(page);
  check('protection back on', r.results.adsense === 'blocked' && r.hidden['t-keyed-class']);

  const until = await send<number>({ type: 'site:pause', host: '127.0.0.1', minutes: 60 });
  r = await inspectFixture(page);
  check('temporary pause: ads allowed', r.results.adsense === 'loaded' && !r.hidden['t-keyed-class']);
  check('temporary pause expires in ~1 hour', Math.abs(until - Date.now() - 3_600_000) < 120_000);
  const sessionRules = await ext.eval<any[]>('chrome.declarativeNetRequest.getSessionRules()');
  check('pause stored as a session rule (cleared on restart)', sessionRules.some((x) => x.id === 12));
  await send({ type: 'site:resume', host: '127.0.0.1' });
  r = await inspectFixture(page);
  check('resume: blocking restored', r.results.adsense === 'blocked');
  const rows = await send<any[]>({ type: 'sites:list' });
  check('website list contains only real exceptions', rows.length === 0, JSON.stringify(rows));

  // 6. Pop-up blocking -------------------------------------------------------------
  section('Pop-up blocking');
  const popupHost = '0i0i0i0.com'; // listed in EasyList as ||0i0i0i0.com^$popup
  const popupsOpen = async () => (await browser.targets()).filter((t) => t.type === 'page' && t.url.includes(popupHost)).length;
  await page.goto(FIXTURE_URL, 1500);
  await page.send('Runtime.evaluate', { expression: `window.open('https://${popupHost}/', '_blank')`, userGesture: true });
  await sleep(2500);
  check('ad pop-up closed', (await popupsOpen()) === 0);
  await page.send('Runtime.evaluate', { expression: `window.open('/?same-site-popup=1', '_blank')`, userGesture: true });
  await sleep(1500);
  const samesite = (await browser.targets()).filter((t) => t.type === 'page' && t.url.includes('same-site-popup'));
  check('same-site pop-up kept', samesite.length === 1);
  for (const t of samesite) await browser.send('Target.closeTarget', { targetId: t.targetId });
  ps = await send<any>({ type: 'popup:getState', tabId: fixtureTab });
  check('pop-up counted', (ps.tab.byCategory.popups ?? 0) >= 1, JSON.stringify(ps.tab.byCategory));

  // 7. Global switches -------------------------------------------------------------
  section('Global switches');
  await send({ type: 'settings:setEnabled', enabled: false });
  const pausedRulesets = await ext.eval<string[]>('chrome.declarativeNetRequest.getEnabledRulesets()');
  check('paused: all rulesets disabled', pausedRulesets.length === 0, pausedRulesets.join(','));
  r = await inspectFixture(page);
  // fbpixel is not asserted: Edge's built-in tracking prevention blocks it independently.
  check('paused: everything loads', r.results.adsense === 'loaded' && r.results.gtm === 'loaded' && r.results.custom === 'loaded', JSON.stringify(r.results));
  await send({ type: 'settings:setEnabled', enabled: true });
  await send({ type: 'settings:update', patch: { trackingProtection: false } });
  r = await inspectFixture(page);
  check('tracking protection off: trackers load, ads blocked', r.results.gtm === 'loaded' && r.results.adsense === 'blocked');
  await send({ type: 'settings:update', patch: { trackingProtection: true, privacy: { blockBeacons: true } } });
  check('beacon blocking can be enabled', (await ext.eval<string[]>('chrome.declarativeNetRequest.getEnabledRulesets()')).includes('anti-venom-beacons'));
  await send({ type: 'settings:update', patch: { privacy: { blockBeacons: false } } });
  r = await inspectFixture(page);
  check('settings restored: tracker blocked', r.results.gtm === 'blocked');

  // 8. Dashboard ---------------------------------------------------------------------
  section('Dashboard and statistics');
  await sleep(2000); // stats flush
  const dash = await send<any>({ type: 'dashboard:get' });
  check('dashboard totals by category', dash.totals.ads > 0 && dash.totals.trackers > 0, JSON.stringify(dash.totals));
  check('blocked today', Object.values(dash.today as Record<string, number>).reduce((a, b) => a + b, 0) > 0);
  check('30-day series', dash.series.length === 30);
  check('top websites recorded locally', dash.topSites.some((s: any) => s.host === '127.0.0.1'));
  check('enabled lists reported', dash.lists.length >= 4);

  // 9. Filter lists ------------------------------------------------------------------
  section('Filter lists');
  const lists = await send<any[]>({ type: 'lists:update', id: 'easylist' });
  const easylist = lists.find((l) => l.id === 'easylist');
  check('EasyList runtime update', !easylist.lastError || /skipped/.test(easylist.lastError), easylist.lastError ?? `+${easylist.dynamicRuleCount} / -${easylist.disabledStaticCount}`);
  const urlhaus = (await send<any[]>({ type: 'lists:update', id: 'urlhaus-domains' })).find((l) => l.id === 'urlhaus-domains');
  check('malicious-domain list runtime update', !urlhaus.lastError, urlhaus.lastError ?? `${urlhaus.ruleCount} rules`);
  check('unsupported syntax reported per list', Object.keys(easylist.unsupported ?? {}).length > 0);
  await send({ type: 'lists:setEnabled', id: 'peter-lowe', enabled: true });
  const opts = await send<any>({ type: 'options:getState' });
  const pl = opts.lists.find((l: any) => l.id === 'peter-lowe');
  check('on-demand list installs as dynamic rules', pl.dynamicRuleCount > 0 && !pl.lastError, `${pl.dynamicRuleCount} rules`);
  const bad = await send<any>({ type: 'lists:add', url: `http://127.0.0.1:${PORT}/missing.txt` }).then(() => null, (e: Error) => e.message);
  check('failed subscription rejected without side effects', !!bad && /404|Could not add/.test(bad), bad ?? '');
  r = await inspectFixture(page);
  check('blocking still correct after updates', r.results.adsense === 'blocked' && r.results['control-cdn'] === 'loaded' && r.hidden['t-keyed-class']);
  await send({ type: 'settings:update', patch: { updateIntervalHours: 24 } });
  check('update schedule saved', (await send<any>({ type: 'options:getState' })).settings.updateIntervalHours === 24);

  // 10. Live sites -----------------------------------------------------------------
  if (LIVE) {
    section('Live websites (blocked count, page health, comparison with protection paused)');
    const sites: [string, string, boolean][] = [
      ['news', 'https://www.cnn.com/', true],
      ['news', 'https://www.bbc.com/news', true],
      ['blog', 'https://wordpress.org/news/', false],
      ['video', 'https://www.youtube.com/', false],
      ['video', 'https://vimeo.com/', false],
      ['shopping', 'https://www.amazon.com/', false],
      ['shopping', 'https://www.ebay.com/', true],
      ['social', 'https://www.reddit.com/', false],
      ['search', 'https://www.bing.com/search?q=weather', false],
      ['search', 'https://duckduckgo.com/?q=weather', false],
      ['web app', 'https://github.com/', false],
      ['web app', 'https://excalidraw.com/', false],
      ['reference', 'https://www.wikipedia.org/', false],
    ];
    const live = await browser.newPage();
    await live.send('Emulation.setUserAgentOverride', { userAgent: String(version.userAgent).replace('HeadlessChrome', 'Chrome') });
    for (const [kind, url, expectBlocks] of sites) {
      try {
        live.consoleErrors.length = 0;
        // Warm-up visit: some sites (e.g. eBay) serve an error page to a first, cookieless visit
        // regardless of extensions; measure on the second load.
        await live.goto(url, 2500);
        await live.goto(url, 5000);
        const info = await live.eval<{ text: number }>('({ text: document.body ? document.body.innerText.length : 0 })');
        const st = await send<any>({ type: 'popup:getState', tabId: await tabIdOf(ext, url) });
        let healthy = info.text > 150;
        let detail = `${st.tab.total} blocked, ${info.text} chars`;
        // Compare with protection paused: does the page render more content without us?
        await send({ type: 'settings:setEnabled', enabled: false });
        await live.goto(url, 5000);
        const control = await live.eval<{ text: number }>('({ text: document.body ? document.body.innerText.length : 0 })');
        await send({ type: 'settings:setEnabled', enabled: true });
        if (control.text > 150 && info.text < control.text * 0.5) {
          healthy = false;
          detail += `; ${control.text} chars with protection paused → possible breakage`;
        } else if (!healthy) {
          healthy = true;
          detail += `; also ${control.text} chars when paused → site behaviour`;
        }
        check(`[${kind}] ${new URL(url).host}${expectBlocks ? ' – ads/trackers blocked' : ''}`, healthy && (!expectBlocks || st.tab.total > 0), detail);
      } catch (err) {
        console.log(`  - ${url}: skipped (${(err as Error).message})`);
      }
    }
    await live.close();
  }

  // 11. Persistence across restart ------------------------------------------------
  section('Persistence across browser restart');
  await send({ type: 'site:setPolicy', host: 'example.org', patch: { protection: false } });
  await send({ type: 'site:pause', host: 'paused.example', minutes: 0 });
  await send({ type: 'settings:update', patch: { showBadge: false } });
  await sleep(2000);
  const before = await send<any>({ type: 'dashboard:get' });
  await browser.close();
  browser = await Browser.launch(executable, profile, launchArgs);
  await sleep(2500);
  let id2 = await extensionId(browser);
  if (!id2) {
    // CDP-loaded extensions are re-registered on restart in this harness; storage persists in the profile.
    id2 = (await browser.send<{ id: string }>('Extensions.loadUnpacked', { path: DIST })).id;
    await sleep(2500);
  }
  check('same extension id after restart', id2 === id, id2 ?? 'none');
  ext = await openExtensionPage(browser, id2!);
  send = messenger(ext);
  const after = await send<any>({ type: 'options:getState' });
  check('website exceptions persisted', after.settings.sites['example.org']?.protection === false);
  check('settings persisted', after.settings.showBadge === false && after.settings.customFilters.includes('custom-hide') && after.settings.updateIntervalHours === 24);
  check('"until restart" pause cleared by restart', !('paused.example' in after.pauses));
  const afterDash = await send<any>({ type: 'dashboard:get' });
  check('statistics persisted', afterDash.totalBlocked >= before.totalBlocked, `${afterDash.totalBlocked}`);
  check('list state persisted', after.lists.find((l: any) => l.id === 'peter-lowe')?.enabled === true);
  const page2 = await browser.newPage();
  r = await inspectFixture(page2);
  check('blocking active after restart', r.results.adsense === 'blocked' && r.results.custom === 'blocked' && r.hidden['t-custom'] && r.results.fingerprint === 'blocked');

  // 12. Restore defaults --------------------------------------------------------------
  section('Restore defaults');
  await send({ type: 'settings:reset' });
  const reset = await send<any>({ type: 'options:getState' });
  check('defaults restored', Object.keys(reset.settings.sites).length === 0 && reset.settings.customFilters === '' && reset.settings.showBadge === true);
  check('runtime rules cleared', reset.quota.dynamicUsed === 0, `${reset.quota.dynamicUsed}`);
  r = await inspectFixture(page2);
  check('blocking works after reset', r.results.adsense === 'blocked' && r.results.custom === 'loaded');

  // 13. UI pages load without errors --------------------------------------------------
  section('User interface');
  for (const view of ['dashboard', 'sites', 'lists', 'privacy', 'rules', 'settings', 'about']) {
    const p = await browser.newPage(`chrome-extension://${id2}/app/app.html#${view}`);
    await sleep(900);
    const ok = await p.eval<boolean>(`!!document.querySelector('#view h1') && !document.querySelector('#view .panel.error')`);
    check(`app view "${view}" renders`, ok && p.consoleErrors.length === 0, p.consoleErrors.join(' | '));
    await p.close();
  }
  const popup = await browser.newPage(`chrome-extension://${id2}/popup/popup.html?tabId=${await tabIdOf(ext, FIXTURE_URL)}`);
  await sleep(1000);
  check('popup renders', await popup.eval<boolean>(`document.querySelector('.popup').dataset.state === 'active'`) && popup.consoleErrors.length === 0, popup.consoleErrors.join(' | '));

  const diag = reset.diagnostics.filter((d: any) => d.level === 'error' && !/missing\.txt|404/.test(d.message));
  check('no unexpected errors recorded', diag.length === 0, diag.map((d: any) => d.message).join(' | '));
  swErrors.push(...sw.consoleErrors);
} catch (err) {
  failures++;
  console.error('\nE2E run aborted:', err);
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

const unexpected = swErrors.filter((e) => !/missing\.txt|404|custom-/.test(e));
if (unexpected.length) console.log('\nService worker console:\n' + unexpected.map((e) => `  ${e}`).join('\n'));
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
