import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRegexCost, MAX_REGEX_COST } from '../src/filters/network.ts';
import { stripParamsRules } from '../src/filters/privacy-rules.ts';

// Ground truth: chrome.declarativeNetRequest.isRegexSupported() results from
// Chrome 157 for the regex filters in EasyList / EasyPrivacy (2026-11 snapshot).
const REJECTED = [
  String.raw`(https?:\/\/)104\.154\..{100,}`,
  String.raw`(https?:\/\/)142\.91\.159\..{100,}`,
  String.raw`(https?:\/\/)\w{30,}\.me\/\w{30,}\.`,
  String.raw`^https?:\/\/.*\.(club|bid|biz|xyz|site|pro|info|online|icu|monster|buzz|website|biz|re|casa|top|one|space|network|live|systems|ml|world|life|co)\/.*`,
  String.raw`^https?:\/\/.*\/[a-z0-9A-Z_]{2,15}\.(php|jx|jsx|1ph|jsf|jz|jsm|j$)`,
  String.raw`^https?:\/\/s3\.*\.amazonaws\.com\/[a-f0-9]{45,}\/[a-f,0-9]{8,10}$`,
  String.raw`^https:\/\/cdn\.jsdelivr\.net\/npm\/[-a-z_]{4,22}@latest\/dist\/script\.min\.js$`,
];
const ACCEPTED = [
  String.raw`\.gsmarena\.com\/[0-9]+\.[a-z]+\?s?Search=`,
  String.raw`\/[0-9a-f]{32}\/invoke\.js`,
  String.raw`^https?:\/\/.*\/.*sw[0-9._].*`,
  String.raw`^https?:\/\/[a-z]{10,}\.(cfd|click|cyou|online|pro|qpon|rest|shop|site|space|store|top|website|xyz)\/\d{6,}\/\d{6,}\/[a-z]$`,
  String.raw`^https?:\/\/www\.[0-9a-z]{8,}\.com\/[0-9a-z]{1,4}\.js$`,
  String.raw`^https?:\/\/fdts\.ebay-kleinanzeigen\.de\/[a-z0-9]{13,18}\.js\?`,
  String.raw`^https?:\/\/pov\.spectrum\.net\/[a-zA-Z0-9]{14,}\.js`,
  String.raw`^https?:\/\/tjmaxx\.tjx\.com\/libraries\/[a-z0-9]{20,}`,
  String.raw`^https?:\/\/tmx\.(td|tdbank)\.com\/[a-z0-9]{14,18}\.js.*`,
  String.raw`^https?:\/\/www\.ebay-kleinanzeigen\.de\/[a-z0-9]{8}\-[0-9a-f]{4}\-`,
  String.raw`^https?:\/\/www\.kroger\.com\/content\/{20,}`,
];

test('regex cost estimate separates regexes Chrome rejects from ones it accepts', () => {
  for (const r of REJECTED) assert.ok(estimateRegexCost(r) > MAX_REGEX_COST, `should reject (${estimateRegexCost(r)}): ${r}`);
  for (const r of ACCEPTED) assert.ok(estimateRegexCost(r) <= MAX_REGEX_COST, `should accept (${estimateRegexCost(r)}): ${r}`);
});

test('built-in tracking-parameter regexes stay under the budget', () => {
  for (const r of stripParamsRules()) assert.ok(estimateRegexCost(r.condition.regexFilter!) <= MAX_REGEX_COST);
});
