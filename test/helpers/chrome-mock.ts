/**
 * In-memory stand-in for the chrome.* APIs used by the background modules,
 * so storage, rule management and list updates can be tested in Node.
 * Install it *before* dynamically importing background modules.
 *
 * Extension-packaged files (chrome-extension://test/...) are served from
 * dist/, so run `npm run build` first. Remote URLs are answered by
 * `mock.remote` (url → response text or Error).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type Listener = (...args: any[]) => void;
const DIST = join(import.meta.dirname, '..', '..', 'dist');
const BASE = 'chrome-extension://test/';

function area() {
  let data: Record<string, unknown> = {};
  return {
    get data() {
      return data;
    },
    reset() {
      data = {};
    },
    async get(keys?: string | string[] | null) {
      if (keys == null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: v };
        data[k] = structuredClone(v);
      }
      for (const l of storageListeners) l(changes, this === mock.storage.local ? 'local' : 'session');
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

const storageListeners: Listener[] = [];
let manifest: any = { version: '0.0.0-test', declarative_net_request: { rule_resources: [] } };
if (existsSync(join(DIST, 'manifest.json'))) manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));

interface Rule {
  id: number;
  condition: { regexFilter?: string };
  [k: string]: unknown;
}

export const mock = {
  storage: { local: area(), session: area(), onChanged: { addListener: (l: Listener) => storageListeners.push(l) } },
  dynamicRules: [] as Rule[],
  sessionRules: [] as Rule[],
  enabledRulesets: new Set<string>(),
  disabledStatic: new Map<string, Set<number>>(),
  /** Make the next updateDynamicRules call fail (simulates quota / invalid rule). */
  failNextDynamicUpdate: false,
  remote: new Map<string, string | Error>(),
  fetchLog: [] as string[],
  reset() {
    this.storage.local.reset();
    this.storage.session.reset();
    this.dynamicRules = [];
    this.sessionRules = [];
    this.enabledRulesets = new Set(manifest.declarative_net_request.rule_resources.filter((r: any) => r.enabled).map((r: any) => r.id));
    this.disabledStatic = new Map();
    this.failNextDynamicUpdate = false;
    this.remote.clear();
    this.fetchLog = [];
  },
};

function applyUpdate(list: Rule[], opts: { removeRuleIds?: number[]; addRules?: Rule[] }): Rule[] {
  const remove = new Set(opts.removeRuleIds ?? []);
  const next = list.filter((r) => !remove.has(r.id));
  for (const r of opts.addRules ?? []) {
    if (next.some((x) => x.id === r.id)) throw new Error(`Rule with id ${r.id} already exists`);
    next.push(structuredClone(r));
  }
  return next;
}

const noopEvent = { addListener() {}, removeListener() {} };

(globalThis as any).chrome = {
  storage: mock.storage,
  runtime: {
    id: 'test',
    getURL: (p: string) => BASE + p,
    getManifest: () => manifest,
    onMessage: noopEvent,
    onInstalled: noopEvent,
    onStartup: noopEvent,
  },
  declarativeNetRequest: {
    MAX_NUMBER_OF_DYNAMIC_RULES: 30_000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    async getDynamicRules() {
      return structuredClone(mock.dynamicRules);
    },
    async updateDynamicRules(opts: any) {
      if (mock.failNextDynamicUpdate) {
        mock.failNextDynamicUpdate = false;
        throw new Error('Simulated DNR failure');
      }
      mock.dynamicRules = applyUpdate(mock.dynamicRules, opts); // atomic: computed before assignment
    },
    async getSessionRules() {
      return structuredClone(mock.sessionRules);
    },
    async updateSessionRules(opts: any) {
      mock.sessionRules = applyUpdate(mock.sessionRules, opts);
    },
    async getEnabledRulesets() {
      return [...mock.enabledRulesets];
    },
    async updateEnabledRulesets(opts: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }) {
      for (const id of opts.disableRulesetIds ?? []) mock.enabledRulesets.delete(id);
      for (const id of opts.enableRulesetIds ?? []) mock.enabledRulesets.add(id);
    },
    async getDisabledRuleIds({ rulesetId }: { rulesetId: string }) {
      return [...(mock.disabledStatic.get(rulesetId) ?? [])];
    },
    async updateStaticRules({ rulesetId, enableRuleIds = [], disableRuleIds = [] }: any) {
      const set = mock.disabledStatic.get(rulesetId) ?? new Set<number>();
      for (const id of enableRuleIds) set.delete(id);
      for (const id of disableRuleIds) set.add(id);
      mock.disabledStatic.set(rulesetId, set);
    },
    async getAvailableStaticRuleCount() {
      return 300_000;
    },
    async isRegexSupported() {
      return { isSupported: true };
    },
  },
  alarms: { get: async () => undefined, create: async () => {}, clear: async () => true, onAlarm: noopEvent },
  scripting: {
    getRegisteredContentScripts: async () => [],
    registerContentScripts: async () => {},
    updateContentScripts: async () => {},
    unregisterContentScripts: async () => {},
    insertCSS: async () => {},
  },
  tabs: { query: async () => [], get: async () => null, onRemoved: noopEvent, onUpdated: noopEvent },
  action: { setIcon: async () => {}, setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  webRequest: { onErrorOccurred: noopEvent, onBeforeRequest: noopEvent },
  webNavigation: { onCreatedNavigationTarget: noopEvent, onBeforeNavigate: noopEvent },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  mock.fetchLog.push(url);
  if (url.startsWith(BASE)) {
    const file = join(DIST, url.slice(BASE.length));
    if (!existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(file, 'utf8'), { status: 200 });
  }
  const r = mock.remote.get(url);
  if (r === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
  if (r instanceof Error) throw r;
  return new Response(r, { status: 200 });
}) as typeof fetch;
void realFetch;

mock.reset();
