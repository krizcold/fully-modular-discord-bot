import { describe, expect, it } from 'vitest';

import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';

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

describe('A12-4 data op failures name their state', () => {
  it('invalid stays a 409 with the owner text', async () => {
    const r = await restore({ ok: false, code: 'invalid', error: 'live data exists' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('live data exists');
  });

  it('not-owner is a refusal that says the change was not saved, not a retry hint', async () => {
    const r = await restore({ ok: false, code: 'not-owner', error: 'guild ownership moved mid-write' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/took over this guild's data, so the change was not saved/);
    expect(r.body.error).not.toMatch(/retry/);
  });

  it('frozen says nothing was changed and to retry', async () => {
    const r = await restore({ ok: false, code: 'frozen' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not served by this bot process right now, so nothing was changed/);
    expect(r.body.error).toMatch(/retry in a moment/);
  });
});
