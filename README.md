# Anti-Venom Ad Blocker

A privacy-first Manifest V3 content blocker for Chrome and other Chromium browsers. It blocks ads, trackers,
fingerprinting scripts, pop-ups and malicious domains with **Declarative Net Request**. The rules come from
maintained filter lists (EasyList, EasyPrivacy, URLhaus), and you get per-website controls, a local statistics
dashboard, and a filter-list management center.

## Quick start

Requirements: Node.js ≥ 22.18 (runs the TypeScript build scripts natively) and Chrome ≥ 121.

```powershell
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Pin Anti-Venom from the puzzle-piece menu. The popup holds the quick controls; the dashboard and settings open
   from its icons.

After code changes, run `npm run build` and click the reload icon on Anti-Venom's card. `npm run watch` rebuilds
TypeScript on save (development build with sourcemaps and debug logging).

| Command | Purpose |
| --- | --- |
| `npm run build` / `build:dev` / `watch` | Build `dist/` (production / development / watch) |
| `npm run filters:fetch` | Refresh the EasyList, EasyPrivacy and URLhaus snapshots in `filters/raw/` |
| `npm run typecheck` | Type-check the extension code |
| `npm test` | Unit tests (`node:test`, 64 tests; the background tests read `dist/`, so build first) |
| `npm run test:e2e` | End-to-end test in a real browser (≈100 checks, see below) |
| `npm run check` | Typecheck + unit tests + build |
| `node test/e2e/screenshots.ts` | UI screenshots (light/dark) into `screenshots/` |

## Features

### Blocking engine
- **Filter-list subscriptions**: EasyList (ads), EasyPrivacy (trackers and telemetry), Anti-Venom Fingerprinting
  Protection and URLhaus malicious domains are built in. Peter Lowe's list, uBlock filters and Fanboy's Annoyance
  are offered on demand, and you can subscribe to any list by URL, in ABP syntax or as a plain domain list.
- **Static rulesets with runtime diff updates.** Built-in lists are compiled at build time; runtime refreshes
  apply only the difference (new rules become dynamic rules, removed rules are disabled), so a refresh costs a
  handful of rules. Updates run automatically on a configurable schedule (each list's `Expires` header,
  6–168 h).
- **Safe updates.** Downloads are validated (size, HTML/captive-portal detection, rule count), compiled, and
  installed with a single atomic `updateDynamicRules` call. A failed download, a bad list, or a DNR error never
  removes working rules. This is covered by unit tests.
- **Category-tiered priorities** that resolve conflicts the way ABP does and make per-site controls possible:

  | Tier | Priority |
  | --- | --- |
  | Privacy-list blocks | 10 |
  | Per-site "tracking off" | 20 |
  | Ad blocks | 30 |
  | Exceptions (`@@`) | 40 |
  | `$important` | 50 |
  | Malicious domains | 60 |
  | User "protection off" / pause | 1,000,000 |
  | Global pause | 2,000,000 |

- **Pop-up blocking.** `$popup` filters (≈2,900 in EasyList) are enforced by closing ad tabs opened by a page,
  including about:blank → redirect pop-unders. Pop-ups to the same site (sign-in, print) are never closed.
- **Quota-aware rule allocation.** Hostname filters are merged into `requestDomains` rules (≈105k filters
  become ≈13k rules). Runtime lists share a budgeted 30k dynamic-rule pool with 6k reserved for user rules;
  regexes are checked against Chrome's RE2 memory limit at build time (a calibrated estimate) and with
  `isRegexSupported` at runtime.
- **Custom rules** in ABP syntax: network, hiding and pop-up rules, with unsupported syntax reported.

### Privacy protection
Tracker blocking (EasyPrivacy), fingerprinting-script blocking, tracking-parameter stripping (`fbclid`, `gclid`,
`msclkid`, `utm_*` and ≈60 others, via DNR redirect), Global Privacy Control (`Sec-GPC` header plus
`navigator.globalPrivacyControl`), optional third-party beacon blocking, and malicious-domain blocking.

Every feature can be configured, and every privacy feature can be switched off per site. Login, payment and
CAPTCHA providers (Stripe, PayPal, Google/Apple sign-in, reCAPTCHA, Turnstile) are checked by the e2e suite
and are not blocked.

### Website control center
For any site you can turn off all blocking, tracking protection only, or placeholder hiding only. You can also
pause for an hour or until the browser restarts (session rules), see what was blocked on the current page by
category and domain, and manage exceptions in bulk from the dashboard. Rules apply to subdomains, and a more
specific rule wins, so `shop.example.com` can re-enable what `example.com` disabled.

### Dashboard and statistics
Ads and trackers blocked, blocked today, total, a 30-day activity chart (with a table view), the websites with
the most blocks, enabled lists, and overall protection status. All counting is local. Only counts and hostnames
are stored, never URLs, and per-website counts can be switched off and cleared.

### Interface
A quick, simple popup and a full app (Dashboard, Websites, Filter lists, Privacy, Custom rules, Settings,
About). It has light, dark and system themes, responsive layouts, keyboard-accessible switches with ARIA roles,
tooltips, status pills that always pair colour with text, and respects reduced motion.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `declarativeNetRequest` | Blocks/redirects requests from filter-list rules inside the browser; Anti-Venom never sees request contents. |
| Host access `<all_urls>` | Insert hiding CSS, count blocked requests, and apply redirect/header rules (tracking parameters, GPC), which require host access. |
| `webRequest` | Observes failed requests to count blocks (read-only, non-blocking). |
| `webNavigation` | Detects tabs opened by a page so pop-up ads can be closed. |
| `scripting` | `insertCSS` for element hiding; registers the bundled GPC page script. |
| `storage`, `unlimitedStorage` | Settings, statistics and compiled filter lists on this device (lists can exceed the 10 MB default). |
| `alarms` | Filter-list update schedule and the end of temporary pauses. |

Anti-Venom does not request `tabs`, `cookies`, `history`, `privacy`, `declarativeNetRequestFeedback` or any
remote-code capability.

## Security and privacy model

- No telemetry, analytics, accounts or remote logging. The only network traffic is list downloads from the
  publishers' URLs (`credentials: 'omit'`, no referrer).
- Downloaded lists are **data only**: they are validated, parsed and converted into DNR rules and CSS
  selectors. Scriptlets (`##+js`) and other code-carrying filter types are skipped, and Anti-Venom never executes
  downloaded JavaScript. Extension pages use the CSP `script-src 'self'`.
