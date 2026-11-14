import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rs3: the graveyard routes' guild id check, the store rule of one guild's list, and the bound timer
// of the restore's newest-entry read.

const h = vi.hoisted(() => ({
  fileEntries: [] as Array<{ guildId: string; retiredAt: number; reason: string }>,
  pgEntries: [] as Array<{ guildId: string; retiredAt: number; reason: string; rows?: number }>,
  fileCalls: [] as unknown[],
  sends: [] as unknown[],
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async orig => {
  const real = await orig<any>();
  return { ...real, recognitionRefusal: () => null, readFileMarker: () => null };
});
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, listGraveyardEntries: async (guildId?: string) => { h.fileCalls.push(guildId); return h.fileEntries.map(e => ({ ...e })); } };
});
vi.mock('../../src/webui/utils/webuiDataReader', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getWebuiDataReader: () => ({
      listGuildGraveyard: async () => h.pgEntries.map(e => ({ ...e })),
      listGraveyard: async () => h.pgEntries.map(e => ({ ...e })),
    }),
  };
});
vi.mock('../../src/webui/utils/guildRequests', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    planGuildChange: async () => ({ kind: 'local' }),
    sendGuildChange: async (_b: unknown, _plan: unknown, req: unknown) => { h.sends.push(req); return { ok: true, retiredAt: 5, reason: 'removed' }; },
  };
});

import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import { setBackendKind } from '../helpers/backendKind';

const G = '123456789012345678';

async function call(method: 'get' | 'post', routePath: string, req: Record<string, any>) {
  const router: any = createGraveyardRoutes({} as any);
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const out = { status: 200, body: undefined as any };
  const res: any = { status: (code: number) => { out.status = code; return res; }, json: (body: any) => { out.body = body; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ body: {}, query: {}, ...req }, res);
  return out;
}

beforeEach(() => {
  h.fileEntries = [];
  h.pgEntries = [];
  h.fileCalls = [];
  h.sends = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('rs3 GET /api/data/graveyard?guildId=', () => {
  it.each(['a123456', '123456a', ' 123456', '123456 '])('rs3 refuses the guild id %j with 400', async guildId => {
    setBackendKind('file');
    const out = await call('get', '/', { query: { guildId } });
    expect(out).toEqual({ status: 400, body: { success: false, error: 'Invalid guild ID format' } });
    expect(h.fileCalls).toHaveLength(0);
  });

  it('rs3 a Postgres bot lists only the database batches of the guild, never the leftover file entries', async () => {
    setBackendKind('postgres');
    h.fileEntries = [{ guildId: G, retiredAt: 9, reason: 'file' }];
    h.pgEntries = [{ guildId: G, retiredAt: 7, reason: 'pg', rows: 3 }];
    const out = await call('get', '/', { query: { guildId: G } });
    expect(out).toEqual({ status: 200, body: { success: true, entries: [{ guildId: G, retiredAt: 7, reason: 'pg', rows: 3, backend: 'postgres' }] } });
    expect(h.fileCalls).toHaveLength(0);
  });

  it('rs3 a JSON bot lists the file entries of the guild', async () => {
    setBackendKind('file');
    h.fileEntries = [{ guildId: G, retiredAt: 9, reason: 'file' }];
    const out = await call('get', '/', { query: { guildId: G } });
    expect(out).toEqual({ status: 200, body: { success: true, entries: [{ guildId: G, retiredAt: 9, reason: 'file', backend: 'file' }] } });
  });
});

describe('rs3 POST /api/data/graveyard/restore', () => {
  it('rs3 leaves no 5 s bound timer behind once the newest entry was read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setBackendKind('file');
    h.fileEntries = [{ guildId: G, retiredAt: 3, reason: 'file' }];
    const out = await call('post', '/restore', { body: { guildId: G } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ success: true, retiredAt: 5, reason: 'removed' });
    expect(h.sends).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
