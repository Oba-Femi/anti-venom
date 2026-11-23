import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFilterList } from '../src/filters/compiler.ts';
import { CosmeticEngine, extractSelectorKey, splitSelectorList } from '../src/filters/cosmetic.ts';

test('selector keys come from top-level class/id tokens only', () => {
  assert.equal(extractSelectorKey('.ad-banner'), '.ad-banner');
  assert.equal(extractSelectorKey('#ad_box'), '#ad_box');
  assert.equal(extractSelectorKey('ins.adsbygoogle'), '.adsbygoogle');
  assert.equal(extractSelectorKey('div.wrapper > #sponsor'), '#sponsor');
  assert.equal(extractSelectorKey('div:not(.content)'), undefined);
  assert.equal(extractSelectorKey('[class^="ad-"]'), undefined);
  assert.equal(extractSelectorKey('a[href*=".com/ad"]'), undefined);
  assert.equal(extractSelectorKey('div:has(> .ad)'), undefined);
});

test('selector lists split on top-level commas only', () => {
  assert.deepEqual(splitSelectorList('.a, .b:not(.c, .d), [x="1,2"]'), ['.a', '.b:not(.c, .d)', '[x="1,2"]']);
});

const LIST = [
  '##.ad-banner',
  '##[id^="div-gpt-ad"]',
  '###sidebar-ad',
  'example.com##.promo',
  'example.com,~shop.example.com##.sponsored',
  'news.example.org#@#.ad-banner',
  '~nogeneric.com##.generic-but-not-here',
  'google.*##.g-ad',
  '@@||clean.com^$generichide',
  '@@||nothing.com^$elemhide',
  '##.globally-excepted',
  '#@#.globally-excepted',
].join('\n');

const engine = new CosmeticEngine([compileFilterList(LIST).cosmetic]);

test('specific and unkeyed generic CSS is returned per host', () => {
  const { css, generic } = engine.getFrameCosmetics('www.example.com');
  assert.ok(generic);
  assert.match(css, /^\.promo\{display:none!important\}$/m);
  assert.match(css, /^\.sponsored\{/m);
  assert.match(css, /^\[id\^="div-gpt-ad"\]\{/m);
  assert.doesNotMatch(css, /\.ad-banner/); // keyed generic: only on demand
});

test('~domain and #@# exceptions are honoured', () => {
  assert.doesNotMatch(engine.getFrameCosmetics('shop.example.com').css, /\.sponsored/);
  assert.equal(engine.getGenericCssForTokens('news.example.org', ['.ad-banner']), '');
  assert.match(engine.getGenericCssForTokens('other.org', ['.ad-banner']), /\.ad-banner\{/);
  assert.equal(engine.getGenericCssForTokens('nogeneric.com', ['.generic-but-not-here']), '');
  assert.equal(engine.getGenericCssForTokens('x.org', ['.globally-excepted']), '');
});

test('entity domains match across TLDs', () => {
  assert.match(engine.getFrameCosmetics('www.google.co.uk').css, /\.g-ad\{/);
  assert.doesNotMatch(engine.getFrameCosmetics('notgoogle.com').css, /\.g-ad/);
});

test('$generichide and $elemhide exceptions', () => {
  const clean = engine.getFrameCosmetics('clean.com');
  assert.equal(clean.generic, false);
  assert.doesNotMatch(clean.css, /div-gpt-ad/);
  assert.equal(engine.getGenericCssForTokens('clean.com', ['#sidebar-ad']), '');
  assert.deepEqual(engine.getFrameCosmetics('sub.nothing.com'), { css: '', generic: false });
});

test('token lookup returns only matching generic selectors', () => {
  const css = engine.getGenericCssForTokens('any.net', ['#sidebar-ad', '.unrelated']);
  assert.equal(css, '#sidebar-ad{display:none!important}\n');
});
