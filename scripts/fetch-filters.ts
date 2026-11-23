/**
 * Downloads fresh snapshots of every bundled filter list into filters/raw/.
 * The snapshots are committed so that builds are reproducible and offline-safe;
 * run `npm run filters:fetch` to refresh them before a release.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIST_CATALOG } from '../src/shared/catalog.ts';
import { looksLikeFilterList } from '../src/filters/validate.ts';

const RAW_DIR = join(import.meta.dirname, '..', 'filters', 'raw');
await mkdir(RAW_DIR, { recursive: true });

let failures = 0;
for (const list of LIST_CATALOG.filter((l) => l.bundled && l.url)) {
  const target = join(RAW_DIR, `${list.id}.txt`);
  try {
    const res = await fetch(list.url!, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const check = looksLikeFilterList(text);
    if (!check.ok) throw new Error(`rejected: ${check.reason}`);
    await writeFile(target, text);
    console.log(`✔ ${list.id}: ${text.length.toLocaleString()} bytes`);
  } catch (err) {
    failures++;
    // Keep whatever snapshot already exists rather than failing the build later.
    const existing = await readFile(target, 'utf8').catch(() => null);
    console.error(`✖ ${list.id}: ${(err as Error).message}${existing ? ' (kept previous snapshot)' : ' (no snapshot available!)'}`);
  }
}
process.exitCode = failures ? 1 : 0;
