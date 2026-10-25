import fs from 'fs';
import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  installed: [] as any[],
  moduleCheck: { updatesAvailable: 0, updates: [], errors: [] } as any,
  updaterType: 'managed',
  status: { inProgress: false } as any,
  combined: null as any,
}));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', () => ({
  getAppStoreManager: () => ({
    getInstalledModules: () => h.installed,
    checkAllModulesForUpdates: async () => h.moduleCheck,
  }),
}));

vi.mock('../../src/updater/index', async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    getUpdaterType: () => h.updaterType,
    getUpdateStatus: () => ({ ...h.status }),
    checkForAllUpdates: async () => h.combined,
  };
});

const repo = new URL('../../', import.meta.url);
const read = (rel: string) => fs.readFileSync(new URL(rel, repo), 'utf-8');

function fakeResponse(mod: any, statusCode: number, body: string) {
  return vi.spyOn(mod, 'request').mockImplementation(((_opts: any, cb: any) => {
    const req: any = new EventEmitter();
    req.write = () => {};
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      const res: any = new EventEmitter();
      res.statusCode = statusCode;
      cb(res);
      res.emit('data', body);
      res.emit('end');
    };
    return req;
  }) as any);
}

async function loadManaged() {
  vi.resetModules();
  process.env.BOT_ID = 'b1';
  process.env.BOT_MANAGER_UPDATE_TOKEN = 't1';
  process.env.BOT_MANAGER_INTERNAL_URL = 'http://manager.test:8080';
  return await import('../../updaters/updater_managed/index');
}

async function loadLocal() {
  vi.resetModules();
  process.env.GITHUB_REPO = 'owner/repo';
  return await import('../../updaters/updater_local/index');
}

beforeEach(() => {
  h.installed = [];
  h.moduleCheck = { updatesAvailable: 0, updates: [], errors: [] };
});
afterEach(() => { vi.restoreAllMocks(); });

describe('C12-1 the managed updater reports what the manager answered', () => {
  it('treats a body with success:false or checked:false as a failed check and passes its message on', async () => {
    const u = await loadManaged();
    fakeResponse(http, 200, JSON.stringify({ success: false, checked: false, message: 'git fetch failed' }));
    const r = await u.checkForUpdates();
    expect(r.success).toBe(false);
    expect(r.error).toContain('git fetch failed');
    expect(u.getUpdateStatus().lastCheck).toBeUndefined();
  });

  it('treats a body that is not an object as a failed check', async () => {
    const u = await loadManaged();
    fakeResponse(http, 200, 'not json');
    const r = await u.checkForUpdates();
    expect(r.success).toBe(false);
  });

  it('clears the error slot on the next successful check and sets lastCheck only then', async () => {
    const u = await loadManaged();
    fakeResponse(http, 500, JSON.stringify({ error: 'down' }));
    await u.checkForUpdates();
    expect(u.getUpdateStatus().lastError).toBeTruthy();
    expect(u.getUpdateStatus().lastCheck).toBeUndefined();
    vi.restoreAllMocks();
    fakeResponse(http, 200, JSON.stringify({ success: true, checked: true, hasUpdates: false, behindBy: 0 }));
    const r = await u.checkForUpdates();
    expect(r.success).toBe(true);
    expect(u.getUpdateStatus().lastError).toBeUndefined();
    expect(u.getUpdateStatus().lastCheck).toBeTypeOf('number');
  });

  it('clears the error slot when a trigger is accepted', async () => {
    const u = await loadManaged();
    fakeResponse(http, 500, JSON.stringify({ error: 'down' }));
    await u.triggerUpdate();
    expect(u.getUpdateStatus().lastError).toBeTruthy();
    vi.restoreAllMocks();
    fakeResponse(http, 200, JSON.stringify({ success: true }));
    expect((await u.triggerUpdate()).success).toBe(true);
    expect(u.getUpdateStatus().lastError).toBeUndefined();
  });

  it('marks the base code unchecked and the whole check failed when the manager call fails', async () => {
    const u = await loadManaged();
    fakeResponse(http, 502, JSON.stringify({ error: 'bad gateway' }));
    const r = await u.checkForAllUpdates();
    expect(r.baseCode.checked).toBe(false);
    expect(r.baseCode.error).toBeTruthy();
    expect(r.success).toBe(false);
    expect(r.partial).toBe(true);
  });

  it('marks the check partial when some modules could not be checked', async () => {
    const u = await loadManaged();
    fakeResponse(http, 200, JSON.stringify({ success: true, checked: true, hasUpdates: false, behindBy: 0 }));
    h.installed = [{ name: 'a' }, { name: 'b' }];
    h.moduleCheck = { updatesAvailable: 0, updates: [], errors: [{ moduleName: 'b', error: 'Repository r not found' }] };
    const r = await u.checkForAllUpdates();
    expect(r.modules.unchecked).toBe(1);
    expect(r.partial).toBe(true);
    expect(r.success).toBe(false);
  });

  it('the tracked src/updater copy equals updater_managed', () => {
    expect(read('src/updater/index.ts')).toBe(read('updaters/updater_managed/index.ts'));
  });
});

