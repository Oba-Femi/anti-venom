/**
 * Tiny Chrome DevTools Protocol client over --remote-debugging-pipe.
 * Pipe mode is required for Extensions.loadUnpacked (Chrome 126+), which is
 * the supported way to load an unpacked extension now that branded Chrome
 * builds ignore --load-extension.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };
type EventHandler = (params: any, sessionId?: string) => void;

export class Browser {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<EventHandler>>();
  private buffer = '';
  private readonly proc: ChildProcess;
  private readonly out: Writable;
  private constructor(proc: ChildProcess, out: Writable) {
    this.proc = proc;
    this.out = out;
  }

  static async launch(executable: string, userDataDir: string, extraArgs: string[] = []): Promise<Browser> {
    const args = [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-size=1280,900',
      ...extraArgs,
      'about:blank',
    ];
    const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const out = proc.stdio[3] as Writable;
    const input = proc.stdio[4] as Readable;
    const browser = new Browser(proc, out);
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => browser.onData(chunk));
    proc.stderr?.resume();
    await browser.send('Target.setDiscoverTargets', { discover: true });
    return browser;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params, msg.sessionId);
      }
    }
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: timeout`));
      }, 60_000);
    });
  }

  on(method: string, handler: EventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  async targets(): Promise<{ targetId: string; type: string; url: string }[]> {
    return (await this.send('Target.getTargets')).targetInfos;
  }

  async waitForTarget(pred: (t: { type: string; url: string }) => boolean, timeoutMs = 15_000): Promise<{ targetId: string; type: string; url: string }> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const t = (await this.targets()).find(pred);
      if (t) return t;
      await sleep(200);
    }
    throw new Error('target not found');
  }

  /** Opens a tab and returns a flattened session for it. */
  async newPage(url = 'about:blank'): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url });
    return this.attach(targetId);
  }

  async attach(targetId: string): Promise<Page> {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.send('Runtime.enable').catch(() => {});
    return page;
  }

  async close(): Promise<void> {
    await this.send('Browser.close').catch(() => {});
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      this.proc.once('exit', () => resolve());
      setTimeout(() => {
        this.proc.kill();
        resolve();
      }, 10_000);
    });
  }
}

export class Page {
  readonly consoleErrors: string[] = [];
  readonly browser: Browser;
  readonly targetId: string;
  readonly sessionId: string;
  constructor(browser: Browser, targetId: string, sessionId: string) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    browser.on('Runtime.exceptionThrown', (p, s) => {
      if (s === sessionId) this.consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text);
    });
    browser.on('Runtime.consoleAPICalled', (p, s) => {
      if (s === sessionId && (p.type === 'error' || p.type === 'warning')) {
        this.consoleErrors.push(`${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(' ')}`);
      }
    });
  }

  send<T = any>(method: string, params: object = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async eval<T = any>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value as T;
  }

  async goto(url: string, settleMs = 2500): Promise<void> {
    await this.send('Page.enable');
    const loaded = new Promise<void>((resolve) => {
      const off = this.browser.on('Page.loadEventFired', (_p, s) => {
        if (s === this.sessionId) {
          off();
          resolve();
        }
      });
      setTimeout(resolve, 30_000);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(settleMs);
  }

  async close(): Promise<void> {
    await this.browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
