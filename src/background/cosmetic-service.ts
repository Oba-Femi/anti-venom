/**
 * Background side of cosmetic filtering. Builds a CosmeticEngine from the
 * active lists (lazily, once per service-worker lifetime or after a change)
 * and injects CSS into frames with chrome.scripting.insertCSS (USER origin,
 * so page styles cannot override it and no DOM nodes are created).
 */
import { CosmeticEngine } from '../filters/cosmetic.ts';
import { isProtectionOff, resolveSitePolicy } from '../shared/site-policy.ts';
import { log } from '../shared/logger.ts';
import { getPauses, getSettings } from './storage.ts';
import { getActiveAssets, invalidateAssets, onAssetsInvalidated } from './assets.ts';
import { hostOf } from './policy.ts';

let enginePromise: Promise<CosmeticEngine> | null = null;
onAssetsInvalidated(() => (enginePromise = null));

function getEngine(): Promise<CosmeticEngine> {
  enginePromise ??= getActiveAssets()
    .then((a) => {
      const t0 = performance.now();
      const engine = new CosmeticEngine(a.cosmetic);
      log.debug(`cosmetic engine ready in ${Math.round(performance.now() - t0)} ms`, engine.stats);
      return engine;
    })
    .catch((err) => {
      enginePromise = null;
      throw err;
    });
  return enginePromise;
}

/** Kept for callers that only know about cosmetics. */
export function invalidateCosmetics(): void {
  invalidateAssets();
}

/** Whether cosmetic filtering applies to the frame described by `sender`. */
async function frameContext(sender: chrome.runtime.MessageSender): Promise<{ host: string } | null> {
  const settings = await getSettings();
  if (!settings.enabled || !settings.cosmeticFiltering) return null;
  const host = hostOf(sender.url);
  if (!host || sender.tab?.id === undefined) return null;
  // Site policy applies to the whole tab, keyed on the top-level site.
  const topHost = sender.frameId === 0 ? host : (hostOf(sender.tab.url) ?? host);
  const policy = resolveSitePolicy(settings.sites, topHost, await getPauses());
  if (isProtectionOff(policy) || !policy.cosmetic) return null;
  return { host };
}

async function inject(sender: chrome.runtime.MessageSender, css: string): Promise<void> {
  if (!css || sender.tab?.id === undefined) return;
  const target: chrome.scripting.InjectionTarget = sender.documentId
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
  try {
    await chrome.scripting.insertCSS({ target, css, origin: 'USER' });
  } catch (err) {
    // The frame may have navigated away or been discarded; not actionable.
    log.debug('insertCSS failed', err);
  }
}

export async function handleCosmeticInit(sender: chrome.runtime.MessageSender): Promise<{ active: boolean; generic: boolean }> {
  const ctx = await frameContext(sender);
  if (!ctx) return { active: false, generic: false };
  const engine = await getEngine();
  const { css, generic } = engine.getFrameCosmetics(ctx.host);
  await inject(sender, css);
  return { active: true, generic };
}

const TOKEN_RE = /^[.#][A-Za-z_-][\w-]{0,255}$/;

export async function handleCosmeticTokens(sender: chrome.runtime.MessageSender, tokens: unknown): Promise<void> {
  if (!Array.isArray(tokens)) return;
  const clean = tokens.slice(0, 4000).filter((t): t is string => typeof t === 'string' && TOKEN_RE.test(t));
  if (!clean.length) return;
  const ctx = await frameContext(sender);
  if (!ctx) return;
  const engine = await getEngine();
  await inject(sender, engine.getGenericCssForTokens(ctx.host, clean));
}