describe('C12-1 the local updater compares a release or says it cannot', () => {
  it('a 404 is a failed check that names the repository', async () => {
    const u = await loadLocal();
    fakeResponse(https, 404, '{}');
    const r = await u.checkForUpdates();
    expect(r.success).toBe(false);
    expect(r.error).toBe('No release is published for owner/repo; cannot compare');
  });

  it('a success names the release it compared against', async () => {
    const u = await loadLocal();
    fakeResponse(https, 200, JSON.stringify({ tag_name: 'v0.0.0' }));
    const r = await u.checkForUpdates();
    expect(r.success).toBe(true);
    expect(r.message).toBe('No newer release than 0.0.0');
    expect(u.getUpdateStatus().lastCheck).toBeTypeOf('number');
  });

  it('a failed check leaves lastCheck unset and fills lastError; a success clears it', async () => {
    const u = await loadLocal();
    fakeResponse(https, 500, '{}');
    await u.checkForUpdates();
    expect(u.getUpdateStatus().lastCheck).toBeUndefined();
    expect(u.getUpdateStatus().lastError).toBeTruthy();
    vi.restoreAllMocks();
    fakeResponse(https, 200, JSON.stringify({ tag_name: 'v0.0.0' }));
    await u.checkForUpdates();
    expect(u.getUpdateStatus().lastError).toBeUndefined();
  });

  it('marks the base code unchecked when no release exists', async () => {
    const u = await loadLocal();
    fakeResponse(https, 404, '{}');
    const r = await u.checkForAllUpdates();
    expect(r.baseCode.checked).toBe(false);
    expect(r.success).toBe(false);
    expect(r.partial).toBe(true);
  });
});

function combined(over: any = {}): any {
  return {
    success: true,
    partial: false,
    lastChecked: '2026-10-25T10:00:00.000Z',
    baseCode: { checked: true, hasUpdates: false, ...(over.baseCode || {}) },
    modules: { checked: true, hasUpdates: false, totalInstalled: 2, updatesAvailable: 0, unchecked: 0, updates: [], errors: [], ...(over.modules || {}) },
    summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false },
    ...(over.top || {}),
  };
}

async function loadPanel() {
  vi.resetModules();
  return await import('../../src/bot/internalSetup/panels/updateManager');
}

const ctx = (accessMethod: any = 'direct_command'): any => ({
  client: null, interaction: null, panelId: 'update_manager', userId: 'u1', guildId: 'g1', accessMethod, navigationStack: [],
});
const text = (r: any) => JSON.stringify(r);

describe('C12-1 the update panel shows the last real result', () => {
  beforeEach(() => { h.updaterType = 'managed'; h.status = { inProgress: false }; h.combined = null; });

  it('says "Could not check" per unchecked section and never "Up to Date" beside it', async () => {
    const p = await loadPanel();
    const r = p.buildPanelView(ctx(), 'main', combined({
      top: { success: false, partial: true },
      baseCode: { checked: false, error: 'Bot Manager returned 502' },
      modules: { unchecked: 1, errors: [{ moduleName: 'b', error: 'Repository r not found' }] },
    }));
    const t = text(r);
    expect(t).toContain('Could not check: Bot Manager returned 502');
    expect(t).toContain('Could not check b: Repository r not found');
    expect(t).not.toContain('Up to Date');
    expect(t).not.toContain('All modules up to date');
  });

  it('does not read Up to Date from a bare lastCheck with no result', async () => {
    h.status = { inProgress: false, lastCheck: Date.now() };
    const p = await loadPanel();
    const t = text(p.buildPanelView(ctx(), 'main'));
    expect(t).not.toContain('Up to Date');
    expect(t).toContain('Not checked yet');
  });

  it('renders main from the last result when no result is passed', async () => {
    const p = await loadPanel();
    p.buildPanelView(ctx(), 'main', combined({ modules: { updatesAvailable: 1, hasUpdates: true, updates: [{ moduleName: 'm1', hasUpdate: true, installedVersion: '1.0.0', availableVersion: '1.1.0' }] }, top: { summary: { totalUpdatesAvailable: 1, hasAnyUpdates: true } } }));
    const t = text(p.buildPanelView(ctx(), 'main'));
    expect(t).toContain('m1: 1.0.0');
  });

  it('the web UI open runs the check and renders its result, not Checking...', async () => {
    h.combined = combined();
    const p = await loadPanel();
    const r = await p.default.callback(ctx('web_ui'));
    const t = text(r);
    expect(t).not.toContain('Checking...');
    expect(t).toContain('Up to Date');
  });

  it('words the system update for a self-hosted bot without the Bot Manager', async () => {
    h.updaterType = 'local';
    const p = await loadPanel();
    const t = text(p.buildPanelView(ctx(), 'updating_system'));
    expect(t).not.toContain('Bot Manager');
    const t2 = text(p.buildPanelView(ctx(), 'main', combined({ baseCode: { hasUpdates: true }, top: { summary: { totalUpdatesAvailable: 1, hasAnyUpdates: true } } })));
    expect(t2).toContain('Apply it by hand');
  });
});

