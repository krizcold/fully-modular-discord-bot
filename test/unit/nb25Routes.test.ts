import { describe, expect, it, vi } from 'vitest';

// NB25 (wip-redesign/sheets/NB25.md decision 3, section 8 item 5): the adopt route passes the request body's plan as the
// op's fourth argument.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ get: () => undefined, listAll: () => [], list: () => [] }),
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => ({
  ...(await orig<any>()),
  getPremiumManager: () => ({ getSubscriptions: () => ({ active: null, paused: [] }) }),
}));

import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';

const G = '123456789012345678';
const ROUTE = '/:guildId/orphans/:providerId/:providerSubId/adopt';

async function adoptWith(body: unknown): Promise<{ op: string; args: unknown }[]> {
  const ops: { op: string; args: unknown }[] = [];
  const router: any = createGuildSubscriptionRoutes({ runSharedOp: async (op: string, args: unknown) => { ops.push({ op, args }); return { ok: true, result: true }; } } as any);
  const layer = router.stack.find((l: any) => l.route && l.route.path === ROUTE && l.route.methods.post);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const res: any = { status: () => res, json: () => res };
  await handle({ params: { guildId: G, providerId: 'stripe', providerSubId: 'sub_1' }, body, query: {}, user: { id: 'u1' } }, res, () => undefined);
  return ops;
}

describe('the adopt route', () => {
  it("passes the body's plan as the op's fourth argument", async () => {
    const plan = { kind: 'resume', days: 12, from: 'recorded', at: '2026-11-01T00:00:00.000Z', autoRenew: true, call: true, line: 'x' };
    const sent = JSON.parse(JSON.stringify(plan));
    expect(await adoptWith({ plan })).toEqual([{ op: 'premium.adoptOrphan', args: { args: [G, 'stripe', 'sub_1', sent] } }]);
  });

  it('a body with no plan passes undefined in its place', async () => {
    const ops = await adoptWith({});
    expect(ops).toHaveLength(1);
    expect((ops[0].args as { args: unknown[] }).args).toEqual([G, 'stripe', 'sub_1', undefined]);
  });
});
