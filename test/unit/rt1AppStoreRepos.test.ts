import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rt1: the App Store repository and module routes answer a refused store-docs pass with that
// refusal alone, answer a served request when the pass lets them through, and answer a StoreWriteError with its
// own status and words.

const h = vi.hoisted(() => ({
  store: {} as Record<string, any>,
  calls: [] as string[],
}));

vi.mock('../../src/utils/envLoader', async orig => {
  const real = (await import('../helpers/backendKind')).withBackendKind(await orig<any>());
  return { ...real };
});
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  return { ...real, getAppStoreManager: () => { h.calls.push('getAppStoreManager'); return h.store; } };
});

import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { StoreWriteError } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setBackendKind } from '../helpers/backendKind';

type Sent = { status: number; body: any };

function fakeRes() {
  const sent: Sent[] = [];
  let code = 200;
  const res: any = {
    status(c: number) { code = c; return res; },
    json(body: unknown) { sent.push({ status: code, body }); return res; },
  };
  return { res, sent };
}

const REFUSAL = { status: 503, error: 'the App Store docs could not be brought up to the rows: the database did not answer' };

function botWith(refusal: { status: number; error: string } | null) {
  return { storeDocsFirst: async () => refusal, migrationRunning: () => null, runSharedOp: async () => ({ success: true }) } as any;
}

async function run(bot: any, method: string, routePath: string, params: Record<string, string> = {}, body: unknown = {}) {
  const router: any = createAppStoreRoutes(bot);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  expect(layer, `route ${method} ${routePath}`).toBeDefined();
  const { res, sent } = fakeRes();
  await layer.route.stack[0].handle({ params, body, query: {} }, res, () => undefined);
  return sent;
}

const REPO = { id: 'r1', name: 'Main', url: 'https://example.invalid/mods', branch: 'main', enabled: true, githubToken: 'ghp_secret' };

const manifest = (name: string) => ({ name, displayName: name.toUpperCase(), description: 'd', version: '1.2.3', author: 'a', category: 'c' });
const MOD = { manifest: manifest('alpha'), repoId: 'r1', repoName: 'Main', installed: false, installedVersion: null };
const MOD_ANSWER = {
  name: 'alpha', displayName: 'ALPHA', description: 'd', version: '1.2.3', author: 'a', category: 'c',
  requiredIntents: [], requiredPermissions: [], hasCredentials: false, apiCredentials: null, tierRequirement: null,
  repoId: 'r1', repoName: 'Main', installed: false, installedVersion: null,
};

