/** Hostname helpers shared by the converter, the cosmetic engine and the UI. */

const HOST_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/;

/**
 * Normalises a hostname to lowercase ASCII (punycode for IDNs).
 * Returns null when the input is not a plausible hostname.
 */
export function toASCIIHost(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}/`).hostname;
    } catch {
      return null;
    }
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length > 253 || !HOST_RE.test(host)) return null;
  return host;
}

/** Entity-style domain from filter lists, e.g. "google.*". Not expressible in DNR. */
export function isEntityDomain(domain: string): boolean {
  return domain.endsWith('.*');
}

/**
 * All keys under which cosmetic filters for `host` may be stored:
 * the host itself, each parent domain, and entity forms ("example.*").
 */
export function hostLookupKeys(host: string): string[] {
  const labels = host.split('.');
  const keys: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const remaining = labels.length - i;
    keys.push(labels.slice(i).join('.'));
    if (remaining >= 2) keys.push(`${labels.slice(i, -1).join('.')}.*`);
    if (remaining >= 3) keys.push(`${labels.slice(i, -2).join('.')}.*`);
  }
  return keys;
}

/** True when `host` equals `domain` or is a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || (host.length > domain.length && host.endsWith(domain) && host[host.length - domain.length - 1] === '.');
}

/** Normalises user input (URL or hostname) into the host stored in the allowlist. */
export function normalizeSiteInput(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  } else {
    value = value.replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  }
  const host = toASCIIHost(value.replace(/^\*\./, ''));
  if (!host) return null;
  return host.startsWith('www.') ? host.slice(4) : host;
}
