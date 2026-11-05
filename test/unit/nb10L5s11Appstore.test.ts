import { beforeEach, describe, expect, it, vi } from 'vitest';

// NB10: an App Store route that sends its change to the bot answers the operator exactly once. A refusal the
// shared op already answered gets no second answer; any other error in the route answers 500 with its text, so no
// request is left hanging; a baseline save says saved only when the bot reported the write.

const dummy = vi.hoisted(() => ({
  id: 'dummy',
  adminListVariants: () => [], adminSetVariant: () => undefined, adminDeleteVariant: () => true,
  adminListProducts: () => [], adminSetProduct: () => undefined, adminDeleteProduct: () => true,
  adminListCoupons: () => [], adminSetCoupon: () => true, adminDeleteCoupon: () => true,
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({
    on: () => undefined, off: () => undefined, list: () => [dummy], startTickers: () => undefined, emitEvent: () => undefined,
    get: (id: string) => (id === 'dummy' ? dummy : undefined),
  }),
}));

import { createAppStoreRoutes } from '../../src/webui/routes/appstore';

type Answer = { status: number; body: any };

function fakeRes() {
  const answers: Answer[] = [];
  let code = 200;
  const res: any = {
    answers,
    status(c: number) { code = c; return res; },
    json(body: unknown) { answers.push({ status: code, body }); return res; },
  };
  return res;
}

let runSharedOp: ReturnType<typeof vi.fn>;
let router: any;

beforeEach(() => {
  runSharedOp = vi.fn();
  router = createAppStoreRoutes({ isRunning: () => false, runSharedOp } as any);
});

async function hit(method: string, path: string, params: Record<string, string>, body: unknown = {}): Promise<Answer[]> {
  const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${path}`);
  const res = fakeRes();
  await layer.route.stack[0].handle({ params, body, query: {} }, res, () => undefined);
  return res.answers;
}

const DISK = 'The disk did not take the write, so your change was not saved. Check the disk, then try again.';

type Row = [string, string, string, Record<string, string>, unknown];
const rows: Row[] = [
  ['set a tier', 'put', '/premium/tiers/:id', { id: 'gold' }, { displayName: 'Gold', priority: 10 }],
  ['delete a tier', 'delete', '/premium/tiers/:id', { id: 'gold' }, {}],
  ['set messages', 'put', '/premium/messages', {}, { moduleBlocked: 'blocked' }],
  ['reset messages', 'post', '/premium/messages/reset', {}, {}],
  ['set a Dummy variant', 'put', '/premium/providers/dummy/variants/:variantId', { variantId: 'v1' }, { label: 'V1', amount: 5, currency: 'USD' }],
  ['delete a Dummy variant', 'delete', '/premium/providers/dummy/variants/:variantId', { variantId: 'v1' }, {}],
];

describe('a refused shared op is answered once, with the refusal', () => {
  for (const [name, method, path, params, body] of rows) {
    it(`${name}: the disk refusal is the only answer`, async () => {
      runSharedOp.mockResolvedValue({ ok: false, code: 'disk' });
      const answers = await hit(method, path, params, body);
      expect(answers).toEqual([{ status: 503, body: { success: false, error: DISK } }]);
    });
  }
});

describe('an error the shared op did not answer is answered 500 with its text', () => {
  for (const [name, method, path, params, body] of rows) {
    it(`${name}: a broken IPC channel answers 500`, async () => {
      runSharedOp.mockRejectedValue(new Error('channel closed'));
      const answers = await hit(method, path, params, body);
      expect(answers).toEqual([{ status: 500, body: { success: false, error: 'channel closed' } }]);
    });
  }
});

describe('PUT global-config: the answer follows the bot reply', () => {
  const put = () => hit('put', '/global-config/:moduleName', { moduleName: 'nb10s11mod' }, { moduleEnabled: false });

  it('a refused write answers its status and text, never saved', async () => {
    runSharedOp.mockResolvedValue({ ok: false, code: 'disk' });
    const answers = await put();
    expect(runSharedOp).toHaveBeenCalledTimes(1);
    expect(runSharedOp.mock.calls[0][0]).toBe('premium.setGlobalModuleConfig');
    expect(answers).toEqual([{ status: 503, body: { success: false, error: DISK } }]);
  });

  it('a write the bot reported as done answers success true', async () => {
    runSharedOp.mockResolvedValue({ ok: true, result: true });
    const answers = await put();
    expect(answers).toHaveLength(1);
    expect(answers[0].status).toBe(200);
    expect(answers[0].body.success).toBe(true);
    expect(answers[0].body.moduleName).toBe('nb10s11mod');
  });

  it('an ok reply whose result is not true answers success false', async () => {
    for (const result of [false, undefined, 'true', 1]) {
      runSharedOp.mockResolvedValue({ ok: true, result });
      const answers = await put();
      expect(answers).toHaveLength(1);
      expect(answers[0].status).toBe(200);
      expect(answers[0].body.success).toBe(false);
    }
  });
});
