import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/routeResolver', () => ({ routeFor: () => 'file' }));

import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { forwardDataOp, DataOpForwardDeps } from '../../src/bot/internalSetup/fleet/dataOpForward';
import { ControlServer } from '../../src/bot/internalSetup/fleet/controlServer';

async function restore(reply: any): Promise<{ status: number; body: any }> {
  const router: any = createGraveyardRoutes({ writeGuildData: async () => reply } as any);
  const layer = router.stack.find((l: any) => l.route?.path === '/restore');
  const out = { status: 200, body: undefined as any };
  const res: any = {
    status(s: number) { out.status = s; return res; },
    json(b: any) { out.body = b; return res; },
  };
  await layer.route.stack[0].handle({ body: { guildId: '123' } }, res);
  return out;
}

describe('A12-4 hop failures name their state', () => {
  it('a hop that was sent and got no answer is a 504 that says the change may have applied', async () => {
    const r = await restore({ ok: false, code: 'owner-no-answer', error: 'timed out' });
    expect(r.status).toBe(504);
    expect(r.body.error).toMatch(/may have been applied/);
    expect(r.body.error).toMatch(/timed out/);
  });

  it('a disconnected owner says nothing was changed and names the levers', async () => {
    const r = await restore({ ok: false, code: 'owner-disconnected' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not connected, so nothing was changed/);
    expect(r.body.error).toMatch(/declare it lost/);
  });

  it('an unassigned shard names Assign and the reshard', async () => {
    const r = await restore({ ok: false, code: 'shard-unassigned' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/Assign the shard/);
  });

  it('stale-term keeps the temporarily unavailable text', async () => {
    const r = await restore({ ok: false, code: 'stale-term' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('guild temporarily unavailable');
  });

  it('invalid stays a 409 with the owner text', async () => {
    const r = await restore({ ok: false, code: 'invalid', error: 'live data exists' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('live data exists');
  });
});

describe('A12-4 master forwarder sorts hop failures into codes', () => {
  const guildId = '123456789012345678';
  function deps(over: Partial<DataOpForwardDeps> = {}): DataOpForwardDeps {
    return {
      shardCount: 1,
      term: 3,
      ownerOf: () => ({ nodeId: 'w1' }),
      nodeOf: () => ({ connected: true }),
      request: async () => ({ ok: true }),
      applyWrite: async () => ({ ok: true }),
      applyRead: async () => ({ ok: true }),
      ...over,
    };
  }
  const req: any = { guildId, module: 'm', filename: 'f.json', op: 'delete' };

  it('an unassigned shard is shard-unassigned', async () => {
    expect((await forwardDataOp(deps({ ownerOf: () => undefined }), 'write', req)).code).toBe('shard-unassigned');
  });

  it('a registry-disconnected owner is owner-disconnected and nothing is sent', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const r = await forwardDataOp(deps({ nodeOf: () => ({ connected: false }), request }), 'write', req);
    expect(r.code).toBe('owner-disconnected');
    expect(request).not.toHaveBeenCalled();
  });

  it('a request refused as not connected by the control server is owner-disconnected', async () => {
    const server = new ControlServer({} as any);
    const r = await forwardDataOp(deps({ request: (id, type, data) => server.request(id, type, data) }), 'write', req);
    expect(r.code).toBe('owner-disconnected');
  });

  it('a send that throws is owner-disconnected', async () => {
    const server: any = new ControlServer({} as any);
    server.conns.set('w1', { readyState: 1, send: () => { throw new Error('socket closing'); } });
    const r = await forwardDataOp(deps({ request: (id, type, data) => server.request(id, type, data, 50) }), 'write', req);
    expect(r.code).toBe('owner-disconnected');
    expect(r.error).toMatch(/socket closing/);
  });

  it('a sent request that times out is owner-no-answer', async () => {
    const server: any = new ControlServer({} as any);
    server.conns.set('w1', { readyState: 1, send: () => {} });
    const r = await forwardDataOp(deps({ request: (id, type, data) => server.request(id, type, data, 20) }), 'write', req);
    expect(r.code).toBe('owner-no-answer');
    expect(r.error).toMatch(/timed out/);
  });

  it('an empty reply is owner-no-answer', async () => {
    expect((await forwardDataOp(deps({ request: async () => undefined }), 'read', req)).code).toBe('owner-no-answer');
  });
});

describe('A12-4 config route words the hop reply', () => {
  it('POST /data/delete answers owner-no-answer with a 504 that keeps the detail', async () => {
    const router: any = createConfigRoutes({ writeGuildData: async () => ({ ok: false, code: 'owner-no-answer', error: 'timed out' }) } as any);
    const layer = router.stack.find((l: any) => l.route?.path === '/data/delete' && l.route.methods.post);
    const out = { status: 200, body: undefined as any };
    const res: any = { status(s: number) { out.status = s; return res; }, json(b: any) { out.body = b; return res; } };
    await layer.route.stack[0].handle({ body: { guildId: '123456789012345678', file: 'm/f.json' } }, res);
    expect(out.status).toBe(504);
    expect(out.body.error).toMatch(/may have been applied/);
    expect(out.body.error).toMatch(/timed out/);
  });

  it('not-owner is a refusal, not a retry hint', async () => {
    const r = await restore({ ok: false, code: 'not-owner', error: 'this node does not serve this guild' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/does not serve this guild, so nothing was changed/);
    expect(r.body.error).not.toMatch(/retry/);
  });
});
