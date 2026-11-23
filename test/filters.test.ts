import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, CosmeticFlag } from '../src/filters/parser.ts';
import { convertNetworkFilter, collapseSubdomains, isLikelyRe2Compatible } from '../src/filters/network.ts';
import { compileFilterList } from '../src/filters/compiler.ts';
import { PRIORITY, type DnrRule } from '../src/filters/dnr-types.ts';
import { hostLookupKeys, hostMatches, normalizeSiteInput, toASCIIHost } from '../src/filters/domains.ts';
import { looksLikeFilterList, parseExpires } from '../src/filters/validate.ts';

function convert(line: string) {
  const r = parseLine(line);
  assert.equal(r.kind, 'network', `expected network filter for ${line}, got ${r.kind}`);
  if (r.kind !== 'network') throw new Error('unreachable');
  return convertNetworkFilter(r.filter);
}

function rule(line: string): Omit<DnrRule, 'id'> {
  const res = convert(line);
  assert.ok(res.ok, `conversion failed for ${line}: ${!res.ok ? res.reason : ''}`);
  if (!res.ok) throw new Error('unreachable');
  return res.rule;
}

test('comments, headers and blank lines are ignored', () => {
  for (const l of ['', '   ', '! comment', '[Adblock Plus 2.0]', '# hosts comment']) {
    assert.equal(parseLine(l).kind, 'comment');
  }
});

test('pure hostname filters become requestDomains', () => {
  const r = rule('||ads.example.com^');
  assert.deepEqual(r.condition, { requestDomains: ['ads.example.com'] });
  assert.equal(r.action.type, 'block');
  assert.equal(r.priority, PRIORITY.block);
});

test('hostname without separator stays a urlFilter (could match ads.example.community)', () => {
  assert.equal(rule('||ads.example.com').condition.urlFilter, '||ads.example.com');
});

test('options map to DNR conditions', () => {
  const r = rule('||tracker.net/pixel$image,script,third-party,domain=a.com|~b.a.com');
  assert.equal(r.condition.urlFilter, '||tracker.net/pixel');
  assert.deepEqual(r.condition.resourceTypes, ['image', 'script']);
  assert.equal(r.condition.domainType, 'thirdParty');
  assert.deepEqual(r.condition.initiatorDomains, ['a.com']);
  assert.deepEqual(r.condition.excludedInitiatorDomains, ['b.a.com']);
});

test('negated types and first-party', () => {
  const r = rule('/banner/ad-$~image,~third-party');
  assert.deepEqual(r.condition.excludedResourceTypes, ['image']);
  assert.equal(r.condition.domainType, 'firstParty');
});

test('path filters with options are not mistaken for regex', () => {
  const r = rule('/ad/img/*$image,domain=~eki-net.com|~jiji.com');
  assert.equal(r.condition.urlFilter, '/ad/img/');
  assert.deepEqual(r.condition.excludedInitiatorDomains, ['eki-net.com', 'jiji.com']);
});

test('exceptions and $important priorities', () => {
  const allow = rule('@@||example.com/ads.js$script');
  assert.equal(allow.action.type, 'allow');
  assert.equal(allow.priority, PRIORITY.exception);
  const important = rule('||evil.com^$important');
  assert.equal(important.priority, PRIORITY.important);
  assert.ok(PRIORITY.important > PRIORITY.exception && PRIORITY.exception > PRIORITY.block);
  assert.ok(PRIORITY.block > PRIORITY.siteTrackingAllow && PRIORITY.siteTrackingAllow > PRIORITY.privacyBlock);
  assert.ok(PRIORITY.security > PRIORITY.important && PRIORITY.userAllowlist > PRIORITY.security);
});

