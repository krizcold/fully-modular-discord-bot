import fs from 'fs';
import ts from 'typescript';

// A web UI component (src/webui/public, a browser script with React as a global) run without a browser: TypeScript
// compiles its JSX to React.createElement, and a small hook runtime (useState, useEffect, useRef) renders it into
// plain element objects. Its api calls are held until the test answers them, in any order, so a late answer can be
// played after a newer one.

export interface El { type: string; props: Record<string, any>; children: Array<El | string> }

export interface HeldCall {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  body?: any;
  done: boolean;
  answer: (value: any) => void;
  fail: (message: string) => void;
}

export function heldApi() {
  const calls: HeldCall[] = [];
  const make = (method: HeldCall['method']) => (url: string, body?: any) => new Promise<any>((resolve, reject) => {
    const call: HeldCall = {
      method, url, body, done: false,
      answer: value => { call.done = true; resolve(value); },
      fail: message => { call.done = true; reject(new Error(message)); },
    };
    calls.push(call);
  });
  return { calls, api: { get: make('GET'), post: make('POST'), put: make('PUT') } };
}

export function mount(file: string, name: string, props: Record<string, any>, globals: Record<string, any>) {
  const hooks: any[] = [];
  let index = 0;
  let effects: Array<() => void> = [];
  let scheduled = false;
  let tree: El | null = null;

  const React = {
    useState(initial: any) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      const hook = hooks[i];
      const set = (next: any) => {
        const value = typeof next === 'function' ? next(hook.value) : next;
        if (Object.is(value, hook.value)) return;
        hook.value = value;
        schedule();
      };
      return [hook.value, set];
    },
    useRef(initial: any) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useMemo(compute: () => any, deps?: any[]) {
      const i = index++;
      const before = hooks[i];
      const changed = !before || !deps || deps.length !== before.deps.length || deps.some((d, k) => !Object.is(d, before.deps[k]));
      if (changed) hooks[i] = { deps: deps ?? [], value: compute() };
      return hooks[i].value;
    },
    useEffect(effect: () => void, deps?: any[]) {
      const i = index++;
      const before = hooks[i];
      const changed = !before || !deps || deps.length !== before.deps.length || deps.some((d, k) => !Object.is(d, before.deps[k]));
      hooks[i] = { deps: deps ?? [] };
      if (changed) effects.push(effect);
    },
    createElement(type: any, elProps: Record<string, any> | null, ...children: any[]): any {
      const flat = children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true);
      if (typeof type === 'function') return type({ ...(elProps ?? {}), children: flat });
      return { type: String(type), props: elProps ?? {}, children: flat.map(c => (typeof c === 'object' ? c : String(c))) };
    },
    Fragment: 'fragment',
  };

  const source = fs.readFileSync(file, 'utf-8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
  const names = Object.keys(globals);
  const Component = new Function('React', ...names, `${compiled}\nreturn ${name};`)(React, ...names.map(n => globals[n]));

  function render() {
    index = 0;
    effects = [];
    tree = Component(props);
    const run = effects;
    effects = [];
    for (const effect of run) effect();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  }
  render();

  const all = (pred: (el: El) => boolean, from: El | null = tree, out: El[] = []): El[] => {
    if (!from) return out;
    if (pred(from)) out.push(from);
    for (const c of from.children) if (typeof c === 'object') all(pred, c, out);
    return out;
  };
  const text = (el: El | string): string => (typeof el === 'string' ? el : el.children.map(text).join(''));

  return {
    get tree() { return tree; },
    all,
    text,
    button: (label: RegExp) => all(el => el.type === 'button' && label.test(text(el)))[0],
    selects: () => all(el => el.type === 'select'),
    textarea: () => all(el => el.type === 'textarea')[0],
  };
}

/** Lets every queued microtask, render and effect run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}
