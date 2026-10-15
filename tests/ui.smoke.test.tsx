// @vitest-environment jsdom
/**
 * Renders the real web app in jsdom against a running DrakoX server and clicks through the main
 * flows. Skipped unless DRAKOX_UI_URL points at a server started with --no-auth, e.g.:
 *   DRAKOX_HOME=$(mktemp -d) node dist/cli/index.js ui --no-auth --no-open --no-mcp --port 4590 &
 *   DRAKOX_UI_URL=http://127.0.0.1:4590 npx vitest run tests/ui.smoke.test.tsx
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { WebSocket as NodeWebSocket } from 'ws';

const BASE = process.env.DRAKOX_UI_URL;
const errors: string[] = [];
let root: Root;

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeout = 15_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}. Page text: ${document.body.textContent?.slice(0, 600)}`);
}
const text = () => document.body.textContent ?? '';
const waitText = (t: string, timeout?: number) => waitFor(() => text().includes(t), `"${t}"`, timeout);
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label) && !(b as HTMLButtonElement).disabled) as HTMLButtonElement | undefined;
const go = (hash: string) => {
  location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
};

describe.skipIf(!BASE)('web app smoke test', () => {
  beforeAll(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => realFetch(new URL(String(input), BASE), init)) as typeof fetch;
    class WS extends NodeWebSocket {
      constructor(url: string | URL) {
        super(String(url).replace(/^wss?:\/\/[^/]+/, BASE!.replace(/^http/, 'ws')));
      }
    }
    (globalThis as any).WebSocket = WS;
    (window as any).WebSocket = WS;
    window.matchMedia = ((q: string) => ({ matches: q.includes('dark'), media: q, addEventListener() {}, removeEventListener() {}, onchange: null, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as any;
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    Element.prototype.scrollIntoView = function () {};
    Element.prototype.scrollTo = function () {} as any;
    const origError = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      if (!/Not implemented|act\(|ReactDOMTestUtils/.test(msg)) errors.push(msg);
      origError(...(args as []));
    });
    localStorage.setItem('drakox.onboarded', '1');
    localStorage.setItem('drakox.mode', 'ask');
    const { App } = await import('../web/src/App');
    const el = document.createElement('div');
    el.id = 'root';
    document.body.append(el);
    root = createRoot(el);
    root.render(<App />);
  });

  afterAll(() => {
    root?.unmount();
  });

  it('shows Mission Control with workspace info', async () => {
    await waitText('What should');
    await waitText('Mission Control');
    await waitFor(() => document.querySelector('textarea'), 'composer');
  });

  it('renders integrations, catalog, skills and settings', async () => {
    go('#/integrations/catalog');
    await waitText('Integrations');
    await waitText('REA — Reverse Engineer Anything');
    await waitText('GitHub');
    go('#/integrations/custom');
    await waitText('Add integration');
    go('#/skills');
    await waitText('/reverse-engineer');
    await waitText('explorer');
    go('#/settings/models');
    await waitText('Default model');
    await waitText('Local — free, unlimited, private');
    go('#/settings/permissions');
    await waitText('Default mode');
    await waitText('Allow');
    go('#/settings/about');
    await waitText('What “free & unlimited” means');
  });

  it('launches an agent, approves an edit, and finishes the turn', async () => {
    go('#/');
    const ta = await waitFor(() => document.querySelector('textarea'), 'composer');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, 'Fix the failing discount test');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => location.hash.startsWith('#/agent/'), 'navigation to the agent view');
    await waitText('Fix the failing discount test');
    // the demo model edits a file → ask mode requests approval
    await waitText('Edits need approval', 20_000);
    const allow = await waitFor(() => button('Allow'), 'Allow button');
    allow.click();
    await waitText('Done', 20_000);
    await waitText('DRAKOX_DEMO.md');
    // the changes panel lists the file
    const changesTab = await waitFor(() => button('Changes'), 'Changes tab');
    changesTab.click();
    await waitFor(() => [...document.querySelectorAll('span')].some((s) => s.textContent === 'DRAKOX_DEMO.md'), 'changed file in panel');
  });

  it('opens the event log and the command palette', async () => {
    const id = decodeURIComponent(location.hash.split('/')[2] ?? '');
    go(`#/log/${encodeURIComponent(id)}`);
    await waitText('Event log');
    await waitText('user_message');
    await waitText('approval_request');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await waitText('New agent in an isolated worktree');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  });

  it('logged no React/runtime errors', () => {
    expect(errors).toEqual([]);
  });
});
