/**
 * Background modules against the in-memory chrome mock: settings migration and
 * persistence, list updates (success, diff, failure, invalid data), custom
 * subscriptions and site policies. Requires `npm run build` (reads dist/).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from './helpers/chrome-mock.ts';

const built = existsSync(join(import.meta.dirname, '..', 'dist', 'manifest.json'));
const opts = { skip: built ? false : 'run `npm run build` first' };

const storage = await import('../src/background/storage.ts');
const lists = await import('../src/background/lists.ts');
const engine = await import('../src/background/engine.ts');
const { slotRange, STORAGE_KEYS } = await import('../src/shared/constants.ts');
const { PRIORITY } = await import('../src/filters/dnr-types.ts');

const EASYLIST = 'https://easylist.to/easylist/easylist.txt';
const LIST_TEXT = '[Adblock Plus 2.0]\n! Title: Test\n! Version: 2\n||brand-new-ad.example^\n||another-new.example^$third-party\n##.new-ad-class\n||popupnet.example^$popup\n/extra-ad-path/*$image\nexample.org##.sponsor\n';

async function resetState(): Promise<void> {
  mock.reset();
  // Reset module caches by re-reading from the cleared storage.
  await storage.saveSettings(storage.sanitizeSettings({}));
}

beforeEach(resetState);

test('settings: v1 data is migrated to v2 and persisted', opts, async () => {
  mock.storage.local.data[STORAGE_KEYS.settings] = { schemaVersion: 1, enabled: true, allowlist: ['www.example.com', 'bad host!', 'news.org'], showBadge: false, customFilters: '||x.com^' };
  await storage.updateSettings({}); // clear cache path
  mock.storage.local.data[STORAGE_KEYS.settings] = { schemaVersion: 1, enabled: true, allowlist: ['www.example.com', 'bad host!', 'news.org'], showBadge: false, customFilters: '||x.com^' };
  const s = storage.sanitizeSettings(mock.storage.local.data[STORAGE_KEYS.settings]);
  assert.equal(s.schemaVersion, 2);
  assert.deepEqual(s.sites, { 'example.com': { protection: false }, 'news.org': { protection: false } });
  assert.equal(s.showBadge, false);
  assert.equal(s.customFilters, '||x.com^');
  assert.equal(s.privacy.stripTrackingParams, true);
  assert.equal(s.popupBlocking, true);
});

test('settings: hostile values are sanitized', opts, () => {
  const s = storage.sanitizeSettings({ enabled: 'yes', updateIntervalHours: 5, sites: { 'javascript:alert(1)': { protection: false }, 'ok.com': { protection: 'no', tracking: false } }, customFilters: 42 });
  assert.equal(s.enabled, true);
  assert.equal(s.updateIntervalHours, 0);
  assert.deepEqual(s.sites, { 'ok.com': { tracking: false } });
  assert.equal(s.customFilters, '');
});

test('settings persist through storage round trip', opts, async () => {
  await storage.updateSettings({ showBadge: false, sites: { 'a.com': { cosmetic: false } } });
  const raw = mock.storage.local.data[STORAGE_KEYS.settings] as Record<string, unknown>;
  const reread = storage.sanitizeSettings(structuredClone(raw));
  assert.equal(reread.showBadge, false);
  assert.deepEqual(reread.sites, { 'a.com': { cosmetic: false } });
});

test('list update: diff against the bundled ruleset is applied atomically', opts, async () => {
  mock.remote.set(EASYLIST, LIST_TEXT);
  const settings = await storage.getSettings();
  await lists.updateList('easylist', settings);
  const easylist = (await lists.getLists()).find((l) => l.id === 'easylist')!;
  assert.equal(easylist.lastError, undefined);
  assert.ok(easylist.lastSuccess);
  assert.equal(easylist.version, '2');
  // New rules are dynamic in the list slot; the whole bundled ruleset is obsolete (capped at 5000 disables).
  const { start, end } = slotRange(easylist.slot);
  const slotRules = mock.dynamicRules.filter((r) => r.id >= start && r.id <= end);
  assert.equal(slotRules.length, easylist.dynamicRuleCount);
  assert.ok(slotRules.length >= 2);
  assert.ok(slotRules.every((r) => (r as any).priority === PRIORITY.block));
  assert.ok((mock.disabledStatic.get('easylist')?.size ?? 0) > 0);
  const data = await storage.getListData('easylist');
  assert.deepEqual(data!.popup!.domains, ['popupnet.example']);
  assert.ok(data!.cosmetic.genericKeyed['.new-ad-class']);
});

test('list update: failed download keeps the previous rules', opts, async () => {
  mock.remote.set(EASYLIST, LIST_TEXT);
  const settings = await storage.getSettings();
  await lists.updateList('easylist', settings);
  const before = structuredClone(mock.dynamicRules);
  const beforeDisabled = [...(mock.disabledStatic.get('easylist') ?? [])];

  mock.remote.set(EASYLIST, new Error('network down'));
  await lists.updateList('easylist', settings);
  const after = (await lists.getLists()).find((l) => l.id === 'easylist')!;
  assert.match(after.lastError!, /network down/);
  assert.deepEqual(mock.dynamicRules, before);
  assert.deepEqual([...(mock.disabledStatic.get('easylist') ?? [])], beforeDisabled);
  assert.ok(await storage.getListData('easylist'), 'previous compiled data kept');
});

test('list update: HTML / captive-portal responses are rejected', opts, async () => {
  mock.remote.set(EASYLIST, '<!DOCTYPE html><html><body>Please log in to the Wi-Fi</body></html>'.padEnd(200));
  await lists.updateList('easylist', await storage.getSettings());
  const l = (await lists.getLists()).find((x) => x.id === 'easylist')!;
  assert.match(l.lastError!, /HTML/);
  assert.equal(mock.dynamicRules.length, 0);
  assert.equal(await storage.getListData('easylist'), null);
});

test('list update: a DNR failure leaves rules and data untouched', opts, async () => {
  mock.remote.set(EASYLIST, LIST_TEXT);
  mock.failNextDynamicUpdate = true;
  await lists.updateList('easylist', await storage.getSettings());
  const l = (await lists.getLists()).find((x) => x.id === 'easylist')!;
  assert.match(l.lastError!, /Simulated DNR failure/);
  assert.equal(mock.dynamicRules.length, 0);
  assert.equal(await storage.getListData('easylist'), null);
});

test('custom subscription: added on success, rejected (and not kept) on failure', opts, async () => {
  const url = 'https://lists.example/my.txt';
  mock.remote.set(url, LIST_TEXT);
  const added = await lists.addCustomList(url, await storage.getSettings());
  assert.equal(added.title, 'Test');
  assert.ok(added.dynamicRuleCount > 0);
  await assert.rejects(lists.addCustomList(url, await storage.getSettings()), /already added/);
  await assert.rejects(lists.addCustomList('https://lists.example/missing.txt', await storage.getSettings()), /Could not add list/);
  assert.equal((await lists.getLists()).filter((l) => l.custom).length, 1);
  await lists.removeCustomList(added.id);
  const { start, end } = slotRange(added.slot);
  assert.equal(mock.dynamicRules.filter((r) => r.id >= start && r.id <= end).length, 0);
});

test('applyState: global pause, site policies, pauses and privacy rulesets', opts, async () => {
  await engine.applyState('test');
  assert.ok(mock.enabledRulesets.has('easylist'));
  assert.ok(mock.enabledRulesets.has('anti-venom-strip-params'));
  assert.ok(mock.enabledRulesets.has('anti-venom-gpc'));
  assert.ok(!mock.enabledRulesets.has('anti-venom-beacons'));

  await engine.setSitePolicy('https://www.news.com/a', { tracking: false });
  assert.ok(mock.dynamicRules.some((r) => r.id === 11 && (r as any).condition.requestDomains.includes('news.com')));
  await engine.pauseSite('blog.org', 60);
  assert.ok(mock.sessionRules.some((r) => r.id === 12));
  await engine.resumeSite('blog.org');
  assert.ok(!mock.sessionRules.some((r) => r.id === 12));

  await engine.patchSettings({ trackingProtection: false });
  assert.ok(!mock.enabledRulesets.has('easyprivacy'));
  assert.ok(!mock.enabledRulesets.has('anti-venom-strip-params'));
  assert.ok(mock.enabledRulesets.has('anti-venom-gpc'), 'GPC is independent of tracking protection');

  await engine.setGlobalEnabled(false);
  assert.equal(mock.enabledRulesets.size, 0);
  assert.ok(mock.dynamicRules.some((r) => r.id === 1));
  await engine.setGlobalEnabled(true);
  assert.ok(!mock.dynamicRules.some((r) => r.id === 1));
});

test('custom filters survive loss of dynamic rules', opts, async () => {
  const res = await engine.setCustomFilters('||my-blocked.example^\nexample.com##.x\n||pop.example^$popup');
  assert.equal(res.networkRules, 1);
  assert.equal(res.popupFilters, 1);
  mock.dynamicRules = [];
  await engine.applyState('lost rules');
  assert.ok(mock.dynamicRules.some((r) => r.id >= 1000 && r.id < 100_000));
});

test('restore defaults clears exceptions, custom rules and subscriptions', opts, async () => {
  await engine.setSitePolicy('a.com', { protection: false });
  await engine.setCustomFilters('||x.example^');
  await engine.restoreDefaults();
  const s = await storage.getSettings();
  assert.deepEqual(s.sites, {});
  assert.equal(s.customFilters, '');
  assert.equal(mock.dynamicRules.length, 0);
});