beforeEach(() => {
  h.store = {};
  h.calls = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

interface RefusedRoute { name: string; method: string; path: string; params: Record<string, string>; body: unknown }

const REFUSED: RefusedRoute[] = [
  { name: 'GET /bundle', method: 'get', path: '/bundle', params: {}, body: {} },
  { name: 'GET /repos', method: 'get', path: '/repos', params: {}, body: {} },
  { name: 'PUT /repos/:id', method: 'put', path: '/repos/:id', params: { id: 'r1' }, body: { name: 'Renamed' } },
  { name: 'DELETE /repos/:id', method: 'delete', path: '/repos/:id', params: { id: 'r1' }, body: {} },
  { name: 'POST /repos/:id/refresh', method: 'post', path: '/repos/:id/refresh', params: { id: 'r1' }, body: {} },
  { name: 'GET /modules', method: 'get', path: '/modules', params: {}, body: {} },
  { name: 'GET /modules/:name', method: 'get', path: '/modules/:name', params: { name: 'alpha' }, body: {} },
];

describe('rt1 a refused store-docs pass is the whole answer', () => {
  for (const r of REFUSED) {
    it(`rt1 ${r.name} answers the refusal alone and never reads the store`, async () => {
      setBackendKind('postgres');
      h.store = {
        getRepository: () => REPO,
        getRepositories: () => [REPO],
        getCachedModules: () => [MOD],
        getAvailableModules: async () => [MOD],
        getInstalledModules: () => [],
        getModuleInfo: () => MOD,
        getModuleComponents: () => [],
        updateRepositoryAwaited: async () => true,
        removeRepositoryAwaited: async () => true,
        refreshRepository: async () => [MOD],
      };
      const sent = await run(botWith(REFUSAL), r.method, r.path, r.params, r.body);
      expect(sent).toEqual([{ status: 503, body: { success: false, error: REFUSAL.error } }]);
      expect(h.calls).toEqual([]);
    });
  }
});

describe('rt1 a store-docs pass that lets the request through gets the served answer', () => {
  it('rt1 GET /repos lists the repositories with the token masked', async () => {
    setBackendKind('postgres');
    h.store = { getRepositories: () => [REPO, { ...REPO, id: 'r2', githubToken: null }] };
    const sent = await run(botWith(null), 'get', '/repos');
    expect(sent).toEqual([{
      status: 200,
      body: { success: true, repositories: [{ ...REPO, githubToken: '***' }, { ...REPO, id: 'r2', githubToken: null }] },
    }]);
  });

  it('rt1 PUT /repos/:id saves the update and answers the stored repository with the token masked', async () => {
    setBackendKind('postgres');
    const updates: unknown[] = [];
    let current: any = REPO;
    h.store = {
      getRepository: (id: string) => (id === 'r1' ? current : undefined),
      updateRepositoryAwaited: async (id: string, u: any) => { updates.push([id, u]); current = { ...current, ...u }; return true; },
    };
    const sent = await run(botWith(null), 'put', '/repos/:id', { id: 'r1' }, { name: 'Renamed' });
    expect(updates).toEqual([['r1', { name: 'Renamed' }]]);
    expect(sent).toEqual([{ status: 200, body: { success: true, repository: { ...REPO, name: 'Renamed', githubToken: '***' } } }]);
  });

  it('rt1 DELETE /repos/:id removes the repository and says so', async () => {
    setBackendKind('postgres');
    const removed: string[] = [];
    h.store = {
      getRepository: (id: string) => (id === 'r1' ? REPO : undefined),
      removeRepositoryAwaited: async (id: string) => { removed.push(id); return true; },
    };
    const sent = await run(botWith(null), 'delete', '/repos/:id', { id: 'r1' });
    expect(removed).toEqual(['r1']);
    expect(sent).toEqual([{ status: 200, body: { success: true, message: 'Repository removed' } }]);
  });

  it('rt1 POST /repos/:id/refresh answers the modules the scan found', async () => {
    setBackendKind('postgres');
    const refreshed: string[] = [];
    h.store = {
      getRepository: (id: string) => (id === 'r1' ? REPO : undefined),
      refreshRepository: async (id: string) => { refreshed.push(id); return [MOD]; },
    };
    const sent = await run(botWith(null), 'post', '/repos/:id/refresh', { id: 'r1' });
    expect(refreshed).toEqual(['r1']);
    expect(sent).toEqual([{ status: 200, body: { success: true, modules: [MOD_ANSWER] } }]);
  });

  it('rt1 GET /modules answers the available modules', async () => {
    setBackendKind('postgres');
    h.store = { getAvailableModules: async () => [MOD] };
    const sent = await run(botWith(null), 'get', '/modules');
    expect(sent).toEqual([{ status: 200, body: { success: true, modules: [MOD_ANSWER] } }]);
  });

  it('rt1 GET /modules/:name answers the module with its components', async () => {
    setBackendKind('file');
    h.store = { getModuleInfo: (n: string) => (n === 'alpha' ? MOD : null), getModuleComponents: () => [{ kind: 'command', name: 'ping' }] };
    const sent = await run(botWith(null), 'get', '/modules/:name', { name: 'alpha' });
    expect(sent).toEqual([{ status: 200, body: { success: true, module: { ...MOD_ANSWER, components: [{ kind: 'command', name: 'ping' }] } } }]);
  });

  it('rt1 GET /modules/:name answers 404 for a module no repository holds', async () => {
    setBackendKind('file');
    h.store = { getModuleInfo: () => null };
    const sent = await run(botWith(null), 'get', '/modules/:name', { name: 'ghost' });
    expect(sent).toEqual([{ status: 404, body: { success: false, error: 'Module not found' } }]);
  });
});

const CONFLICT = 'BRAVO saved another version first; nothing was saved';

describe('rt1 a StoreWriteError is answered with its own status and words', () => {
  it('rt1 POST /repos answers the 409 of the add', async () => {
    setBackendKind('file');
    h.store = {
      normalizeGitUrl: (url: string) => ({ url, branch: null }),
      testRepoAccess: () => ({ ok: true }),
      addRepositoryAwaited: async () => { throw new StoreWriteError(409, CONFLICT, 'BRAVO'); },
    };
    const sent = await run(botWith(null), 'post', '/repos', {}, { name: 'Main', url: 'https://example.invalid/mods' });
    expect(sent).toEqual([{ status: 409, body: { success: false, error: CONFLICT } }]);
  });

  it('rt1 PUT /repos/:id answers the 409 of the update', async () => {
    setBackendKind('file');
    h.store = {
      getRepository: () => REPO,
      updateRepositoryAwaited: async () => { throw new StoreWriteError(409, CONFLICT, 'BRAVO'); },
    };
    const sent = await run(botWith(null), 'put', '/repos/:id', { id: 'r1' }, { name: 'Renamed' });
    expect(sent).toEqual([{ status: 409, body: { success: false, error: CONFLICT } }]);
  });

  it('rt1 DELETE /repos/:id answers the 409 of the removal', async () => {
    setBackendKind('file');
    h.store = {
      getRepository: () => REPO,
      removeRepositoryAwaited: async () => { throw new StoreWriteError(409, CONFLICT, 'BRAVO'); },
    };
    const sent = await run(botWith(null), 'delete', '/repos/:id', { id: 'r1' });
    expect(sent).toEqual([{ status: 409, body: { success: false, error: CONFLICT } }]);
  });

  it('rt1 PUT /repos/:id answers a plain failure as 500 with its message', async () => {
    setBackendKind('file');
    h.store = { getRepository: () => REPO, updateRepositoryAwaited: async () => { throw new Error('disk full'); } };
    const sent = await run(botWith(null), 'put', '/repos/:id', { id: 'r1' }, { name: 'Renamed' });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'disk full' } }]);
  });

  it('rt1 DELETE /repos/:id answers a plain failure as 500 with its message', async () => {
    setBackendKind('file');
    h.store = { getRepository: () => REPO, removeRepositoryAwaited: async () => { throw new Error('disk full'); } };
    const sent = await run(botWith(null), 'delete', '/repos/:id', { id: 'r1' });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'disk full' } }]);
  });
});
