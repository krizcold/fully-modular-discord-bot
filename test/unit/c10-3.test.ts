import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { transformSync } from '@babel/core';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSetupRoutes } from '@webui/routes/setup';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'webui', 'public');

// The pages are classic global-scope text/babel scripts: compile one and hand
// it the globals the browser page defines.
function loadComponent(file: string, name: string, globals: Record<string, unknown>): (props: any) => any {
  const source = fs.readFileSync(path.join(publicDir, file), 'utf-8');
  const code = transformSync(source, { presets: [['@babel/preset-react', { runtime: 'classic' }]], babelrc: false, configFile: false })!.code!;
  const names = Object.keys(globals);
  return new Function(...names, `${code}\nreturn ${name};`)(...names.map(n => globals[n]));
}

type Element = { type: unknown; props: Record<string, any> };

// One mounted component with useState, useMemo and useEffect; child function
// components are left as elements, so a test reads the props it passes them.
function mount(component: (props: any) => any, initialProps: Record<string, unknown>) {
  const hooks: any[] = [];
  let index = 0;
  let props = initialProps;
  let tree: any = null;
  let rendering = false;
  let again = false;
  const effects: Array<() => void> = [];
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const render = () => {
    if (rendering) { again = true; return; }
    rendering = true;
    try {
      do {
        again = false;
        index = 0;
        tree = component(props);
      } while (again);
    } finally { rendering = false; }
    while (effects.length) effects.shift()!();
  };
  const React = {
    createElement: (type: unknown, p: Record<string, any> | null, ...children: unknown[]) => ({ type, props: { ...(p || {}), children: children.flat() } }),
    Fragment: 'fragment',
    useState(initial: unknown) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [hooks[i], (value: unknown) => {
        const next = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks[i]) : value;
        if (Object.is(next, hooks[i])) return;
        hooks[i] = next;
        render();
      }];
    },
    useMemo(fn: () => unknown, deps: unknown[]) {
      const i = index++;
      if (hooks[i] && same(hooks[i].deps, deps)) return hooks[i].value;
      hooks[i] = { deps, value: fn() };
      return hooks[i].value;
    },
    useRef(initial: unknown) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useEffect(fn: () => void, deps: unknown[]) {
      const i = index++;
      if (hooks[i] && same(hooks[i].deps, deps)) return;
      hooks[i] = { deps };
      effects.push(fn);
    },
  };
  const all = (node: any, out: Element[] = []): Element[] => {
    if (Array.isArray(node)) { for (const n of node) all(n, out); return out; }
    if (!node || typeof node !== 'object') return out;
    out.push(node);
    all(node.props?.children, out);
    return out;
  };
  return {
    React,
    start() { render(); },
    setProps(next: Record<string, unknown>) { props = { ...props, ...next }; render(); },
    find: (match: (e: Element) => boolean) => all(tree).filter(match),
  };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function rig(file: string, name: string, initialProps: Record<string, unknown>, gate?: () => Promise<void>) {
  const posts: Array<Record<string, unknown>> = [];
  let m: ReturnType<typeof mount>;
  const component = (props: any) => compiled(props);
  m = mount(component, initialProps);
  const stub = () => null;
  const compiled = loadComponent(file, name, {
    React: m.React,
    api: { post: async (_url: string, body: Record<string, unknown>) => { posts.push(JSON.parse(JSON.stringify(body))); if (gate) await gate(); return { success: true, reload: { changes: [{ field: 'x', action: 'hot-inplace' }] } }; } },
    showToast: () => {},
    StatusIndicator: stub,
    disabledButtonStyle: () => null,
    secretPlaceholder: (isSet: boolean, example: string) => (isSet ? 'Set (leave blank to keep)' : example),
    BotCredentialsSection: stub,
    OAuthCredentialsSection: stub,
    InstructionCard: stub,
    window: { location: { origin: 'http://localhost:3000' } },
  });
  m.start();
  return { m, posts };
}

