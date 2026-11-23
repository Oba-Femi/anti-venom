/**
 * Compiles bundled filter lists into:
 *   <out>/rules/<id>.json             static DNR ruleset per list
 *   <out>/rules/anti-venom-*.json        built-in privacy feature rulesets
 *   <out>/filters/<id>.cosmetic.json  cosmetic bundle
 *   <out>/filters/<id>.popup.json     $popup filters for the pop-up blocker
 *   <out>/filters/categories.json     host → category index for statistics
 *   <out>/filters/bundled.json        metadata (version, counts, unsupported syntax)
 *
 * Sources: downloaded snapshots in filters/raw/ and lists maintained in this
 * repository in filters/anti-venom/.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIST_CATALOG, type BlockCategory } from '../src/shared/catalog.ts';
import { compileFilterList } from '../src/filters/compiler.ts';
import { looksLikeFilterList, parseVersion } from '../src/filters/validate.ts';
import { hostsFromRules } from '../src/filters/classify.ts';
import { FEATURE_RULESETS, featureRules, type PrivacyFeature } from '../src/filters/privacy-rules.ts';
import type { PriorityProfile } from '../src/filters/dnr-types.ts';
import type { BundledListMeta } from '../src/shared/types.ts';

/** Chrome guarantees 30k enabled static rules per extension; stay comfortably below. */
const MAX_STATIC_RULES_PER_LIST = 25_000;
/** Chrome ignores regex rules beyond 1000 per static ruleset. */
const MAX_REGEX_PER_RULESET = 1000;

const ROOT = join(import.meta.dirname, '..');

export interface RulesetResource {
  id: string;
  enabled: boolean;
  path: string;
}

function profileOf(category: string): PriorityProfile {
  return category === 'privacy' ? 'privacy' : category === 'security' ? 'security' : 'standard';
}

export async function compileBundledLists(outDir: string, log = console.log): Promise<RulesetResource[]> {
  await mkdir(join(outDir, 'rules'), { recursive: true });
  await mkdir(join(outDir, 'filters'), { recursive: true });
  const resources: RulesetResource[] = [];
  const meta: Record<string, BundledListMeta> = {};
  const categoryHosts: Partial<Record<BlockCategory, Set<string>>> = {};
  let totalRules = 0;

  for (const list of LIST_CATALOG.filter((l) => l.bundled)) {
    const source = list.url ? join(ROOT, 'filters', 'raw', `${list.id}.txt`) : join(ROOT, 'filters', 'anti-venom', `${list.id}.txt`);
    const text = await readFile(source, 'utf8').catch(() => null);
    if (!text || !looksLikeFilterList(text).ok) {
      throw new Error(`Missing or invalid source for ${list.id} (${source}). Run "npm run filters:fetch".`);
    }
    const t0 = performance.now();
    const { rules, cosmetic, popup, stats } = compileFilterList(text, {
      maxRules: MAX_STATIC_RULES_PER_LIST,
      maxRegexRules: MAX_REGEX_PER_RULESET,
      profile: profileOf(list.category),
      format: list.format ?? 'auto',
    });
    totalRules += rules.length;
    await writeFile(join(outDir, 'rules', `${list.id}.json`), JSON.stringify(rules));
    await writeFile(join(outDir, 'filters', `${list.id}.cosmetic.json`), JSON.stringify(cosmetic));
    await writeFile(join(outDir, 'filters', `${list.id}.popup.json`), JSON.stringify(popup));
    resources.push({ id: list.id, enabled: list.defaultEnabled, path: `rules/${list.id}.json` });
    const set = (categoryHosts[list.blockCategory] ??= new Set());
    for (const h of hostsFromRules(rules)) set.add(h);

    meta[list.id] = {
      version: parseVersion(text) ?? 'unknown',
      compiledAt: Date.now(),
      ruleCount: rules.length,
      cosmeticCount: stats.cosmetic.generic + stats.cosmetic.specific,
      popupCount: popup.domains.length + popup.rules.length,
      unsupported: stats.skipped,
    };

    const topSkips = Object.entries(stats.skipped)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    log(
      `  ${list.id.padEnd(23)} ${String(rules.length).padStart(6)} DNR rules (${stats.regexRules} regex), ` +
        `${stats.cosmetic.generic + stats.cosmetic.specific} cosmetic, ${meta[list.id]!.popupCount} pop-up; ` +
        `${Math.round(performance.now() - t0)} ms`,
    );
    if (stats.droppedForQuota) log(`    ! ${stats.droppedForQuota} rules dropped to fit quotas`);
    if (topSkips) log(`    unsupported: ${topSkips}`);
  }

  // Built-in privacy features (disabled by default; the engine enables them per settings).
  for (const [feature, id] of Object.entries(FEATURE_RULESETS) as [PrivacyFeature, string][]) {
    await writeFile(join(outDir, 'rules', `${id}.json`), JSON.stringify(featureRules(feature)));
    resources.push({ id, enabled: false, path: `rules/${id}.json` });
  }

  const index: Record<string, string[]> = {};
  for (const [cat, hosts] of Object.entries(categoryHosts)) index[cat] = [...hosts!].sort();
  await writeFile(join(outDir, 'filters', 'categories.json'), JSON.stringify(index));
  await writeFile(join(outDir, 'filters', 'bundled.json'), JSON.stringify(meta));
  log(`  total static rules: ${totalRules}; category index: ${Object.values(index).reduce((a, b) => a + b.length, 0)} hosts`);
  return resources;
}

// Allow running standalone: node scripts/compile-filters.ts [outDir]
if (import.meta.filename === process.argv[1]) {
  await compileBundledLists(process.argv[2] ?? join(ROOT, 'dist'));
}
