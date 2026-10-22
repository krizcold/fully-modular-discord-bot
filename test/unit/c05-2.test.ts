import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// C05-2 (R4-J17, R6-J25, R36-J5): the Usage and Fleet routes answer a failed child read as a failure, the disk
// figures say what they measure, the metrics IPC answers 'not ready' before the bot finishes booting, and the
// takeover guard says when the control store does not answer instead of naming a live incumbent.

import { createUsageRoutes } from '../../src/webui/routes/usage';
import { createFleetRoutes } from '../../src/webui/routes/fleet';
import { answerMetricsRequest, markMetricsReady } from '../../src/bot/internalSetup/utils/ipcMetricsHandler';
import { getMetricsCollector } from '../../src/bot/internalSetup/utils/metrics/metricsCollector';
import { _runTakeoverGuard } from '../../src/bot/internalSetup/fleet/bootstrap';
import { _getTakeoverGuardView } from '../../src/bot/internalSetup/fleet/state';
import { TERM_GUARD_POLL_MS } from '../../src/bot/internalSetup/fleet/constants';
import { call, startApp } from '../helpers/configRig';

const REASON = 'IPC request timed out; the operation may still complete in the background - check bot logs before retrying';
const failing = async () => ({ success: false, error: REASON });

const bot: any = {
  isRunning: () => true,
  getGlobalMetrics: failing,
  getMetricsLeaderboard: failing,
  getBotGuilds: async () => ({ success: true, guilds: [] }),
  getGuildMetrics: failing,
  getFleetState: failing,
  listFleetMigrations: failing,
};

let base = '';
let close: () => Promise<void>;
beforeAll(async () => {
  ({ url: base, close } = await startApp(app => {
    app.use('/api/usage', createUsageRoutes(bot));
    app.use('/api/fleet', createFleetRoutes(bot));
  }));
});
afterAll(async () => { await close(); });

describe('a child that does not answer is a failure, never zeros (R4-26)', () => {
  it('/usage/global names the IPC error', async () => {
    const { body } = await call(base, 'GET', '/api/usage/global');
    expect(body.success).toBe(false);
    expect(body.error).toBe(`Could not read metrics from the bot: ${REASON}`);
  });

  it('/usage/guilds names the IPC error', async () => {
    const { body } = await call(base, 'GET', '/api/usage/guilds');
    expect(body.success).toBe(false);
    expect(body.error).toBe(`Could not read metrics from the bot: ${REASON}`);
  });

  it('/fleet/state answers reachable:false with the reason, keeping the parent-side facts', async () => {
    const { body } = await call(base, 'GET', '/api/fleet/state');
    expect(body.reachable).toBe(false);
    expect(body.initialized).toBe(false);
    expect(body.error).toBe(`Fleet state unavailable: ${REASON}`);
    expect('modeOverride' in body).toBe(true);
  });

  it('/fleet/migrations names the IPC error instead of an empty history', async () => {
    const { body } = await call(base, 'GET', '/api/fleet/migrations');
    expect(body.success).toBe(false);
    expect(body.error).toBe(`Fleet state unavailable: ${REASON}`);
  });

  it('/usage/global passes the disk scope through on a successful snapshot', async () => {
    bot.getGlobalMetrics = async () => ({ success: true, snapshot: answerSnapshot(true) });
    try {
      const { body } = await call(base, 'GET', '/api/usage/global');
      expect(body.success).toBe(true);
      expect(body.metricsEnabled).toBe(true);
      expect(body.system.diskScope).toBe('localOnly');
    } finally {
      bot.getGlobalMetrics = failing;
    }
  });

  it('/usage/global reports metricsEnabled:false only when the snapshot says so', async () => {
    bot.getGlobalMetrics = async () => ({ success: true, snapshot: answerSnapshot(false) });
    try {
      const { body } = await call(base, 'GET', '/api/usage/global');
      expect(body.success).toBe(true);
      expect(body.metricsEnabled).toBe(false);
    } finally {
      bot.getGlobalMetrics = failing;
    }
    const { body } = await call(base, 'GET', '/api/usage/global');
    expect(body.success).toBe(false);
    expect(body.metricsEnabled).toBeUndefined();
  });
});

function answerSnapshot(enabled: boolean): any {
  const snap = getMetricsCollector().getGlobalSnapshot();
  return { ...snap, enabled, system: { ...snap.system, diskScope: 'localOnly' } };
}

