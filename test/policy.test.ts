import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPauseRules, buildSiteRules, isProtectionOff, normalizeSites, resolveSitePolicy, SITE_RULE_IDS,
} from '../src/shared/site-policy.ts';
import { compileFilterList } from '../src/filters/compiler.ts';
import { PRIORITY, type DnrRule } from '../src/filters/dnr-types.ts';
import { hostMatches } from '../src/filters/domains.ts';
import { isThirdParty } from '../src/filters/matcher.ts';

// --- Policy resolution ---------------------------------------------------------

test('site policy: subdomains inherit, most specific entry wins per field', () => {
  const sites = { 'example.com': { protection: false }, 'shop.example.com': { protection: true, tracking: false } };
  assert.equal(resolveSitePolicy(sites, 'www.example.com').protection, false);
  assert.equal(resolveSitePolicy(sites, 'www.example.com').protectionSource, 'example.com');
  const shop = resolveSitePolicy(sites, 'eu.shop.example.com');
  assert.equal(shop.protection, true);
  assert.equal(shop.tracking, false);
  assert.equal(shop.cosmetic, true);
  assert.deepEqual(resolveSitePolicy(sites, 'other.org'), { protection: true, tracking: true, cosmetic: true });
  assert.equal(resolveSitePolicy(sites, 'notexample.com').protection, true);
});

test('temporary pauses apply until they expire', () => {
  const now = 1_000_000;
  const paused = resolveSitePolicy({}, 'a.news.com', { 'news.com': now + 60_000 }, now);
  assert.equal(paused.pausedUntil, now + 60_000);
  assert.ok(isProtectionOff(paused, now));
  const expired = resolveSitePolicy({}, 'news.com', { 'news.com': now - 1 }, now);
  assert.equal(expired.pausedUntil, undefined);
  assert.ok(!isProtectionOff(expired, now));
});

test('normalizeSites drops redundant overrides', () => {
  assert.deepEqual(normalizeSites({ 'a.com': { protection: true, tracking: true } }), {});
  assert.deepEqual(normalizeSites({ 'a.com': { protection: false }, 'b.a.com': { protection: false } }), { 'a.com': { protection: false } });
  assert.deepEqual(normalizeSites({ 'a.com': { protection: false }, 'b.a.com': { protection: true } }), { 'a.com': { protection: false }, 'b.a.com': { protection: true } });
});

test('site rules: protection-off and tracking-off tiers with re-enabled subdomains excluded', () => {
  const rules = buildSiteRules({ 'example.com': { protection: false }, 'shop.example.com': { protection: true }, 'bank.com': { tracking: false } });
  const off = rules.find((r) => r.id === SITE_RULE_IDS.protectionOff)!;
  assert.equal(off.priority, PRIORITY.userAllowlist);
  assert.equal(off.action.type, 'allowAllRequests');
  assert.deepEqual(off.condition.requestDomains, ['example.com']);
  assert.deepEqual(off.condition.excludedRequestDomains, ['shop.example.com']);
  assert.deepEqual(off.condition.resourceTypes, ['main_frame']);
  const tracking = rules.find((r) => r.id === SITE_RULE_IDS.trackingOff)!;
  assert.equal(tracking.priority, PRIORITY.siteTrackingAllow);
  assert.deepEqual(tracking.condition.requestDomains, ['bank.com']);
  assert.deepEqual(buildSiteRules({}), []);
});

test('pause rules only include active pauses', () => {
  const now = 10_000;
  const rules = buildPauseRules({ 'a.com': now + 1, 'b.com': now - 1 }, now);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]!.condition.requestDomains, ['a.com']);
  assert.deepEqual(buildPauseRules({}, now), []);
});

// --- Rule prioritisation (simulated DNR evaluation) ---------------------------------

interface Req {
  url: string;
  type: string;
  /** Top-level document host (for allowAllRequests) and initiator. */
  top: string;
}

type AnyRule = Omit<DnrRule, 'id'> & { id?: number };

