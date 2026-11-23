/**
 * Local-only diagnostics: recent warnings/errors kept in storage.session
 * (cleared when the browser closes) for display on the options page.
 */
import { STORAGE_KEYS } from '../shared/constants.ts';
import { DIAGNOSTIC_LIMIT, setDiagnosticSink } from '../shared/logger.ts';
import type { DiagnosticEntry } from '../shared/types.ts';

let buffer: DiagnosticEntry[] | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<DiagnosticEntry[]> {
  if (!buffer) {
    const s = await chrome.storage.session.get(STORAGE_KEYS.diagnostics).catch(() => ({}) as Record<string, unknown>);
    const stored = (s as Record<string, unknown>)[STORAGE_KEYS.diagnostics];
    buffer = Array.isArray(stored) ? (stored as DiagnosticEntry[]) : [];
  }
  return buffer;
}

export function installDiagnosticSink(): void {
  setDiagnosticSink((entry) => {
    void load().then((buf) => {
      buf.push(entry);
      if (buf.length > DIAGNOSTIC_LIMIT) buf.splice(0, buf.length - DIAGNOSTIC_LIMIT);
      writeTimer ??= setTimeout(() => {
        writeTimer = null;
        void chrome.storage.session.set({ [STORAGE_KEYS.diagnostics]: buf }).catch(() => {});
      }, 500);
    });
  });
}

export async function getDiagnostics(): Promise<DiagnosticEntry[]> {
  return [...(await load())].reverse();
}
