import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  _resetRowQueue, configureRowFlush, deposeRows, flushRows, rowMirrorsWritten, rowQueue, UPSERT_SQL, withMirrorLock,
  type RowBackend, type RowTicket,
} from '../../src/bot/internalSetup/utils/sharedStore';
import type { SharedStatement, SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const CATEGORY = 'rq5timers';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const fileOf = (name: string) => dataPath('global', CATEGORY, name);
const RECORD = () => dataPath('.shared-mirror.json');

function fakeBackend(): RowBackend {
  return {
    async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
      const plan = spec.statements(null);
      if (plan === 'landed') return { kind: 'landed' };
      if (!Array.isArray(plan)) return { kind: 'stopped', value: plan.stop };
      const queue: SharedStatement<S>[] = [...plan];
      const results: any[] = [];
      while (queue.length > 0) {
        const st = queue.shift()!;
        let res: any = { rows: [], rowCount: 0 };
        if (st.text.includes('pg_advisory_xact_lock')) res = { rows: [{ now: new Date() }], rowCount: 1 };
        else if (st.text === UPSERT_SQL) res = { rows: [{ rev: '1' }], rowCount: 1 };
        results.push(res);
        if (!st.next) continue;
        const after = st.next(res);
        if (Array.isArray(after)) queue.unshift(...after);
        else if (after) return { kind: 'stopped', value: after.stop };
      }
      spec.onCommitSent?.();
      return { kind: 'committed', results };
    },
  };
}

const accept = (name: string, body: string): RowTicket =>
  rowQueue.accept(keyOf(name), fileOf(name), { body: Buffer.from(body, 'utf8') }, { sha: 'absent', caller: false });

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  _resetRowQueue();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(RECORD(), { force: true });
  configureRowFlush({ backend: () => fakeBackend() });
});

afterEach(() => {
  configureRowFlush({ backend: () => null });
  _resetRowQueue();
  fs.rmSync(RECORD(), { force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function failedMirror(name: string): Promise<RowTicket> {
  fs.writeFileSync(RECORD(), '{');
  const ticket = accept(name, '{"x":1}');
  await flushRows();
  expect(ticket.op.state).toBe('mirror');
  expect(errors.some(l => l.startsWith(`[Shared] Saved ${keyOf(name)} in the database, but could not write `))).toBe(true);
  return ticket;
}

describe('a mirror retry that comes due after a deposition', () => {
  it('starts no mirror write: nothing is left for the web UI chain to wait for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ticket = await failedMirror('deposed.json');
    fs.rmSync(RECORD(), { force: true });
    deposeRows('another process');
    expect(ticket.op.state).toBe('landed');
    expect(rowMirrorsWritten()).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(rowMirrorsWritten()).toBeNull();
    await flushRows();
    expect(fs.existsSync(fileOf('deposed.json'))).toBe(false);
  });
});

describe('the test reset of the row queue', () => {
  it('forgets the timers it stopped: a second reset stops nothing', async () => {
    await failedMirror('reset.json');
    _resetRowQueue();
    const spy = vi.spyOn(globalThis, 'clearTimeout');
    _resetRowQueue();
    expect(spy).not.toHaveBeenCalled();
  });
});

async function ticksUntil(flag: () => boolean): Promise<number> {
  for (let n = 0; n < 20; n++) {
    if (flag()) return n;
    await null;
  }
  return -1;
}

describe('the mirror mutex once its holder is gone', () => {
  it('after a holder whose fn threw at once, the next caller runs as soon as on a lock never taken', async () => {
    let freeRan = false;
    const free = withMirrorLock(keyOf('fresh'), async () => { freeRan = true; });
    const baseline = await ticksUntil(() => freeRan);
    await free;
    expect(baseline).toBeGreaterThan(0);

    const a = withMirrorLock(keyOf('thrown'), (() => { throw new Error('sync'); }) as () => Promise<void>);
    let caught: unknown = null;
    try {
      await a;
    } catch (error) {
      caught = error;
    }
    expect((caught as Error)?.message).toBe('sync');
    let ran = false;
    const b = withMirrorLock(keyOf('thrown'), async () => { ran = true; });
    const ticks = await ticksUntil(() => ran);
    await b;
    expect(ticks).toBe(baseline);
  });
});
