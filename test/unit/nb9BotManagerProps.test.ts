import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB9 test 24: fast-check over BotManager with the forkMock children (39, 40, 62 under owner question 4's yes, 65,
// 70): random sequences of standby asks, retires, exits (codes 0, 1, 75 and a kill), children that exit only when the
// sequence says so (so a killed child may never exit), Stop, Restart, the web UI's exit and standby handshakes.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { EXIT_DEPOSED } from '../../src/bot/internalSetup/utils/dataManager';
import { resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { freshWriterLock, resetForks, sentTo } from '../helpers/nb10Rig';

type Action =
  | { a: 'ask'; attempt: number }
  | { a: 'retire'; attempt: number }
  | { a: 'exit'; who: 'current' | 'standby'; code: number | null }
  | { a: 'stop' } | { a: 'restart' } | { a: 'webExit' }
  | { a: 'stopping'; kind: 'failed' | 'lapse' }
  | { a: 'wait'; ms: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ a: fc.constant('ask' as const), attempt: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ a: fc.constant('retire' as const), attempt: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ a: fc.constant('exit' as const), who: fc.constantFrom('current' as const, 'standby' as const), code: fc.constantFrom<number | null>(0, 1, EXIT_DEPOSED, null) }),
  fc.constant({ a: 'stop' as const }),
  fc.constant({ a: 'restart' as const }),
  fc.constant({ a: 'webExit' as const }),
  fc.record({ a: fc.constant('stopping' as const), kind: fc.constantFrom('failed' as const, 'lapse' as const) }),
  fc.record({ a: fc.constant('wait' as const), ms: fc.constantFrom(50, 6_000, 45_000) }),
);

const gone = (child: any): boolean => child.exitCode !== null || child.signalCode !== null;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(actions: Action[]): Promise<void> {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  forks.holdExit = true;
  freshWriterLock('webui');
  resetAddressesForTests();
  safety.recordCrash.mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const manager = new BotManager();
  const m = manager as any;
  const branches = { exit: 0 };
  for (const name of ['botProcessExit', 'standbyExit']) {
    const real = m[name].bind(m);
    m[name] = (...args: unknown[]) => { branches.exit += 1; return real(...args); };
  }
  const realPromote = m.promote.bind(m);
  let promoting = false;
  m.promote = (givenUp: boolean) => { if (promoting) branches.exit += 1; return realPromote(givenUp); };
  const log = console.log as unknown as ReturnType<typeof vi.fn>;
  const staleLines = (): number => log.mock.calls.filter(c => String(c[0]).includes('A previous bot child exited')).length;

  try {
    let settled = false;
    const started = manager.start().finally(() => { settled = true; });
    for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect((await started).success).toBe(true);
    manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });

    let current: any = m.botProcess;
    let stopAsked = false;
    const standbys = new Set<any>();
    const marked = new Set<string>();
    let retiringChild: any = null;

    for (const action of actions) {
      const before = { current: m.botProcess, standby: m.standby?.child ?? null, retiring: m.retiring?.child ?? null };
      if (action.a === 'ask' && before.current && !gone(before.current)) {
        const attempt = `a-${action.attempt}`;
        before.current.emit('message', { type: 'control:reshard-standby', data: { attempt, to: 8, intents: 1, maxConcurrency: 1, entry: 'postgres://db-a/x' } });
        const answer = sentTo(before.current, 'reshard:standby-state').at(-1)?.data;
        // 65: an attempt marked by an unasked exit while its standby lived is never started or running again.
        if (marked.has(attempt)) expect(['started', 'running']).not.toContain(answer?.state);
      } else if (action.a === 'retire' && before.current && !gone(before.current)) {
        before.current.emit('message', { type: 'control:reshard-retire', data: { attempt: `a-${action.attempt}` } });
      } else if (action.a === 'exit') {
        const child = action.who === 'current' ? before.current : before.standby;
        if (child && !gone(child)) {
          const signal = action.code === null ? 'SIGKILL' : null;
          const wasCurrent = child === m.botProcess && m.retiring?.child !== child;
          const liveStandby = m.standby && !gone(m.standby.child) ? m.standby.attempt : null;
          const crashes = safety.recordCrash.mock.calls.length;
          const restartsBefore = m.crashRestarts;
          const counted = branches.exit;
          const stale = staleLines();
          child.exitCode = action.code;
          child.signalCode = signal;
          promoting = true;
          child.emit('exit', action.code, signal);
          promoting = false;
          // 40: every exit takes exactly one dispatch branch.
          expect(branches.exit - counted + staleLines() - stale).toBe(1);
          if (wasCurrent) {
            const unasked = !stopAsked && action.code !== 0 && action.code !== EXIT_DEPOSED;
            // 62 (yes) and 70: a nonzero code other than 75, or a kill, arms the crash restart unless a stop was asked.
            if (unasked && restartsBefore < 5) expect(m.crashRestartTimer).not.toBeNull();
            if (stopAsked || action.code === 0) expect(m.crashRestartTimer ?? null).toBeNull();
            if (action.code === EXIT_DEPOSED) expect(safety.recordCrash.mock.calls.length).toBe(crashes);
            if (unasked && liveStandby) marked.add(liveStandby);
          }
          if (child === retiringChild) retiringChild = null;
        }
      } else if (action.a === 'stop' || action.a === 'restart') {
        // Both refuse while another operation (a start's 5 s ready wait) holds the lock: no stop reaches the child.
        if (m.botProcess && !m.operationInProgress) stopAsked = true;
        void (action.a === 'stop' ? manager.shutdown() : manager.restart()).catch(() => undefined);
      } else if (action.a === 'webExit') {
        manager.beginExit();
      } else if (action.a === 'stopping' && before.standby && !gone(before.standby)) {
        before.standby.emit('message', { type: 'reshard:standby-stopping', data: { attempt: m.standby?.attempt, reason: 'no claim renewal for 40 s', kind: action.kind } });
      }
      await vi.advanceTimersByTimeAsync(action.a === 'wait' ? action.ms : 20);

      if (m.standby) standbys.add(m.standby.child);
      if (m.retiring) retiringChild = m.retiring.child;
      // Never two current children: the standby is never the bot process.
      if (m.standby) expect(m.standby.child).not.toBe(m.botProcess);
      // 40: no retire outlives its child's exit or the give-up.
      if (retiringChild && gone(retiringChild)) expect(m.retiring?.child ?? null).not.toBe(retiringChild);
      if (m.botProcess && m.botProcess !== current) {
        // 26 and 39: a standby becomes the bot process only at its retiring child's exit or the give-up.
        if (standbys.has(m.botProcess)) {
          expect(current === null || gone(current) || current.signals.includes('SIGKILL')).toBe(true);
        }
        current = m.botProcess;
        stopAsked = false;
      }
      if (m.botProcess === null && current !== null && gone(current)) current = null;
    }
  } finally {
    manager.cancelCrashRestart();
    for (const child of forks.children) if (!gone(child)) { child.exitCode = 0; child.emit('exit', 0, null); }
    vi.useRealTimers();
  }
}

describe('BotManager under random sequences (test 24)', () => {
  it('holds 39, 40, 62, 65 and 70 on every sequence', async () => {
    await fc.assert(fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 12 }), actions => run(actions)), { numRuns: 40 });
  }, 120_000);
});
