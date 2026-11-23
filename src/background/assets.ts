/**
 * Loads non-DNR filter data (cosmetic and pop-up bundles) for the active
 * lists. Runtime-updated data supersedes the bundled snapshot. Results are
 * cached until `invalidateAssets()` is called after any list/filter change.
 */
import type { CosmeticBundle } from '../filters/cosmetic.ts';
import type { PopupBundle } from '../filters/matcher.ts';
import { log } from '../shared/logger.ts';
import { getListData, getSettings, getUserBundles } from './storage.ts';
import { getLists, isListActive } from './lists.ts';

export interface ActiveAssets {
  cosmetic: CosmeticBundle[];
  popup: PopupBundle[];
}

const fileCache = new Map<string, Promise<unknown>>();
let assetsPromise: Promise<ActiveAssets> | null = null;
const listeners = new Set<() => void>();

function loadPackaged<T>(path: string): Promise<T | null> {
  let p = fileCache.get(path) as Promise<T | null> | undefined;
  if (!p) {
    p = fetch(chrome.runtime.getURL(path))
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .catch((err) => {
        log.warn(`Missing packaged data ${path}`, err);
        return null;
      });
    fileCache.set(path, p);
  }
  return p;
}

async function build(): Promise<ActiveAssets> {
  const settings = await getSettings();
  const out: ActiveAssets = { cosmetic: [], popup: [] };
  for (const list of await getLists()) {
    if (!isListActive(list, settings)) continue;
    const data = await getListData(list.id);
    const cosmetic = data?.cosmetic ?? (list.bundled ? await loadPackaged<CosmeticBundle>(`filters/${list.id}.cosmetic.json`) : null);
    const popup = data?.popup ?? (list.bundled ? await loadPackaged<PopupBundle>(`filters/${list.id}.popup.json`) : null);
    if (cosmetic) out.cosmetic.push(cosmetic);
    if (popup) out.popup.push(popup);
  }
  const user = await getUserBundles();
  if (user.cosmetic) out.cosmetic.push(user.cosmetic);
  if (user.popup) out.popup.push(user.popup);
  return out;
}

export function getActiveAssets(): Promise<ActiveAssets> {
  assetsPromise ??= build().catch((err) => {
    assetsPromise = null;
    throw err;
  });
  return assetsPromise;
}

/** Call whenever lists, list data or user filters change. */
export function invalidateAssets(): void {
  assetsPromise = null;
  for (const fn of listeners) fn();
}

export function onAssetsInvalidated(fn: () => void): void {
  listeners.add(fn);
}