describe('C12-1 shipped artefacts', () => {
  it('CI type-checks both shipped updaters', () => {
    const wf = read('.github/workflows/docker-publish.yml');
    expect(wf).toContain('tsconfig.updaters.json');
    const cfg = JSON.parse(read('tsconfig.updaters.json'));
    expect(cfg.include).toEqual(expect.arrayContaining(['updaters']));
  });

  it('the managed CI type-check also compiles the callers against updater_local', () => {
    const wf = read('.github/workflows/docker-publish.yml');
    expect(wf).toContain('tsconfig.updater-local.json');
    const cfg = JSON.parse(read('tsconfig.updater-local.json'));
    expect(cfg.compilerOptions.paths['@/updater']).toEqual(['updaters/updater_local/index.ts']);
  });
});

// fix round 1
function renderUpdateStatus(checkResult: any): any {
  const src = ts.transpileModule(read('src/webui/public/components/update/UpdateStatus.jsx'), {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const states = [false, checkResult, null];
  let i = 0;
  const React = {
    useState: () => [states[i++], () => {}],
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  };
  const fn = new Function('React', 'disabledButtonStyle', src + '\nreturn UpdateStatus;')(React, () => ({}));
  return fn({ api: {}, status: { bot: { running: true }, safety: {} }, onRefresh: () => {} });
}
function findAll(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}
const textOf = (n: any): string => (n == null || n === false || n === true) ? '' : typeof n !== 'object' ? String(n) : (n.children || []).map(textOf).join('');
const badges = (tree: any) => findAll(tree, n => typeof n.props.className === 'string' && n.props.className.includes('update-badge')).map(textOf);
const button = (tree: any, label: string) => findAll(tree, n => n.type === 'button' && textOf(n).includes(label))[0];

describe('C12-1 fix round 1', () => {
  beforeEach(() => { h.updaterType = 'managed'; h.status = { inProgress: false }; h.combined = null; });

  it('a web UI open whose check fails says Could not check, not Not checked yet or an old result', async () => {
    const p = await loadPanel();
    p.buildPanelView(ctx(), 'main', combined());
    h.combined = null;
    const t = text(await p.default.callback(ctx('web_ui')));
    expect(t).toContain('Could not check');
    expect(t).not.toContain('Up to Date');
    expect(t).not.toContain('Not checked yet');
  });

  it('the self-hosted refusal names the steps per deployment and never a plain restart', async () => {
    const u = await loadLocal();
    const e = (await u.triggerUpdate()).error || '';
    expect(e).toContain('sudo ./setup.sh');
    expect(e).toContain('docker compose -f docker-compose.standalone.yml up -d --build');
    expect(e).toMatch(/recreate the container/);
    expect(e).not.toMatch(/and restart the bot/);
  });

  it('the managed trigger clears lastError once', () => {
    const src = read('updaters/updater_managed/index.ts');
    expect(src).not.toMatch(/updateStatus\.lastError = undefined;\s*\n\s*updateStatus\.lastError = undefined;/);
  });

  it('the web Update tab renders Could not check badges for unchecked sections, never Up to date', () => {
    const tree = renderUpdateStatus(combined({
      top: { success: false, partial: true, updaterType: 'managed' },
      baseCode: { checked: false, error: 'Bot Manager returned 502' },
      modules: { unchecked: 1, errors: [{ moduleName: 'b', error: 'Repository r not found' }] },
    }));
    const b = badges(tree);
    expect(b).toEqual(['Could not check', 'Could not check']);
    expect(textOf(tree)).not.toContain('Up to date');
  });

  it('the web Update tab words the Update System and Update Everything titles by updater type', () => {
    const withUpdates = (updaterType: string) => combined({
      top: { updaterType, summary: { totalUpdatesAvailable: 2, hasAnyUpdates: true } },
      baseCode: { hasUpdates: true },
      modules: { hasUpdates: true, updatesAvailable: 1, updates: [{ moduleName: 'm1', hasUpdate: true, installedVersion: '1.0.0', availableVersion: '1.1.0' }] },
    });
    const m = renderUpdateStatus(withUpdates('managed'));
    const l = renderUpdateStatus(withUpdates('local'));
    expect(button(m, 'Update System').props.title).toContain('Bot Manager');
    expect(button(l, 'Update System').props.title).not.toContain('Bot Manager');
    expect(button(m, 'Update Everything').props.title).toBe('Update modules then restart with new system code');
    expect(button(l, 'Update Everything').props.title).not.toContain('restart');
    expect(button(l, 'Update Everything').props.title).toContain('by hand');
  });
});