describe('disk figures say what they measure (R4-27)', () => {
  it('the snapshots carry the scope the samplers set, and none before', () => {
    const collector = getMetricsCollector();
    expect(collector.getGlobalSnapshot().system.diskScope).toBeNull();
    collector.setDiskScope('localOnly');
    expect(collector.getGlobalSnapshot().system.diskScope).toBe('localOnly');
    expect(collector.getGuildSnapshot('111111111111111111').disk.scope).toBe('localOnly');
    collector.setDiskScope('local');
    expect(collector.getGlobalSnapshot().system.diskScope).toBe('local');
  });
});

describe('the metrics IPC answers before the bot finishes booting', () => {
  it("answers 'not ready' until marked ready, then the snapshot", () => {
    const early = answerMetricsRequest('metrics:global', {});
    expect(early.success).toBe(false);
    expect(early.error).toMatch(/not available until the fleet boot completes/);
    markMetricsReady();
    expect(answerMetricsRequest('metrics:global', {}).success).toBe(true);
  });
});

describe('the takeover guard says when the control store does not answer (R36-6)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('before the first read, during the hold, and once per outage in the log', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let mode: 'down' | 'up' = 'down';
    let stamp = 1;
    const store: any = {
      getTerm: async () => {
        if (mode === 'down') throw new Error('connect ECONNREFUSED');
        return { term: 7, nodeId: 'other-node-aaaaaaaa', updatedAt: stamp };
      },
    };
    const done = _runTakeoverGuard(store, 'self-node', false);
    await vi.advanceTimersByTimeAsync(0);
    const before = _getTakeoverGuardView();
    expect(before.takeoverHold).toBeNull();
    expect(typeof before.takeoverGuardUnreadableSince).toBe('number');
    await vi.advanceTimersByTimeAsync(TERM_GUARD_POLL_MS * 2);

    mode = 'up';
    await vi.advanceTimersByTimeAsync(TERM_GUARD_POLL_MS);
    const holding = _getTakeoverGuardView();
    expect(holding.takeoverGuardUnreadableSince).toBeNull();
    expect(holding.takeoverHold?.observedTerm).toBe(7);
    expect(holding.takeoverHold?.storeUnreachableSince).toBeNull();

    mode = 'down';
    await vi.advanceTimersByTimeAsync(TERM_GUARD_POLL_MS * 3);
    const blind = _getTakeoverGuardView();
    expect(typeof blind.takeoverHold?.storeUnreachableSince).toBe('number');

    mode = 'up';
    stamp = 2;
    await vi.advanceTimersByTimeAsync(TERM_GUARD_POLL_MS);
    expect(_getTakeoverGuardView().takeoverHold?.storeUnreachableSince).toBeNull();

    const outages = warn.mock.calls.filter(args => String(args[0]).includes('control store did not answer'));
    expect(outages.length).toBe(2);

    mode = 'down';
    store.getTerm = async () => null;
    await vi.advanceTimersByTimeAsync(TERM_GUARD_POLL_MS);
    expect(await done).toBeNull();
    expect(_getTakeoverGuardView().takeoverHold).toBeNull();
  });
});

describe('review fixes: disk scope by data mode, CLI fleet state failure', () => {
  it('a postgres-mode node without a live backend is never exact', async () => {
    const { diskScopeFor } = await import('../../src/bot/internalSetup/utils/metrics/samplers');
    expect(diskScopeFor('postgres', false)).toBe('localOnly');
    expect(diskScopeFor('postgres', true)).toBe('localOnly');
    expect(diskScopeFor('file', true)).toBe('localOnly');
    expect(diskScopeFor('file', false)).toBe('local');
  });

  it("'transform status' treats reachable:false as a failure carrying the error", async () => {
    const { asFleetStateFailure } = await import('../../src/cli/commands');
    const down: any = { ok: true, status: 200, body: { success: true, reachable: false, error: 'Fleet state unavailable: x', transformation: null } };
    expect((asFleetStateFailure(down).body as any).success).toBe(false);
    const up: any = { ok: true, status: 200, body: { success: true, reachable: true, transformation: null } };
    expect(asFleetStateFailure(up)).toBe(up);
  });

  it("'fleet state' exits with an error when the child does not answer", async () => {
    const { dispatch } = await import('../../src/cli/commands');
    const client: any = { request: async () => ({ ok: true, status: 200, body: { success: true, reachable: false, error: 'Fleet state unavailable: x' } }) };
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error('exit ' + code); }) as any);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(dispatch(client, ['fleet', 'state'], {})).rejects.toThrow(/^exit [1-9]/);
    } finally {
      exit.mockRestore(); out.mockRestore(); err.mockRestore(); log.mockRestore();
    }
  });
});
