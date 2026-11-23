import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PopupMatcher, compilePopupFilters, patternToRegExp, siteOf } from '../src/filters/matcher.ts';
import { compileFilterList, detectFormat } from '../src/filters/compiler.ts';
import { parseLine } from '../src/filters/parser.ts';
import { stripParamsRules, gpcRules, beaconRules, TRACKING_PARAMS } from '../src/filters/privacy-rules.ts';
import { PRIORITY } from '../src/filters/dnr-types.ts';
import { Classifier, hostsFromRules } from '../src/filters/classify.ts';

test('ABP pattern → RegExp', () => {
  const re = patternToRegExp('||ads.example^');
  assert.ok(re.test('https://ads.example/x'));
  assert.ok(re.test('https://sub.ads.example'));
  assert.ok(!re.test('https://ads.example.com/'));
  assert.ok(!re.test('https://badads.example/'));
  assert.ok(patternToRegExp('/popunder/*.php').test('https://x.com/popunder/go.php?a=1'));
  assert.ok(patternToRegExp('|https://exact.com/|').test('https://exact.com/'));
  assert.ok(!patternToRegExp('|https://exact.com/|').test('https://exact.com/x'));
});

test('registrable domain approximation', () => {
  assert.equal(siteOf('a.b.example.com'), 'example.com');
  assert.equal(siteOf('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteOf('192.168.0.1'), '192.168.0.1');
});

test('$popup filters are routed to the pop-up blocker', () => {
  const r = parseLine('||popads.example^$popup');
  assert.equal(r.kind, 'popup');
  const { popup, rules } = compileFilterList('||popads.example^$popup\n/popunder/*$popup,domain=news.com\n@@||popads.example/ok$popup');
  assert.equal(rules.length, 0);
  assert.deepEqual(popup.domains, ['popads.example']);
  assert.equal(popup.rules.length, 1);
  assert.equal(popup.exceptions.length, 1);
});

test('pop-up matcher: blocks listed third-party destinations only', () => {
  const m = new PopupMatcher([compilePopupFilters([
    ...['||popads.example^$popup', '/popunder/*$popup,domain=news.com', '@@||popads.example/ok$popup'].map((l) => {
      const r = parseLine(l);
      if (r.kind !== 'popup') throw new Error(l);
      return r.filter;
    }),
  ])]);
  assert.ok(m.shouldBlock('https://popads.example/land', 'news.com'));
  assert.ok(m.shouldBlock('https://x.popads.example/land', 'blog.org'));
  assert.ok(!m.shouldBlock('https://popads.example/ok/1', 'news.com'), 'exception');
  assert.ok(m.shouldBlock('https://cdn.other/popunder/a', 'news.com'));
  assert.ok(!m.shouldBlock('https://cdn.other/popunder/a', 'blog.org'), 'domain= restricts opener');
  assert.ok(!m.shouldBlock('https://accounts.example.com/login', 'www.example.com'), 'same-site pop-ups are never blocked');
  assert.ok(!m.shouldBlock('about:blank', 'news.com'));
});

test('domain-list format: bare hostnames become whole-domain blocks', () => {
  const text = '# Title: test\n# Expires: 12 hours\nbad.example\nworse.example # comment\nthird.example\nfourth.example\nnot a host line\n';
  assert.equal(detectFormat(text), 'domains');
  assert.equal(detectFormat('[Adblock Plus 2.0]\nbad.example\n'), 'abp');
  const { rules } = compileFilterList(text, { format: 'domains', profile: 'security' });
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]!.condition.requestDomains, ['bad.example', 'fourth.example', 'third.example', 'worse.example']);
  assert.ok(rules[0]!.condition.resourceTypes!.includes('main_frame'));
  assert.equal(rules[0]!.priority, PRIORITY.security);
});

test('privacy profile lowers block priority below the site-tracking tier', () => {
  const { rules } = compileFilterList('||t.example^\n@@||t.example/ok', { profile: 'privacy' });
  const block = rules.find((r) => r.action.type === 'block')!;
  const allow = rules.find((r) => r.action.type === 'allow')!;
  assert.equal(block.priority, PRIORITY.privacyBlock);
  assert.equal(allow.priority, PRIORITY.exception);
});

test('tracking-parameter rules: fire only when a tracking parameter is present', () => {
  const rules = stripParamsRules();
  assert.ok(rules.length > 1, 'split to stay within Chrome regex memory limits');
  const res = rules.map((r) => new RegExp(r.condition.regexFilter!));
  const anyMatch = (u: string) => res.some((re) => re.test(u));
  assert.ok(anyMatch('https://shop.example/item?id=3&utm_source=news'));
  assert.ok(anyMatch('https://shop.example/?fbclid=abc'));
  assert.ok(anyMatch('https://shop.example/?ml_subscriber_hash=1'), 'last parameter covered');
  assert.ok(!anyMatch('https://shop.example/item?id=3&keep=1'), 'no redirect loop: clean URLs do not match');
  assert.ok(!anyMatch('https://shop.example/?xutm_source=1'));
  for (const r of rules) {
    assert.ok(r.condition.regexFilter!.length < 200, 'small regexes');
    assert.deepEqual(r.action.redirect!.transform!.queryTransform!.removeParams, [...TRACKING_PARAMS]);
    assert.deepEqual(r.condition.resourceTypes, ['main_frame', 'sub_frame']);
    assert.equal(r.priority, PRIORITY.privacyBlock);
  }
  assert.deepEqual(rules.map((r) => r.id), rules.map((_, i) => i + 1));
  assert.ok(!TRACKING_PARAMS.includes('ref') && !TRACKING_PARAMS.includes('q'), 'functional parameters are kept');
});

test('GPC and beacon rules', () => {
  const [gpc] = gpcRules();
  assert.equal(gpc!.action.type, 'modifyHeaders');
  assert.deepEqual(gpc!.action.requestHeaders![0], { header: 'Sec-GPC', operation: 'set', value: '1' });
  const [beacon] = beaconRules();
  assert.equal(beacon!.condition.domainType, 'thirdParty');
  assert.deepEqual(beacon!.condition.resourceTypes, ['ping']);
});

test('classifier: host index first, heuristics second', () => {
  const adRules = compileFilterList('||adnet.example^\n||cdn.example/ads/^').rules;
  const c = new Classifier({ ads: [...hostsFromRules(adRules)], trackers: ['metrics.example'], malicious: ['adnet.example'] });
  assert.equal(c.classify('https://x.adnet.example/a.js', 'script'), 'malicious', 'precedence: malicious > ads');
  assert.equal(c.classify('https://cdn.example/ads/1.js', 'script'), 'ads');
  assert.equal(c.classify('https://metrics.example/c', 'xmlhttprequest'), 'trackers');
  assert.equal(c.classify('https://unknown.example/collect?v=1', 'xmlhttprequest'), 'trackers');
  assert.equal(c.classify('https://unknown.example/b.js', 'ping'), 'trackers');
  assert.equal(c.classify('https://unknown.example/banner.js', 'script'), 'ads');
});
