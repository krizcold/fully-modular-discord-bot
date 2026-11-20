import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<object>()),
  getPaymentRegistry: () => ({ get: (id: string) => (id === 'patreon' ? { handleOAuthCallback: async () => ({}) } : undefined) }),
}));

import { securityHeaders } from '../../src/webui/securityHeaders';
import { BUILT_DIR, BUILT_FILES, MISSING_BUILD_MESSAGE, missingBuiltFiles, mountFrontendBuild, requireFrontendBuild } from '../../src/webui/frontendBuild';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';

// S3: the web panel's scripts are built ahead with esbuild (scripts/buildFrontend.cjs), the pages load only
// same-origin script files, and the server's policy is script-src 'self'.

const require = createRequire(import.meta.url);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC = path.join(REPO, 'src/webui/public');
const frontend = require(path.join(REPO, 'scripts/buildFrontend.cjs')) as {
  ADMIN_FILES: string[];
  GUILD_FILES: string[];
  OUTPUT_FILES: string[];
  build: (outDir: string) => Promise<void>;
};

let outDir = '';
const built = (rel: string) => fs.readFileSync(path.join(outDir, rel), 'utf-8');

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), `${prefix}${e.name}/`));
    else out.push(`${prefix}${e.name}`);
  }
  return out;
}