function matches(rule: AnyRule, req: Req): boolean {
  const c = rule.condition;
  const host = new URL(req.url).hostname;
  // allowAllRequests applies to everything in the tab whose top document matches.
  if (rule.action.type === 'allowAllRequests') {
    const ok = c.requestDomains?.some((d) => hostMatches(req.top, d)) ?? true;
    const excluded = c.excludedRequestDomains?.some((d) => hostMatches(req.top, d)) ?? false;
    return ok && !excluded;
  }
  if (c.resourceTypes && !c.resourceTypes.includes(req.type as never)) return false;
  if (!c.resourceTypes && req.type === 'main_frame') return false;
  if (c.requestDomains && !c.requestDomains.some((d) => hostMatches(host, d))) return false;
  if (c.initiatorDomains && !c.initiatorDomains.some((d) => hostMatches(req.top, d))) return false;
  if (c.excludedInitiatorDomains?.some((d) => hostMatches(req.top, d))) return false;
  if (c.domainType === 'thirdParty' && !isThirdParty(host, req.top)) return false;
  if (c.domainType === 'firstParty' && isThirdParty(host, req.top)) return false;
  if (c.urlFilter) {
    const needle = c.urlFilter.replace(/^\|\|/, '').replace(/\^$/, '');
    if (!req.url.includes(needle)) return false;
  }
  return true;
}

const ACTION_RANK: Record<string, number> = { allow: 3, allowAllRequests: 2, block: 1 };

/** Chrome's algorithm: highest priority wins; ties broken allow > allowAllRequests > block. */
function evaluate(rules: AnyRule[], req: Req): 'blocked' | 'allowed' {
  const hit = rules.filter((r) => matches(r, req)).sort((a, b) => b.priority - a.priority || ACTION_RANK[b.action.type]! - ACTION_RANK[a.action.type]!)[0];
  return hit?.action.type === 'block' ? 'blocked' : 'allowed';
}

const ads = compileFilterList('||adnet.example^\n||cdn.example/ads/*$script\n@@||cdn.example/ads/needed.js$script\n||must-block.example^$important\n@@||must-block.example^').rules;
const trackers = compileFilterList('||tracker.example^$third-party', { profile: 'privacy' }).rules;
const security = compileFilterList('malware.example', { profile: 'security', format: 'domains' }).rules;
const all: AnyRule[] = [...ads, ...trackers, ...security];

const req = (url: string, top = 'news.com', type = 'script'): Req => ({ url, top, type });

test('priorities: exceptions beat blocks, $important beats exceptions', () => {
  assert.equal(evaluate(all, req('https://adnet.example/x.js')), 'blocked');
  assert.equal(evaluate(all, req('https://cdn.example/ads/banner.js')), 'blocked');
  assert.equal(evaluate(all, req('https://cdn.example/ads/needed.js')), 'allowed');
  assert.equal(evaluate(all, req('https://must-block.example/x.js')), 'blocked');
});

test('priorities: malicious domains are blocked even as top-level navigations', () => {
  assert.equal(evaluate(all, req('https://malware.example/', 'malware.example', 'main_frame')), 'blocked');
  assert.equal(evaluate(all, req('https://adnet.example/', 'adnet.example', 'main_frame')), 'allowed');
});

test('priorities: per-site tracking off allows trackers but keeps ads blocked', () => {
  const site = buildSiteRules({ 'news.com': { tracking: false } });
  const rules = [...all, ...site];
  assert.equal(evaluate(all, req('https://tracker.example/t.js')), 'blocked');
  assert.equal(evaluate(rules, req('https://tracker.example/t.js')), 'allowed');
  assert.equal(evaluate(rules, req('https://adnet.example/x.js')), 'blocked');
  assert.equal(evaluate(rules, req('https://tracker.example/t.js', 'other.com')), 'blocked');
});

test('priorities: site protection off and pauses override everything, including malware', () => {
  const off = [...all, ...buildSiteRules({ 'news.com': { protection: false } })];
  for (const url of ['https://adnet.example/x.js', 'https://tracker.example/t.js', 'https://must-block.example/x.js', 'https://malware.example/x.js']) {
    assert.equal(evaluate(off, req(url)), 'allowed', url);
  }
  const paused = [...all, ...buildPauseRules({ 'news.com': Date.now() + 60_000 })];
  assert.equal(evaluate(paused, req('https://adnet.example/x.js')), 'allowed');
  assert.equal(evaluate(paused, req('https://adnet.example/x.js', 'other.com')), 'blocked');
});

test('priorities: re-enabled subdomain keeps blocking under a disabled parent', () => {
  const rules = [...all, ...buildSiteRules({ 'news.com': { protection: false }, 'live.news.com': { protection: true } })];
  assert.equal(evaluate(rules, req('https://adnet.example/x.js', 'www.news.com')), 'allowed');
  assert.equal(evaluate(rules, req('https://adnet.example/x.js', 'live.news.com')), 'blocked');
});

test('first-party requests are not hit by third-party rules', () => {
  assert.equal(evaluate(all, req('https://tracker.example/t.js', 'tracker.example')), 'allowed');
  assert.equal(evaluate(all, req('https://tracker.example/t.js', 'www.tracker.example')), 'allowed');
});
