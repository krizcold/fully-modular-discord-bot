import { afterEach, describe, expect, it, vi } from 'vitest';
import { PANEL_TEXTS, planGuildRequest, remotePanelAnswer, type Outcome } from '../../src/webui/utils/guildRequests';
import { createManagedRoutes } from '../../src/webui/routes/managed';
import { setBackendKind } from '../helpers/backendKind';

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('rv1 a list answer too large to pass between machines', () => {
  it('rv1 the owner reply names the holder and carries no note key at all', () => {
    const answer = remotePanelAnswer('guild:channels', { k: 'reply', reply: { success: true, oversize: { bytes: 300000 } } } as Outcome, 'owner', 'M2');
    expect(answer.status).toBe(502);
    expect('note' in answer.reply).toBe(false);
    expect(answer.reply).toStrictEqual({
      success: false,
      code: 'answer-too-large',
      error: PANEL_TEXTS.listTooLarge('guild:channels', 'M2', 300000),
      servedBy: 'M2',
    });
  });

  it('rv1 the member reply carries no note key either', () => {
    const answer = remotePanelAnswer('panel:list', { k: 'reply', reply: { success: true, oversize: { bytes: 400000 } } } as Outcome, 'member', 'M2');
    expect(Object.keys(answer.reply).sort()).toEqual(['code', 'error', 'success']);
  });
});

describe('rv1 the deadline of a planned panel request', () => {
  const bot: any = { writerRoute: () => { throw new Error('not reached'); } };

  it('rv1 a file bot plan gives the read its 40 s from now', async () => {
    setBackendKind('file');
    const before = performance.now();
    const plan = await planGuildRequest(bot, '123456789012345678', 'panel:list', 'owner');
    const after = performance.now();
    expect(plan.kind).toBe('json');
    expect(plan.deadline).toBeGreaterThanOrEqual(before + 40_000);
    expect(plan.deadline).toBeLessThanOrEqual(after + 40_000);
  });

  it('rv1 a refusal of a bad guild id still carries a deadline ahead of now', async () => {
    setBackendKind('postgres');
    const before = performance.now();
    const plan = await planGuildRequest(bot, 'not-an-id', 'panel:execute', 'owner');
    const after = performance.now();
    expect(plan.kind).toBe('refuse');
    expect(plan.deadline).toBeGreaterThanOrEqual(before + 60_000);
    expect(plan.deadline).toBeLessThanOrEqual(after + 60_000);
  });
});

describe('rv1 the memory hook', () => {
  function memoryRoute() {
    const readings: unknown[] = [];
    const bot = { noteMemoryReading: (r: unknown) => { readings.push(r); } };
    const router: any = createManagedRoutes(bot as any, {} as any);
    const layer = router.stack.find((l: any) => l.route && l.route.methods.post && l.route.path === '/memory');
    const handle = layer.route.stack[0].handle as (req: any, res: any) => unknown;
    return {
      readings,
      post: (body: unknown) => {
        const res: any = { statusCode: 200, bodies: [] as unknown[] };
        res.status = (c: number) => { res.statusCode = c; return res; };
        res.json = (b: unknown) => { res.bodies.push(b); return res; };
        handle({ body }, res);
        return res;
      },
    };
  }

  it('rv1 a reading without an error hands the bot no error key', () => {
    const route = memoryRoute();
    const res = route.post({ room: true, useMb: 1, freeMb: 2, at: '2026-11-14T10:00:00Z' });
    expect(res.statusCode).toBe(200);
    expect(res.bodies).toEqual([{ success: true }]);
    expect(route.readings).toHaveLength(1);
    expect('error' in (route.readings[0] as object)).toBe(false);
    expect(route.readings[0]).toStrictEqual({ room: true, useMb: 1, freeMb: 2, at: '2026-11-14T10:00:00Z' });
  });

  it('rv1 a reading with an error hands the bot that error', () => {
    const route = memoryRoute();
    route.post({ room: null, useMb: null, freeMb: null, at: '2026-11-14', error: 'cgroup unreadable' });
    expect(route.readings).toStrictEqual([{ room: null, useMb: null, freeMb: null, at: '2026-11-14', error: 'cgroup unreadable' }]);
  });
});
