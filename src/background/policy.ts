/** Background helpers for evaluating per-site policy against current state. */
import { isProtectionOff, resolveSitePolicy, type ResolvedSitePolicy } from '../shared/site-policy.ts';
import { getPauses, getSettings } from './storage.ts';

export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

export async function policyFor(host: string): Promise<ResolvedSitePolicy> {
  const settings = await getSettings();
  return resolveSitePolicy(settings.sites, host, await getPauses());
}

/** Is any blocking/hiding active for documents on `host` (global + site + pause)? */
export async function protectionActiveFor(host: string | null): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.enabled) return false;
  if (!host) return true;
  return !isProtectionOff(await policyFor(host));
}