- Cosmetic selectors are checked for CSS injection (`{`, `}`, comments, `</style>`) and injected as user-origin
  CSS. Content-script messages are restricted to cosmetic requests and validated; privileged messages are only
  accepted from extension pages.
- Stored data is sanitised on every read (schema-versioned, with migrations). User input such as hostnames,
  URLs and rules is normalised and validated before use. UI text is always inserted as text, never as HTML.
- Statistics live in `chrome.storage.local`, while per-tab details and pauses live in `chrome.storage.session`
  and are cleared when the browser closes. The theme preference is in the extension's `localStorage`.

## Architecture

```
src/
  shared/      types & settings schema, typed message protocol, constants, list catalog,
               site-policy.ts (per-site resolution + DNR rules), stats-model.ts, logger
  filters/     platform-neutral engine (Node at build time + service worker at runtime)
    parser.ts        ABP/uBO/AdGuard-compatible line parser, domain-list format
    network.ts       filter → DNR conversion, priority profiles, merging, RE2 cost estimate
    cosmetic.ts      cosmetic compiler + CosmeticEngine
    matcher.ts       ABP pattern matcher + PopupMatcher, first/third-party helpers
    privacy-rules.ts built-in privacy feature rulesets (params, GPC, beacons)
    classify.ts      blocked-request categorisation for statistics
    compiler.ts, domains.ts, validate.ts
  background/  service worker
    index.ts (event wiring) · engine.ts (orchestration) · rules.ts (only DNR caller)
    lists.ts (subscriptions, diff updates, budgets) · privacy.ts · popups.ts
    cosmetic-service.ts · assets.ts · stats.ts · storage.ts · policy.ts · messaging.ts · diagnostics.ts
  content/     cosmetic.ts (document_start token reporter) · gpc.ts (MAIN-world GPC signal)
  popup/       popup.ts
  app/         dashboard/settings app: main.ts (router), views/*, chart.ts
  ui/          dom helpers, theme
scripts/       build (esbuild), filter fetch/compile, icon renderer
filters/raw/   upstream snapshots · filters/anti-venom/ lists maintained here
test/          unit tests, helpers/chrome-mock.ts, e2e/ (CDP harness, fixture, screenshots)
```

The engine (`src/filters`, `src/shared`) has no Chrome dependencies. The UI talks to the background only
through `src/shared/messages.ts`. Adding a feature usually means a pure module, a handler in `messaging.ts`, and
a view.

## Testing

**Unit tests (64)** cover:
- parsing, rule conversion and optimisation, and domain matching;
- site-policy resolution and the allowlist;
- rule prioritisation, including a model of DNR's precedence algorithm covering exceptions, `$important`,
  security blocks, tracking-off, protection-off, pauses and re-enabled subdomains;
