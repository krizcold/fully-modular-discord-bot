import fs from 'fs';
import path from 'path';
import vm from 'vm';

// The render rig of unit/nb25Panel.test.ts for the server's subscription page (GuildSubscriptionPanel.jsx), for P1's
// rows: the page runs with the api it is given, and its effects run after each render.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const babel = require('@babel/core');

const SRC = path.join(__dirname, '../../src/webui/public/assets/components/guild/GuildSubscriptionPanel.jsx');

export type Node = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };

export function loadGuildPanel(api: Record<string, unknown>, confirm: (text: string) => boolean = () => true) {
  const code = babel.transformSync(fs.readFileSync(SRC, 'utf8'), {
    presets: [[require.resolve('@babel/preset-react'), { runtime: 'classic' }]],
    babelrc: false,
    configFile: false,
  }).code;
  const state: unknown[] = [];
  const deps: Record<number, unknown[] | undefined> = {};
  const pending: Array<() => void> = [];
  let slot = 0;
  const React = {
    Fragment: 'Fragment',
    useRef(init: unknown) {
      const i = slot++;
      if (!(i in state)) state[i] = { current: init };
      return state[i];
    },
    useState(init: unknown) {
      const i = slot++;
      if (!(i in state)) state[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [state[i], (v: unknown) => { state[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(state[i]) : v; }];
    },
    useEffect(fn: () => unknown, d?: unknown[]) {
      const i = slot++;
      const prev = deps[i];
      const changed = !prev || !d || d.length !== prev.length || d.some((x, k) => x !== prev[k]);
      if (i in deps && !changed) return;
      deps[i] = d;
      pending.push(() => { fn(); });
    },
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props, children }),
  };
  const ctx: Record<string, unknown> = {
    React, guildApi: api, confirm, alert: () => {}, disabledButtonStyle: () => ({}),
    RefetchOverlay: 'RefetchOverlay', FirstLoadPlaceholder: 'FirstLoadPlaceholder',
    window: { location: { search: '', pathname: '/', hash: '', origin: 'http://x', href: '' }, history: { replaceState() {} } },
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const render = (props: unknown): Node => {
    slot = 0;
    const tree = (ctx.GuildSubscriptionPanel as (p: unknown) => Node)(props);
    while (pending.length) pending.shift()!();
    return tree;
  };
  return { render };
}

export function panelText(tree: unknown): string {
  if (tree === null || tree === undefined || tree === false || tree === true) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(panelText).join('');
  return ((tree as Node).children || []).map(panelText).join('');
}

export const panelFlush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
