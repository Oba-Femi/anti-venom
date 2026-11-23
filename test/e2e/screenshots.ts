/**
 * Captures popup and dashboard screenshots (light + dark) into screenshots/
 * for visual review. Usage: npm run build && node test/e2e/screenshots.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, sleep, type Page } from './cdp.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

function findBrowser(): string {
  if (process.env.BROWSER) return process.env.BROWSER;
  const edgeCore = 'C:/Program Files (x86)/Microsoft/EdgeCore';
  const list = ['C:/Program Files/Google/Chrome/Application/chrome.exe'];
  if (existsSync(edgeCore)) for (const v of readdirSync(edgeCore).sort().reverse()) list.push(`${edgeCore}/${v}/msedge.exe`);
  const found = list.find((p) => existsSync(p));
  if (!found) throw new Error('set BROWSER');
  return found;
}

async function shot(page: Page, file: string, width: number, height: number, dark: boolean, full = false): Promise<void> {
  await page.send('Page.bringToFront');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await sleep(700);
  const params: Record<string, unknown> = { format: 'png' };
  if (full) {
    const { cssContentSize } = await page.send('Page.getLayoutMetrics');
    params.clip = { x: 0, y: 0, width, height: Math.min(cssContentSize.height, 2400), scale: 1 };
    params.captureBeyondViewport = true;
  }
  const { data } = await page.send('Page.captureScreenshot', params);
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  console.log('wrote', file);
}

const profile = mkdtempSync(join(tmpdir(), 'anti-venom-shots-'));
const browser = await Browser.launch(findBrowser(), profile, ['--headless=new']);
try {
  const v = await browser.send('Browser.getVersion');
  const { id } = await browser.send('Extensions.loadUnpacked', { path: join(ROOT, 'dist') });
  await sleep(3000);
  const ua = String(v.userAgent).replace('HeadlessChrome', 'Chrome');
  // Generate some activity.
  const site = await browser.newPage();
  await site.send('Emulation.setUserAgentOverride', { userAgent: ua });
  for (const u of ['https://www.bbc.com/news', 'https://www.cnn.com/', 'https://duckduckgo.com/?q=weather', 'https://www.theverge.com/']) await site.goto(u, 4000);
  const app = await browser.newPage(`chrome-extension://${id}/app/app.html#dashboard`);
  await sleep(1000);
  const tabId = await app.eval<number>(`chrome.tabs.query({}).then(ts => ts.find(t => t.url && t.url.includes('theverge')).id)`);
  await app.eval(`chrome.runtime.sendMessage({ type: 'site:setPolicy', host: 'bank.example', patch: { tracking: false } })`);
  await app.eval(`chrome.runtime.sendMessage({ type: 'site:setPolicy', host: 'news.example', patch: { protection: false } })`);

  const popup = await browser.newPage(`chrome-extension://${id}/popup/popup.html?tabId=${tabId}`);
  await sleep(1200);
  await shot(popup, 'popup-light.png', 360, 600, false);
  await popup.eval(`document.getElementById('blocked-details').open = true`);
  await shot(popup, 'popup-dark-details.png', 360, 700, true);

  for (const [view, dark] of [['dashboard', false], ['dashboard', true], ['sites', false], ['lists', false], ['privacy', true], ['settings', false]] as [string, boolean][]) {
    await app.goto(`chrome-extension://${id}/app/app.html#${view}`, 1200);
    await shot(app, `app-${view}-${dark ? 'dark' : 'light'}.png`, 1280, 900, dark, true);
  }
  await app.goto(`chrome-extension://${id}/app/app.html#dashboard`, 1200);
  await shot(app, 'app-dashboard-narrow.png', 420, 900, false);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