describe('Credentials page saves (R50-J3)', () => {
  const status = () => ({
    configured: true,
    deploymentMode: 'standalone',
    credentials: {
      ENABLE_GUILD_WEBUI: { set: true, value: 'true' }, OAUTH_CALLBACK_URL: { set: true, value: 'http://localhost:3000/auth/discord/callback' },
      MAIN_GUILD_ID: { set: false }, DATA_BACKEND: { set: true, value: 'postgres' },
      DISCORD_CLIENT_SECRET: { set: true }, SESSION_SECRET: { set: true }, DATA_BACKEND_URL: { set: true },
    },
    guildIds: {},
  });
  const props = () => ({ setupStatus: status(), isBotRunning: true, onUpdate: async () => {}, onUpdateAndRestart: async () => {} });
  const save = (m: ReturnType<typeof mount>) => m.find(e => e.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  const oauth = (m: ReturnType<typeof mount>) => m.find(e => typeof e.type === 'function' && e.props.onGenerateSecret)[0];

  it('posts only the changed fields, and a typed secret only until it is saved', async () => {
    const { m, posts } = rig('components/CredentialsPanel.jsx', 'CredentialsPanel', props());
    oauth(m).props.onChange('DISCORD_CLIENT_SECRET', 'fake-client-secret-0123456789');
    save(m);
    await flush();
    m.setProps({ setupStatus: status() });
    expect(oauth(m).props.credentials.DISCORD_CLIENT_SECRET).toBe('');
    oauth(m).props.onChange('DISCORD_CLIENT_ID', '123456789012345678');
    save(m);
    await flush();
    m.setProps({ setupStatus: status() });
    expect(oauth(m).props.credentials.DISCORD_CLIENT_ID).toBe('');
    m.find(e => typeof e.type === 'function' && e.props.isManaged !== undefined && e.props.onChange)[0].props.onChange('MAIN_GUILD_ID', '223456789012345678');
    save(m);
    await flush();
    expect(posts).toEqual([
      { DISCORD_CLIENT_SECRET: 'fake-client-secret-0123456789' },
      { DISCORD_CLIENT_ID: '123456789012345678' },
      { MAIN_GUILD_ID: '223456789012345678' },
    ]);
  });

  it('a secret typed while a save is in flight is kept and posted by the next save', async () => {
    let release = () => {};
    const gate = () => new Promise<void>(resolve => { release = resolve; });
    const { m, posts } = rig('components/CredentialsPanel.jsx', 'CredentialsPanel', props(), gate);
    oauth(m).props.onChange('DISCORD_CLIENT_SECRET', 'fake-client-secret-first-000000');
    save(m);
    await flush();
    oauth(m).props.onChange('DISCORD_CLIENT_SECRET', 'fake-client-secret-second-00000');
    release();
    await flush();
    m.setProps({ setupStatus: status() });
    expect(oauth(m).props.credentials.DISCORD_CLIENT_SECRET).toBe('fake-client-secret-second-00000');
    save(m);
    await flush();
    release();
    await flush();
    expect(posts).toEqual([
      { DISCORD_CLIENT_SECRET: 'fake-client-secret-first-000000' },
      { DISCORD_CLIENT_SECRET: 'fake-client-secret-second-00000' },
    ]);
  });

  it('a generated session secret counts as typed and is posted', async () => {
    const { m, posts } = rig('components/CredentialsPanel.jsx', 'CredentialsPanel', props());
    oauth(m).props.onGenerateSecret();
    save(m);
    await flush();
    expect(Object.keys(posts[0])).toEqual(['SESSION_SECRET']);
    expect(String(posts[0].SESSION_SECRET).length).toBe(32);
  });

  it('a saved secret input says a blank keeps it', () => {
    const { m } = rig('components/CredentialsPanel.jsx', 'CredentialsPanel', props());
    const input = m.find(e => e.type === 'input' && e.props.type === 'password')
      .find(e => String(e.props.onChange).includes('DATA_BACKEND_URL'));
    expect(input!.props.placeholder).toBe('Set (leave blank to keep)');
  });
});

describe('setup route credential writes (R44-J3)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(path.join(process.env.DATA_DIR!, '.env'), { force: true });
  });

  async function call(method: 'GET' | 'POST', url: string, body?: unknown, routes = createSetupRoutes) {
    const app = express();
    app.use(express.json());
    app.use('/api/setup', routes());
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      return await res.json() as any;
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  it('a credentials save keeps every env file key it was not sent', async () => {
    fs.writeFileSync(path.join(process.env.DATA_DIR!, '.env'),
      ['GUILD_ID=123456789012345678', 'DATA_BACKEND_URL=postgresql://fake:fake@local:5432/db', 'SOME_OTHER_KEY=kept', ''].join(String.fromCharCode(10)));
    const body = await call('POST', '/api/setup/credentials', { MAIN_GUILD_ID: '223456789012345678' });
    expect(body.success).toBe(true);
    const file = fs.readFileSync(path.join(process.env.DATA_DIR!, '.env'), 'utf-8');
    for (const line of ['MAIN_GUILD_ID=223456789012345678', 'GUILD_ID=123456789012345678', 'DATA_BACKEND_URL=postgresql://fake:fake@local:5432/db', 'SOME_OTHER_KEY=kept']) {
      expect(file.split(String.fromCharCode(10))).toContain(line);
    }
  });

  it('a save never copies a container-pinned value into the env file', async () => {
    process.env.CLIENT_ID = '323456789012345678';
    fs.writeFileSync(path.join(process.env.DATA_DIR!, '.env'), ['SOME_OTHER_KEY=kept', ''].join(String.fromCharCode(10)));
    const body = await call('POST', '/api/setup/credentials', { MAIN_GUILD_ID: '223456789012345678' });
    expect(body.success).toBe(true);
    const file = fs.readFileSync(path.join(process.env.DATA_DIR!, '.env'), 'utf-8');
    expect(file).not.toContain('CLIENT_ID');
    expect(file.split(String.fromCharCode(10))).toContain('SOME_OTHER_KEY=kept');
    expect(file.split(String.fromCharCode(10))).toContain('MAIN_GUILD_ID=223456789012345678');
  });

  it('a changed key the container env sets is named in the answer', async () => {
    process.env.SESSION_SECRET = 'fake-pinned-secret-0000000000';
    fs.writeFileSync(path.join(process.env.DATA_DIR!, '.env'), ['SOME_OTHER_KEY=kept', ''].join(String.fromCharCode(10)));
    // A fresh env loader: an earlier row's file-seeded keys would otherwise be unset as cleared.
    vi.resetModules();
    const fresh = (await import('@webui/routes/setup')).createSetupRoutes;
    const body = await call('POST', '/api/setup/credentials', { SESSION_SECRET: 'fake-new-secret-00000000000000' }, fresh);
    expect(body.success).toBe(true);
    expect(body.containerSet).toEqual([
      { field: 'SESSION_SECRET', message: 'SESSION_SECRET is set by the container environment, so it keeps its value' },
    ]);
    expect(JSON.stringify(body)).not.toContain('fake-pinned-secret');
    const file = fs.readFileSync(path.join(process.env.DATA_DIR!, '.env'), 'utf-8');
    expect(file.split(String.fromCharCode(10))).toContain('SOME_OTHER_KEY=kept');
  });
});