async function served(mount: (app: express.Express) => void, route: string): Promise<{ status: number; type: string; text: string }> {
  const app = express();
  mount(app);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`, { redirect: 'manual' });
    return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-frontend-'));
  await frontend.build(outDir);
});

afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

function element(): any {
  const el: any = {
    style: {},
    children: [] as any[],
    className: '',
    textContent: '',
    classList: { add() {}, remove() {} },
    appendChild(child: any) { el.children.push(child); child.parentNode = el; return child; },
    addEventListener() {},
    setAttribute() {},
    remove() {},
  };
  return el;
}

/** A page's globals, enough for the scripts' top-level code: nothing here draws. */
function pageContext() {
  const calls = { render: 0, createRoot: 0, rootRender: 0 };
  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    Fragment: 'fragment',
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (f: () => unknown) => f(),
  };
  const ReactDOM = {
    render: () => { calls.render++; },
    createRoot: () => { calls.createRoot++; return { render: () => { calls.rootRender++; } }; },
  };
  const document = {
    getElementById: () => element(),
    createElement: () => element(),
    querySelector: () => null,
    addEventListener() {},
    head: element(),
    body: element(),
    readyState: 'complete',
  };
  class WebSocket {
    send() {}
    close() {}
  }
  const ctx: any = {
    React, ReactDOM, document, WebSocket, console,
    location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', pathname: '/', search: '', href: 'http://localhost/' },
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { pushState() {}, replaceState() {} },
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {},
  };
  ctx.window = ctx;
  return { ctx: vm.createContext(ctx), calls };
}

describe('the build', () => {
  it('writes exactly assets/vendor.js, assets/guild.js and admin.js', () => {
    expect(walk(outDir).sort()).toEqual(['admin.js', 'assets/guild.js', 'assets/vendor.js']);
    expect([...frontend.OUTPUT_FILES].sort()).toEqual(['admin.js', 'assets/guild.js', 'assets/vendor.js']);
    for (const f of frontend.OUTPUT_FILES) expect(fs.statSync(path.join(outDir, f)).size, f).toBeGreaterThan(0);
  });

  it('finds every listed source file', () => {
    for (const f of [...frontend.ADMIN_FILES, ...frontend.GUILD_FILES]) expect(fs.existsSync(path.join(PUBLIC, f)), f).toBe(true);
  });

  it('lists no file twice in one bundle', () => {
    expect(new Set(frontend.ADMIN_FILES).size).toBe(frontend.ADMIN_FILES.length);
    expect(new Set(frontend.GUILD_FILES).size).toBe(frontend.GUILD_FILES.length);
  });

  it('builds the member bundle only from files under public/assets/', () => {
    expect(frontend.GUILD_FILES.filter(f => !f.startsWith('assets/'))).toEqual([]);
    expect(frontend.GUILD_FILES[0]).toBe('assets/utils/guildApi.js');
    expect(frontend.GUILD_FILES[frontend.GUILD_FILES.length - 1]).toBe('assets/guildApp.jsx');
  });

  it('orders the admin bundle: api.js, graveyardRestore.js, the other utilities, toast.js, the components, app.jsx last', () => {
    const at = (f: string) => {
      const i = frontend.ADMIN_FILES.indexOf(f);
      expect(i, f).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(frontend.ADMIN_FILES.slice(0, 5)).toEqual(['utils/api.js', 'utils/graveyardRestore.js', 'utils/websocket.js',
      'utils/discordFormatters.js', 'utils/toast.js']);
    expect(at('utils/api.js')).toBeLessThan(at('utils/graveyardRestore.js'));
    expect(at('assets/utils/uiHelpers.jsx')).toBe(5);
    expect(at('components/premium/PremiumComponents.jsx')).toBeLessThan(at('components/AppStorePanel.jsx'));
    expect(at('app.jsx')).toBe(frontend.ADMIN_FILES.length - 1);
    expect(frontend.ADMIN_FILES).toHaveLength(29);
  });

  it('names no CDN in any output', () => {
    for (const f of frontend.OUTPUT_FILES) expect(built(f).includes('unpkg.com'), f).toBe(false);
  });

  it('leaves no JSX and no module syntax in the two page bundles', () => {
    for (const f of ['admin.js', 'assets/guild.js']) {
      expect(() => new vm.Script(built(f), { filename: f })).not.toThrow();
      expect(built(f)).toContain('React.createElement(');
    }
  });

  it('admin.js runs as one classic script and mounts the admin page once', () => {
    const { ctx, calls } = pageContext();
    new vm.Script(built('admin.js'), { filename: 'admin.js' }).runInContext(ctx);
    expect(calls).toEqual({ render: 1, createRoot: 0, rootRender: 0 });
    expect(typeof ctx.showToast).toBe('function');
    expect(typeof vm.runInContext('typeof api === "object" && typeof restoreNextStep', ctx)).toBe('string');
    expect(vm.runInContext('typeof restoreNextStep', ctx)).toBe('function');
    expect(vm.runInContext('typeof module', ctx)).toBe('undefined');
  });

  it('guild.js runs as one classic script and mounts the member page once', () => {
    const { ctx, calls } = pageContext();
    new vm.Script(built('assets/guild.js'), { filename: 'guild.js' }).runInContext(ctx);
    expect(calls).toEqual({ render: 0, createRoot: 1, rootRender: 1 });
    expect(vm.runInContext('typeof guildApi', ctx)).toBe('object');
  });

  it('vendor.js sets React 18 and ReactDOM with render and createRoot on window', () => {
    const ctx: any = { console, setTimeout, clearTimeout, MessageChannel, performance };
    ctx.window = ctx;
    ctx.self = ctx;
    vm.createContext(ctx);
    new vm.Script(built('assets/vendor.js'), { filename: 'vendor.js' }).runInContext(ctx);
    expect(String(ctx.React.version)).toMatch(/^18\./);
    expect(typeof ctx.React.createElement).toBe('function');
    expect(typeof ctx.ReactDOM.render).toBe('function');
    expect(typeof ctx.ReactDOM.createRoot).toBe('function');
  });
});

describe('utils/toast.js', () => {
  function loadToast() {
    const container = element();
    const timers: Array<{ ms: number }> = [];
    const ctx: any = {
      document: { getElementById: (id: string) => (id === 'toast-container' ? container : null), createElement: () => element() },
      setTimeout: (_f: () => void, ms: number) => { timers.push({ ms }); return timers.length; },
      clearTimeout() {},
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'utils/toast.js'), 'utf-8'), ctx);
    return { showToast: ctx.showToast as (message: string, type?: string, opts?: unknown) => void, container, timers };
  }

  it('appends one element with the type as its class and the message as its text', () => {
    const { showToast, container, timers } = loadToast();
    showToast('x', 'error');
    expect(container.children).toHaveLength(1);
    expect(container.children[0].className).toBe('toast toast-error');
    expect(container.children[0].textContent).toBe('x');
    expect(container.children[0].children).toHaveLength(0);
    expect(timers).toEqual([{ ms: 10000 }]);
  });

  it('defaults to an info toast of 6 seconds', () => {
    const { showToast, container, timers } = loadToast();
    showToast('y');
    expect(container.children[0].className).toBe('toast toast-info');
    expect(timers).toEqual([{ ms: 6000 }]);
  });

  it('gives a sticky toast the close mark and no timer', () => {
    const { showToast, container, timers } = loadToast();
    showToast('z', 'warning', { sticky: true });
    const el = container.children[0];
    expect(el.className).toBe('toast toast-warning toast-sticky');
    expect(el.children).toHaveLength(1);
    expect(el.children[0].textContent).toBe(` ${String.fromCharCode(0xd7)}`);
    expect(timers).toEqual([]);
  });
});

describe('the pages', () => {
  const page = (name: string) => fs.readFileSync(path.join(PUBLIC, name), 'utf-8');
  const scripts = (html: string) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({ attrs: m[1], body: m[2] }));
  const srcOf = (attrs: string) => /\ssrc="([^"]*)"/.exec(attrs)?.[1];
  const loads = (html: string) => [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map(m => m[1]);

  it.each(['index.html', 'guild.html'])('%s has only script tags with a same-origin src and no body', name => {
    const tags = scripts(page(name));
    expect(tags.length).toBeGreaterThan(0);
    expect(page(name).match(/<script\b/g)).toHaveLength(tags.length);
    for (const tag of tags) {
      expect(srcOf(tag.attrs), tag.attrs).toMatch(/^\/[^/]/);
      expect(tag.body).toBe('');
      expect(tag.attrs.trim()).toBe(`src="${srcOf(tag.attrs)}"`);
    }
  });

  it.each(['index.html', 'guild.html'])('%s has no text/babel tag, no inline handler and no other origin', name => {
    const html = page(name);
    expect(html).not.toMatch(/text\/babel/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(loads(html).filter(u => !/^\/[^/]/.test(u))).toEqual([]);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('index.html loads vendor.js, build-info.js and admin.js, in that order', () => {
    expect(scripts(page('index.html')).map(t => srcOf(t.attrs))).toEqual(['/assets/vendor.js', '/build-info.js', '/admin.js']);
  });

  it('guild.html loads vendor.js then guild.js, and every file it names is under /assets/', () => {
    expect(scripts(page('guild.html')).map(t => srcOf(t.attrs))).toEqual(['/assets/vendor.js', '/assets/guild.js']);
    expect(loads(page('guild.html')).filter(u => !u.startsWith('/assets/'))).toEqual([]);
  });

  it.each(['index.html', 'guild.html'])('%s loads no script the build does not write, build-info.js aside', name => {
    for (const tag of scripts(page(name))) {
      const src = srcOf(tag.attrs)!;
      if (src === '/build-info.js') continue;
      expect(frontend.OUTPUT_FILES, src).toContain(src.slice(1));
      expect(fs.existsSync(path.join(outDir, src.slice(1))), src).toBe(true);
    }
  });

  it('keeps the elements the scripts mount into', () => {
    expect(page('index.html')).toContain('<div id="toast-container"></div>');
    expect(page('index.html')).toContain('<div id="root"></div>');
    expect(page('guild.html')).toContain('<div id="root"></div>');
  });
});

describe('the security headers', () => {
  function policy(): Record<string, string> {
    const headers: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); },
      getHeader: (name: string) => headers[name.toLowerCase()],
      removeHeader(name: string) { delete headers[name.toLowerCase()]; },
    };
    let nextArgs: unknown[] | undefined;
    securityHeaders()({ method: 'GET', url: '/', headers: {} } as never, res as never, (...args: unknown[]) => { nextArgs = args; });
    expect(nextArgs).toEqual([]);
    return headers;
  }
  const directives = (header: string) => Object.fromEntries(header.split(';').map(d => d.trim()).filter(Boolean).map(d => {
    const [name, ...values] = d.split(/\s+/);
    return [name, values.join(' ')];
  }));

  it("sends script-src 'self' and nothing else in that directive", () => {
    const csp = directives(policy()['content-security-policy']);
    expect(csp['script-src']).toBe("'self'");
    expect(csp['script-src-attr']).toBe("'none'");
    expect(csp['script-src-elem']).toBeUndefined();
  });

  it('names no unsafe-eval and no CDN, and unsafe-inline only for styles', () => {
    const header = policy()['content-security-policy'];
    expect(header).not.toContain('unsafe-eval');
    expect(header).not.toContain('unpkg');
    expect(header.split("'unsafe-inline'")).toHaveLength(2);
  });

  it('keeps the other directives', () => {
    const csp = directives(policy()['content-security-policy']);
    expect(csp['default-src']).toBe("'self'");
    expect(csp['style-src']).toBe("'self' 'unsafe-inline'");
    expect(csp['img-src']).toBe("'self' data: https:");
    expect(csp['connect-src']).toBe("'self' ws: wss:");
    expect(csp['font-src']).toBe("'self'");
    expect(csp['object-src']).toBe("'none'");
    expect(csp).toHaveProperty('upgrade-insecure-requests', '');
  });

  it('keeps the frame and transport headers', () => {
    const headers = policy();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains; preload');
  });
});

describe('the missing-build answer', () => {
  const MESSAGE = 'The web panel\'s scripts are not built. Run "npm run build:webui" in the bot\'s folder and reload this page. In Docker, rebuild the image.';
  let empty = '';
  beforeAll(() => { empty = fs.mkdtempSync(path.join(os.tmpdir(), 's3-empty-')); });
  afterAll(() => { if (empty) fs.rmSync(empty, { recursive: true, force: true }); });

  function run(dir: string, method: string, p: string) {
    const out: { status?: number; type?: string; body?: unknown; next: number } = { next: 0 };
    const res = {
      status(code: number) { out.status = code; return res; },
      type(t: string) { out.type = t; return res; },
      send(body: unknown) { out.body = body; return res; },
    };
    requireFrontendBuild(dir)({ method, path: p } as never, res as never, () => { out.next++; });
    return out;
  }

  it('says where to build, in plain ASCII', () => {
    expect(MISSING_BUILD_MESSAGE).toBe(MESSAGE);
    expect(MESSAGE).toMatch(/^[\x20-\x7e]+$/);
  });

  it('lists the three files the build writes', () => {
    expect([...BUILT_FILES].sort()).toEqual([...frontend.OUTPUT_FILES].sort());
    expect(missingBuiltFiles(empty).sort()).toEqual([...BUILT_FILES].sort());
    expect(missingBuiltFiles(outDir)).toEqual([]);
    expect(missingBuiltFiles(path.join(empty, 'absent'))).toHaveLength(3);
  });

  it('looks for the built files at the package root', () => {
    expect(path.normalize(BUILT_DIR)).toBe(path.join(REPO, 'webui-built'));
  });

  it.each(['/', '/guild', '/guild/1/subscription', '/credentials', '/credentials/'])('answers GET %s with 503 and the plain text', p => {
    expect(run(empty, 'GET', p)).toEqual({ status: 503, type: 'text/plain', body: MESSAGE, next: 0 });
  });

  it.each([
    ['GET', '/assets/x'], ['GET', '/assets'], ['GET', '/auth/x'], ['GET', '/auth'], ['GET', '/admin.js'], ['GET', '/a%20b'],
    ['POST', '/'], ['PUT', '/credentials'], ['DELETE', '/guild'],
  ])('lets %s %s pass', (method, p) => {
    expect(run(empty, method, p)).toEqual({ next: 1 });
  });

  it('answers 503 while any one file is absent, and passes once all three are there', () => {
    const dir = fs.mkdtempSync(path.join(empty, 'partial-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    for (const f of BUILT_FILES) {
      expect(run(dir, 'GET', '/').status, f).toBe(503);
      fs.writeFileSync(path.join(dir, f), 'x');
    }
    expect(run(dir, 'GET', '/')).toEqual({ next: 1 });
  });

  it.each(['/', '/guild', '/guild/1/subscription', '/credentials', '/assets/x', '/auth/x'])('with the three files present GET %s passes', p => {
    expect(run(outDir, 'GET', p)).toEqual({ next: 1 });
  });

  it('with the three files present a POST passes', () => {
    expect(run(outDir, 'POST', '/')).toEqual({ next: 1 });
  });
});

describe('the built files on a bare app', () => {
  let empty = '';
  beforeAll(() => { empty = fs.mkdtempSync(path.join(os.tmpdir(), 's3-mount-')); });
  afterAll(() => { if (empty) fs.rmSync(empty, { recursive: true, force: true }); });

  const mount = (dir: string) => (app: express.Express) => {
    mountFrontendBuild(app, dir);
    app.get('/', (_req, res) => { res.status(200).type('text/plain').send('the page route'); });
  };

  it('with the three files present serves /admin.js and lets the page request through', async () => {
    const script = await served(mount(outDir), '/admin.js');
    expect(script.status).toBe(200);
    expect(script.text).toBe(built('admin.js'));
    expect(await served(mount(outDir), '/')).toMatchObject({ status: 200, text: 'the page route' });
  });

  it('with an empty folder answers the page request 503 and leaves a missing script to the next handler', async () => {
    const page = await served(mount(empty), '/');
    expect(page.status).toBe(503);
    expect(page.type).toMatch(/^text\/plain/);
    expect(page.text).toBe(MISSING_BUILD_MESSAGE);
    expect((await served(mount(empty), '/assets/vendor.js')).status).toBe(404);
  });
});

describe('the Patreon callback failure page', () => {
  it('holds no script: no javascript: link, no script tag, no event attribute', async () => {
    const manager = { runSharedOp: async () => ({ ok: false, code: 'invalid', error: 'The code was refused' }) };
    const page = await served(app => app.use('/guild/api/subscriptions', createGuildSubscriptionRoutes(manager as never)),
      '/guild/api/subscriptions/patreon/callback?code=abc&state=1');
    expect(page.status).toBe(400);
    expect(page.type).toMatch(/^text\/html/);
    expect(page.text).toContain('Patreon link failed');
    expect(page.text).not.toMatch(/javascript:/i);
    expect(page.text).not.toMatch(/<script/i);
    expect(page.text).not.toMatch(/\son\w+\s*=/i);
    expect(page.text).toContain('<a href="/guild">Back to the server page</a>');
  });
});