test('$document exception becomes allowAllRequests on frames and disables cosmetics', () => {
  const r = parseLine('@@||example.com^$document');
  assert.equal(r.kind, 'network');
  if (r.kind !== 'network') return;
  assert.equal(r.filter.cosmeticFlags & CosmeticFlag.ELEMHIDE, CosmeticFlag.ELEMHIDE);
  const c = convertNetworkFilter(r.filter);
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.equal(c.rule.action.type, 'allowAllRequests');
  assert.deepEqual(c.rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
});

test('unsupported features are skipped rather than approximated', () => {
  const skips: Record<string, string> = {
    '||example.com^$webrtc': 'unsupported-type-only',
    '||example.com^$csp=script-src none': 'option:csp',
    '||example.com^$redirect=noopjs': 'option:redirect',
    '||example.com^$document': 'document-block',
    '||example.com^$domain=~google.*': 'domain-option',
    '||example.com^$domain=google.*': 'domain-option',
    'example.com#$#abort-on-property-read foo': 'snippet/css-injection',
    'example.com##+js(nowebrtc)': 'scriptlet/html-filter',
    'example.com#?#div:has-text(Sponsored)': 'procedural-cosmetic',
    'example.com##.x {color:red}': 'unsafe-selector',
  };
  for (const [line, reason] of Object.entries(skips)) {
    const r = parseLine(line);
    assert.equal(r.kind, 'skip', line);
    if (r.kind === 'skip') assert.equal(r.reason, reason, line);
  }
});

test('patterns with inner pipes or too short are rejected', () => {
  assert.deepEqual(convert('/addyn|*;adtech;'), { ok: false, reason: 'inner-pipe' });
  assert.deepEqual(convert('ad'), { ok: false, reason: 'pattern-too-short' });
});

test('regex filters', () => {
  const r = rule('/^https?:\\/\\/ads\\d+\\.example\\.com\\//$script');
  assert.equal(r.condition.regexFilter, '^https?:\\/\\/ads\\d+\\.example\\.com\\/');
  assert.equal(isLikelyRe2Compatible('foo(?=bar)'), false);
  assert.equal(isLikelyRe2Compatible('(a)\\1'), false);
  assert.equal(convert('/foo(?!bar)/').ok, false);
});

test('hosts-file lines are converted', () => {
  const r = parseLine('0.0.0.0 tracker.example.org');
  assert.equal(r.kind, 'network');
  assert.equal(parseLine('127.0.0.1 localhost').kind, 'comment');
});

test('cosmetic filter domains', () => {
  const r = parseLine('example.com,~sub.example.com,google.*##.ad-box');
  assert.equal(r.kind, 'cosmetic');
  if (r.kind !== 'cosmetic') return;
  assert.deepEqual(r.filter.include, ['example.com', 'google.*']);
  assert.deepEqual(r.filter.exclude, ['sub.example.com']);
  assert.equal(r.filter.selector, '.ad-box');
});

test('-abp-has is converted to native :has', () => {
  const r = parseLine('example.com#?#div:-abp-has(> .sponsored)');
  assert.equal(r.kind, 'cosmetic');
  if (r.kind === 'cosmetic') assert.equal(r.filter.selector, 'div:has(> .sponsored)');
});

test('optimizer merges hostname rules and collapses subdomains', () => {
  const list = ['||a.com^', '||b.com^', '||x.b.com^', '||c.com^$third-party', '||a.com^'].join('\n');
  const { rules } = compileFilterList(list);
  assert.equal(rules.length, 2);
  const merged = rules.find((r) => !r.condition.domainType)!;
  assert.deepEqual(merged.condition.requestDomains, ['a.com', 'b.com']);
  assert.deepEqual(collapseSubdomains(['a.b.c.com', 'c.com', 'd.com']), ['c.com', 'd.com']);
});

test('$badfilter disables a matching filter', () => {
  const { rules, stats } = compileFilterList('||ads.example.com^$script\n||ads.example.com^$script,badfilter\n||other.com^');
  assert.equal(stats.badfiltered, 1);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]!.condition.requestDomains, ['other.com']);
});

test('rule ids are sequential from startId and quotas are respected', () => {
  const text = Array.from({ length: 50 }, (_, i) => `/path${i}/ad$script`).join('\n');
  const { rules, stats } = compileFilterList(text, { startId: 1000, maxRules: 10 });
  assert.equal(rules.length, 10);
  assert.equal(rules[0]!.id, 1000);
  assert.equal(rules[9]!.id, 1009);
  assert.equal(stats.droppedForQuota, 40);
});

test('compiled output is deterministic', () => {
  const text = '||b.com^\n||a.com^\n/ads/*$image\n@@||a.com/ok$script';
  assert.deepEqual(compileFilterList(text).rules, compileFilterList(text.split('\n').reverse().join('\n')).rules);
});

test('domain helpers', () => {
  assert.equal(toASCIIHost('Bücher.example'), 'xn--bcher-kva.example');
  assert.equal(toASCIIHost('not a host'), null);
  assert.ok(hostMatches('www.example.com', 'example.com'));
  assert.ok(!hostMatches('badexample.com', 'example.com'));
  assert.equal(normalizeSiteInput('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(normalizeSiteInput('sub.example.com:8080/x'), 'sub.example.com');
  assert.equal(normalizeSiteInput('javascript:alert(1)'), null);
  assert.deepEqual(hostLookupKeys('a.example.co.uk').slice(0, 3), ['a.example.co.uk', 'a.example.co.*', 'a.example.*']);
  assert.ok(hostLookupKeys('www.google.co.uk').includes('google.*'));
});

test('list validation rejects HTML and empty responses', () => {
  assert.equal(looksLikeFilterList('<!DOCTYPE html><html>captive portal</html>'.padEnd(100)).ok, false);
  assert.equal(looksLikeFilterList('').ok, false);
  assert.equal(looksLikeFilterList('[Adblock Plus 2.0]\n||a.com^\n||b.com^\n||c.com^\n||d.com^\n||e.com^\n').ok, true);
  assert.equal(parseExpires('! Expires: 4 days (update frequency)', 1), 4 * 86_400_000);
  assert.equal(parseExpires('! nothing', 123), 123);
});
