/**
 * Content script (document_start, all frames).
 *
 * 1. Asks the background to inject this frame's base cosmetic CSS
 *    (domain-specific + unkeyed generic selectors). The background uses
 *    chrome.scripting.insertCSS, so this script never touches page styles.
 * 2. If generic hiding applies, collects the class and id tokens that occur in
 *    the page and sends only *new* tokens to the background, which injects the
 *    generic selectors keyed by them.
 *
 * Work is batched: mutations are queued and processed at most once per
 * FLUSH_INTERVAL_MS, and each token is reported only once per document.
 */
import type { Envelope, Request } from '../shared/messages.ts';

const FLUSH_INTERVAL_MS = 150;
const MAX_TOKENS_PER_MESSAGE = 2000;
const TOKEN_RE = /^[A-Za-z_-][\w-]*$/;

const seen = new Set<string>();
let queue: Element[] = [];
let pendingTokens: string[] = [];
let flushScheduled = false;

function send(msg: Request): Promise<Envelope<unknown> | undefined> {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => undefined) as Promise<Envelope<unknown> | undefined>;
  } catch {
    // "Extension context invalidated" (extension reloaded/updated): stop quietly.
    return Promise.resolve(undefined);
  }
}

function collect(el: Element): void {
  const id = el.id;
  if (id && TOKEN_RE.test(id)) {
    const t = `#${id}`;
    if (!seen.has(t)) {
      seen.add(t);
      pendingTokens.push(t);
    }
  }
  const cl = el.classList;
  for (let i = 0; i < cl.length; i++) {
    const c = cl[i]!;
    if (!TOKEN_RE.test(c)) continue;
    const t = `.${c}`;
    if (!seen.has(t)) {
      seen.add(t);
      pendingTokens.push(t);
    }
  }
}

function scanSubtree(root: Element): void {
  collect(root);
  const nodes = root.querySelectorAll('[id],[class]');
  for (let i = 0; i < nodes.length; i++) collect(nodes[i]!);
}

function flush(): void {
  flushScheduled = false;
  const batch = queue;
  queue = [];
  for (const el of batch) if (el.isConnected) scanSubtree(el);
  while (pendingTokens.length) {
    const tokens = pendingTokens.slice(0, MAX_TOKENS_PER_MESSAGE);
    pendingTokens = pendingTokens.slice(MAX_TOKENS_PER_MESSAGE);
    void send({ type: 'cosmetic:tokens', tokens });
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(flush, FLUSH_INTERVAL_MS);
}

function startGenericHiding(): void {
  const root = document.documentElement;
  if (root) {
    queue.push(root);
    flush(); // whatever exists at document_start
  }
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const added = m.addedNodes;
      for (let i = 0; i < added.length; i++) {
        const n = added[i]!;
        if (n.nodeType === Node.ELEMENT_NODE) queue.push(n as Element);
      }
    }
    if (queue.length) scheduleFlush();
  });
  observer.observe(document, { childList: true, subtree: true });

  // The full DOM is available here; catch anything the observer batching missed.
  const onReady = () => {
    if (document.documentElement) queue.push(document.documentElement);
    scheduleFlush();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();
}

async function main(): Promise<void> {
  // Only http(s) documents are relevant; about:blank/srcdoc frames inherit nothing useful.
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const res = (await send({ type: 'cosmetic:init' })) as Envelope<{ active: boolean; generic: boolean }> | undefined;
  if (!res?.ok || !res.data.active || !res.data.generic) return;
  startGenericHiding();
}

void main();