- pop-up matching, privacy rules, the domain-list format and the classifier;
- statistics aggregation and migration, and the RE2 cost model (calibrated on real Chrome results);
- background modules against a chrome mock: settings migration and sanitisation, storage persistence, list
  updates (diff, network failure, HTML response, DNR failure), custom subscriptions, `applyState`, rule
  recovery, and restore defaults.

**End-to-end (`npm run test:e2e`)** loads `dist/` into Chrome or Edge with a throwaway profile via
`Extensions.loadUnpacked` and runs about 100 checks:
- every bundled regex is accepted by Chrome;
- ads, trackers, pixels and fingerprinting are blocked, while CDN, first-party, login, payment and CAPTCHA
  scripts load;
- cosmetic hiding (static and dynamic);
- parameter stripping, the GPC header and JS property, custom rules, and all per-site controls and pauses;
- pop-up closing (and keeping same-site pop-ups);
- global switches, dashboard data, and list updates and failures;
- persistence across a browser restart, restore defaults, and every app view and the popup rendering without
  console errors.

It also visits live sites across categories: news (CNN, BBC), a blog (WordPress.org), video (YouTube, Vimeo),
shopping (Amazon, eBay), social (Reddit), search (Bing, DuckDuckGo), web apps (GitHub, Excalidraw) and
Wikipedia. Each site gets a warm-up visit, then is compared against protection paused to separate breakage from
site behaviour. `E2E_LIVE=0` skips live sites; `BROWSER=<path>` picks the browser.

## Known limitations (Manifest V3 and design choices)

| Area | Limitation | What Anti-Venom does |
| --- | --- | --- |
| Procedural cosmetics, scriptlets | Need code execution in pages from list data | Skipped and reported per list (≈300 + ≈35). Native `:has()` is supported. |
| `$redirect`, `$csp`, `$removeparam`, `$rewrite` | Not safely expressible | Skipped, never approximated; the built-in parameter stripping covers the common `$removeparam` cases. |
| Ad-domain `$document` blocks | Would put Chrome's block page on navigation | Skipped (≈560); only malicious-domain lists block top-level pages. |
| Redirect / bounce tracking (`google.com/url?q=`) | DNR can't decode the destination | Not handled; documented in the UI. |
| Third-party cookies | Removing them per request breaks sign-in | Left to Chrome's own setting; documented in the UI. |
| Per-site "ads allowed but trackers blocked" | DNR priorities are global, and ads outrank trackers | Not offered; sites can have tracking off (ads still blocked) or protection off / paused. |
| Pop-up blocking | Runs after the tab opens, so it can flash briefly; only `$popup`-listed destinations | Same-site pop-ups are never closed. |
| Statistics categories | DNR doesn't reveal the matching rule | Estimated from the lists' domain index and request type (labelled in the UI); other blockers or built-in browser protection add to the count. |
| Regex filters | RE2 memory limit; Chrome silently ignores oversize static regexes | Build-time cost estimate drops them (14 in EasyList) and reports them. |
| Dynamic rule quota | 30,000 rules (Chrome 121+), 1,000 regex | Budgeted; overflow is trimmed (exceptions kept first) and reported on the list. |
| Category index size | ≈100k hosts (2 MB) are loaded once per service-worker lifetime when the first block is counted | Next step: a compact sorted index. |
| Generic hiding on class changes | Only added nodes are scanned, not attribute changes | Keeps CPU low. |

## Publishing checklist

- Bump `version` in `package.json`, run `npm run filters:fetch`, `npm run check` and `npm run test:e2e`.
- Zip the **contents** of `dist/` and upload it to the Chrome Web Store.
- Store listing: use the permission justifications above; link a privacy policy matching the security and
  privacy model; keep the list attributions (see `NOTICE.md` and the About page).

## Roadmap

1. **Element picker** writing cosmetic rules into Custom rules (the rule editor and user cosmetic bundle exist).
2. **Settings import/export** (the schema is versioned and sanitised, so import can reuse `sanitizeSettings`).
3. **Compact category index** (sorted arrays plus binary search) to cut service-worker start-up cost.
4. **Bundled scriptlet set** for common anti-adblock and `set-constant` cases, as vetted local code.
5. **More built-in lists** as static rulesets (regional lists, annoyances), off by default.
6. **CI**: unit tests on every push; e2e against Chrome for Testing nightly; weekly filter-snapshot refresh PRs.
7. **Firefox/Safari**: the engine is platform-neutral; a browser adapter for `rules.ts` and `cosmetic-service.ts`
   would be needed.
