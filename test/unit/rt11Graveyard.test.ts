import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reply: {} as Record<string, unknown>,
  sends: 0,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async orig => {
  const real = await orig<any>();
  return { ...real, recognitionRefusal: () => null, readFileMarker: () => null };
});
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, listGraveyardEntries: async () => [] };
});
vi.mock('../../src/webui/utils/webuiDataReader', async orig => {
  const real = await orig<any>();
  return { ...real, getWebuiDataReader: () => ({ listGuildGraveyard: async () => [], listGraveyard: async () => [] }) };
});
vi.mock('../../src/webui/utils/guildRequests', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    planGuildChange: async () => ({ kind: 'json', op: 'restore-graveyard', deadline: 0 }),
    sendGuildChange: async () => { h.sends += 1; return { ...h.reply }; },
  };
});

import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import { hopFailure } from '../../src/webui/routes/hopFailure';
import { setBackendKind } from '../helpers/backendKind';

const G = '123456789012345678';

async function call(method: 'get' | 'post', routePath: string, req: Record<string, any>) {
  const router: any = createGraveyardRoutes({} as any);
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const out = { status: 200, body: undefined as any };
  const res: any = {
    status: (code: number) => { out.status = code; return res; },
    json: (body: unknown) => { out.body = JSON.parse(JSON.stringify(body)); return res; },
  };
  await layer.route.stack[layer.route.stack.length - 1].handle({ body: {}, query: {}, ...req }, res);
  return out;
}

const restore = (reply: Record<string, unknown>) => {
  h.reply = reply;
  return call('post', '/restore', { body: { guildId: G } });
};

beforeEach(() => {
  h.reply = {};
  h.sends = 0;
  setBackendKind('file');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('rt11 GET /api/data/graveyard with a bad guild id', () => {
  it('rt11 answers 400 with success false and the guild id text', async () => {
    const out = await call('get', '/', { query: { guildId: '12a' } });
    expect(out).toStrictEqual({ status: 400, body: { success: false, error: 'Invalid guild ID format' } });
  });
});

describe('rt11 POST /api/data/graveyard/restore: the answer of a landed restore', () => {
  it('rt11 a servedBy that is no text names no machine', async () => {
    const out = await restore({ ok: true, retiredAt: 5, reason: 'removed', servedBy: 42 });
    expect(out).toStrictEqual({ status: 200, body: { success: true, retiredAt: 5, reason: 'removed' } });
    expect(h.sends).toBe(1);
  });

  it('rt11 a keptUntil that is no number is left out', async () => {
    const out = await restore({ ok: true, retiredAt: 5, reason: 'removed', keptUntil: 'soon' });
    expect(out).toStrictEqual({ status: 200, body: { success: true, retiredAt: 5, reason: 'removed' } });
  });

  it('rt11 a numeric keptUntil and a replaced flag are passed on', async () => {
    const out = await restore({ ok: true, retiredAt: 5, reason: 'removed', keptUntil: 9, replaced: false });
    expect(out).toStrictEqual({ status: 200, body: { success: true, retiredAt: 5, reason: 'removed', keptUntil: 9, replaced: false } });
  });
});

describe('rt11 POST /api/data/graveyard/restore: an invalid refusal', () => {
  it('rt11 a live-data refusal without a retiredAt gives no refusal field', async () => {
    const out = await restore({ ok: false, code: 'invalid', error: 'live data exists', refusal: 'live-data' });
    expect(out).toStrictEqual({ status: 409, body: { success: false, error: 'live data exists' } });
  });

  it('rt11 another refusal with a retiredAt gives no live-data field', async () => {
    const out = await restore({ ok: false, code: 'invalid', error: 'no entry', refusal: 'no-entry', retiredAt: 5 });
    expect(out).toStrictEqual({ status: 409, body: { success: false, error: 'no entry' } });
  });

  it('rt11 a live-data refusal with its retiredAt names both', async () => {
    const out = await restore({ ok: false, code: 'invalid', error: 'live data exists', refusal: 'live-data', retiredAt: 5 });
    expect(out).toStrictEqual({ status: 409, body: { success: false, refusal: 'live-data', retiredAt: 5, error: 'live data exists' } });
  });
});

describe('rt11 POST /api/data/graveyard/restore: the codes the page reads', () => {
  it.each(['no-holder', 'not-taken'])('rt11 a %s refusal carries its code beside the hop text', async code => {
    const out = await restore({ ok: false, code });
    const failure = hopFailure(code)!;
    expect(out).toStrictEqual({ status: failure.status, body: { success: false, code, error: failure.error } });
  });

  it('rt11 a frozen refusal carries no code', async () => {
    const out = await restore({ ok: false, code: 'frozen' });
    const failure = hopFailure('frozen')!;
    expect(out).toStrictEqual({ status: failure.status, body: { success: false, error: failure.error } });
  });
});
