import { h } from '../ui/dom.ts';

export interface ViewContext {
  toast(message: string): void;
  /** Runs an action, toasts success or the error message; returns undefined on failure. */
  act<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined>;
  /** Re-renders the current view (keeps scroll position). */
  rerender(): void;
}

export type View = (root: HTMLElement, ctx: ViewContext) => Promise<(() => void) | void>;

export function viewHead(title: string, subtitle?: string, ...actions: HTMLElement[]): HTMLElement {
  return h(
    'header',
    { className: 'view-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null),
    actions.length ? h('div', { className: 'head-actions' }, ...actions) : null,
  );
}

export function settingRow(opts: { title: string | Node; sub?: string; control: HTMLElement; disabled?: boolean }): HTMLElement {
  return h(
    'div',
    { className: `row${opts.disabled ? ' disabled' : ''}` },
    h('div', {}, h('div', { className: 'row-title' }, opts.title), opts.sub ? h('div', { className: 'row-sub' }, opts.sub) : null),
    opts.control,
  );
}

export function panel(title: string, sub: string | null, ...children: (Node | null)[]): HTMLElement {
  return h('section', { className: 'panel' }, h('h2', {}, title), sub ? h('p', { className: 'sub' }, sub) : null, ...children);
}
