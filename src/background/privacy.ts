/**
 * Privacy protection module: decides which built-in privacy rulesets are
 * enabled and manages the Global Privacy Control page script.
 *
 * Covered here (in addition to the privacy filter lists):
 *  - tracking-parameter stripping (DNR redirect + queryTransform)
 *  - Global Privacy Control / DNT request headers (DNR modifyHeaders)
 *  - navigator.globalPrivacyControl (bundled MAIN-world script; no remote code)
 *  - third-party beacon / hyperlink-auditing blocking
 */
import { FEATURE_RULESETS } from '../filters/privacy-rules.ts';
import { log } from '../shared/logger.ts';
import type { Settings } from '../shared/types.ts';

const GPC_SCRIPT_ID = 'anti-venom-gpc';

export function desiredFeatureRulesets(settings: Settings): string[] {
  if (!settings.enabled) return [];
  const out: string[] = [];
  if (settings.trackingProtection && settings.privacy.stripTrackingParams) out.push(FEATURE_RULESETS.stripParams);
  if (settings.trackingProtection && settings.privacy.blockBeacons) out.push(FEATURE_RULESETS.beacons);
  if (settings.privacy.globalPrivacyControl) out.push(FEATURE_RULESETS.gpc);
  return out;
}

/** Match patterns for sites where privacy features are switched off. */
function excludedPatterns(settings: Settings): string[] {
  const hosts = Object.entries(settings.sites)
    .filter(([, o]) => o.protection === false || o.tracking === false)
    .map(([h]) => h);
  return hosts.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]);
}

/** Registers/updates/unregisters the MAIN-world script exposing navigator.globalPrivacyControl. */
export async function syncGpcScript(settings: Settings): Promise<void> {
  const want = settings.enabled && settings.privacy.globalPrivacyControl;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [GPC_SCRIPT_ID] });
    const excludeMatches = excludedPatterns(settings);
    if (!want) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] });
      return;
    }
    const script: chrome.scripting.RegisteredContentScript = {
      id: GPC_SCRIPT_ID,
      js: ['gpc.js'],
      matches: ['http://*/*', 'https://*/*'],
      excludeMatches,
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
      persistAcrossSessions: true,
    };
    if (existing.length) {
      const prev = existing[0]!;
      if (JSON.stringify(prev.excludeMatches ?? []) === JSON.stringify(excludeMatches)) return;
      await chrome.scripting.updateContentScripts([script]);
    } else {
      await chrome.scripting.registerContentScripts([script]);
    }
  } catch (err) {
    log.warn('Could not update the Global Privacy Control script', err);
  }
}