describe('container-set keys in the answer, fresh env loader', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(path.join(process.env.DATA_DIR!, '.env'), { force: true });
  });
  async function post(body: unknown) {
    vi.resetModules();
    const { createSetupRoutes: fresh } = await import('@webui/routes/setup');
    const app = express();
    app.use(express.json());
    app.use('/api/setup', fresh());
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/credentials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return await res.json() as any;
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  it('names a pinned key even when an older save copied the same value into the file', async () => {
    process.env.MAIN_GUILD_ID = '323456789012345678';
    fs.writeFileSync(path.join(process.env.DATA_DIR!, '.env'), ['MAIN_GUILD_ID=323456789012345678', ''].join(String.fromCharCode(10)));
    const body = await post({ MAIN_GUILD_ID: '423456789012345678' });
    expect(body.containerSet).toEqual([{ field: 'MAIN_GUILD_ID', message: 'MAIN_GUILD_ID is set by the container environment, so it keeps 323456789012345678' }]);
  });

  it('a pinned session secret changed beside another field claims no session logout and leaves the changes', async () => {
    process.env.SESSION_SECRET = 'fake-pinned-session-secret-0000';
    const body = await post({ SESSION_SECRET: 'fake-new-session-secret-000000', MAIN_GUILD_ID: '223456789012345678' });
    expect(body.success).toBe(true);
    expect(body.reload.sessionSecretChanged).toBe(false);
    expect(body.reload.changes.map((c: any) => c.field)).not.toContain('SESSION_SECRET');
    expect(body.containerSet.map((c: any) => c.field)).toEqual(['SESSION_SECRET']);
  });

  it('a pinned OAuth key claims no OAuth reconfigure', async () => {
    process.env.DISCORD_CLIENT_ID = '423456789012345678';
    const body = await post({ DISCORD_CLIENT_ID: '523456789012345678', MAIN_GUILD_ID: '223456789012345678' });
    expect(body.success).toBe(true);
    expect(body.reload.oauthReconfigured).toBe(false);
  });

  it('masks the IDs in a container-set message', async () => {
    process.env.CLIENT_ID = '623456789012345678';
    process.env.GUILD_ID = '723456789012345678';
    const body = await post({ CLIENT_ID: '823456789012345678', GUILD_ID: '923456789012345678' });
    expect(body.success).toBe(true);
    expect(body.containerSet.map((c: any) => c.message).sort()).toEqual([
      'CLIENT_ID is set by the container environment, so it keeps its value',
      'GUILD_ID is set by the container environment, so it keeps its value',
    ]);
  });
});

