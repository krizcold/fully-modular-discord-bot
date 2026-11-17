import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regate chunk sc1: the App Store repository add, update and remove routes and the module detail route answer an
// operator exactly once, with the refusal, the missing repository, the failed save or the thrown error in words.

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
import { SharedOpAnswered } from '../../src/webui/routes/hopFailure';
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

beforeEach(() => {
  h.store = {};
  h.calls = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('sc1 POST /repos with a refused store-docs pass', () => {
  it('sc1 POST /repos answers the refusal alone and never adds the repository', async () => {
    setBackendKind('postgres');
    const added: unknown[] = [];
    h.store = {
      normalizeGitUrl: (url: string) => ({ url, branch: null }),
      testRepoAccess: () => ({ ok: true }),
      addRepositoryAwaited: async (...args: unknown[]) => { added.push(args); return REPO; },
      refreshRepository: async () => [],
    };
    const sent = await run(botWith(REFUSAL), 'post', '/repos', {}, { name: 'Main', url: REPO.url });
    expect(sent).toEqual([{ status: 503, body: { success: false, error: REFUSAL.error } }]);
    expect(added).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});

describe('sc1 PUT /repos/:id', () => {
  it('sc1 PUT answers 404 for a repository the store does not hold and saves nothing', async () => {
    setBackendKind('file');
    const updates: unknown[] = [];
    h.store = {
      getRepository: (id: string) => (id === 'r1' ? REPO : undefined),
      updateRepositoryAwaited: async (id: string, u: unknown) => { updates.push([id, u]); return true; },
    };
    const sent = await run(botWith(null), 'put', '/repos/:id', { id: 'ghost' }, { name: 'Renamed' });
    expect(sent).toEqual([{ status: 404, body: { success: false, error: 'Repository not found' } }]);
    expect(updates).toEqual([]);
  });

  it('sc1 PUT answers 500 Failed to update repository when the save reports false', async () => {
    setBackendKind('file');
    h.store = {
      getRepository: (id: string) => (id === 'r1' ? REPO : undefined),
      updateRepositoryAwaited: async () => false,
    };
    const sent = await run(botWith(null), 'put', '/repos/:id', { id: 'r1' }, { name: 'Renamed' });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'Failed to update repository' } }]);
  });

  it('sc1 PUT sends nothing more after an answered shared op is thrown', async () => {
    setBackendKind('file');
    h.store = {
      getRepository: () => REPO,
      updateRepositoryAwaited: async () => { throw new SharedOpAnswered('the bot process is not running'); },
    };
    const sent = await run(botWith(null), 'put', '/repos/:id', { id: 'r1' }, { name: 'Renamed' });
    expect(sent).toEqual([]);
  });

  it('sc1 PUT answers a thrown non-Error as 500 Unknown error', async () => {
    setBackendKind('file');
    h.store = {
      getRepository: () => REPO,
      updateRepositoryAwaited: async () => { throw 'boom'; },
    };
    const sent = await run(botWith(null), 'put', '/repos/:id', { id: 'r1' }, { name: 'Renamed' });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'Unknown error' } }]);
  });
});

describe('sc1 DELETE /repos/:id', () => {
  it('sc1 DELETE answers 404 for a repository the store does not hold and removes nothing', async () => {
    setBackendKind('file');
    const removed: string[] = [];
    h.store = {
      getRepository: (id: string) => (id === 'r1' ? REPO : undefined),
      removeRepositoryAwaited: async (id: string) => { removed.push(id); return true; },
    };
    const sent = await run(botWith(null), 'delete', '/repos/:id', { id: 'ghost' });
    expect(sent).toEqual([{ status: 404, body: { success: false, error: 'Repository not found' } }]);
    expect(removed).toEqual([]);
  });

  it('sc1 DELETE says Failed to remove repository when the removal reports false', async () => {
    setBackendKind('file');
    h.store = { getRepository: () => REPO, removeRepositoryAwaited: async () => false };
    const sent = await run(botWith(null), 'delete', '/repos/:id', { id: 'r1' });
    expect(sent).toEqual([{ status: 200, body: { success: false, message: 'Failed to remove repository' } }]);
  });

  it('sc1 DELETE sends nothing more after an answered shared op is thrown', async () => {
    setBackendKind('file');
    h.store = {
      getRepository: () => REPO,
      removeRepositoryAwaited: async () => { throw new SharedOpAnswered('the bot process is not running'); },
    };
    const sent = await run(botWith(null), 'delete', '/repos/:id', { id: 'r1' });
    expect(sent).toEqual([]);
  });

  it('sc1 DELETE answers a thrown non-Error as 500 Unknown error', async () => {
    setBackendKind('file');
    h.store = { getRepository: () => REPO, removeRepositoryAwaited: async () => { throw 'boom'; } };
    const sent = await run(botWith(null), 'delete', '/repos/:id', { id: 'r1' });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'Unknown error' } }]);
  });
});

describe('sc1 GET /modules/:name when the module read throws', () => {
  it('sc1 GET /modules/:name answers a thrown error as 500 with its message', async () => {
    setBackendKind('file');
    h.store = { getModuleInfo: () => { throw new Error('the module cache could not be read'); } };
    const sent = await run(botWith(null), 'get', '/modules/:name', { name: 'alpha' });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'the module cache could not be read' } }]);
  });

  it('sc1 GET /modules/:name answers a thrown non-Error as 500 Unknown error', async () => {
    setBackendKind('file');
    h.store = { getModuleInfo: () => { throw 'boom'; } };
    const sent = await run(botWith(null), 'get', '/modules/:name', { name: 'alpha' });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'Unknown error' } }]);
  });

  it('sc1 GET /modules/:name sends nothing more after an answered shared op is thrown', async () => {
    setBackendKind('file');
    h.store = { getModuleInfo: () => { throw new SharedOpAnswered('the bot process is not running'); } };
    const sent = await run(botWith(null), 'get', '/modules/:name', { name: 'alpha' });
    expect(sent).toEqual([]);
  });
});
