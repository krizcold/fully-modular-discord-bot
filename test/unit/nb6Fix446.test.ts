import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

// NB6 fix446 (wip-redesign/sheets/NB6.md:207 and 550: an op left queued retries at 1 s doubling to 30 s with jitter):
// Node fires a timer from the event loop's cached time, which can run behind Date.now(), so the flush's retry timer can
// fire while the op's Date.now()-based retryAt is still a fraction of a millisecond ahead. The op is tried again once
// its retryAt has passed. Date.now is held by the row and timers are fake, so the row runs the same on every platform.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const CATEGORY = 'nb6fix446';
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let clock: number;

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  _resetRowQueue();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rig.backend.stop();
});

/** An op whose first attempt the server refuses (28000), left queued on its first backoff; begins counts the BEGINs. */
async function queuedOnBackoff() {
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  // A jitter that makes the wait fractional: 1000 * (0.5 + 0.123 * 0.5) = 561.5 ms.
  vi.spyOn(Math, 'random').mockReturnValue(0.123);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const seen = { begins: 0 };
  rows.fault = sql => (/^BEGIN/.test(sql) && ++seen.begins === 1 ? Object.assign(new Error('role is not permitted to log in'), { code: '28000', severity: 'FATAL' }) : undefined);
  const ticket = (dm.saveDataTracked('t.json', opts, { v: 1 }) as { ticket: RowTicket }).ticket;
  await vi.waitFor(() => expect(ticket.op.triesFailed).toBe(1));
  expect(ticket.op.state).toBe('queued');
  expect(ticket.op.retryAt).toBe(1_000_561.5);
  return { ticket, seen };
}

describe('a retry timer that fires before the op is due', () => {
  it('guard: a timer that fires after retryAt tries the op again, and it lands', async () => {
    const { ticket, seen } = await queuedOnBackoff();
    clock = 1_000_562;
    await vi.advanceTimersByTimeAsync(562);
    await vi.waitFor(() => expect(rowTicketState(ticket)).toBe('landed'));
    expect(seen.begins).toBe(2);
  });

  it('the op is tried again once its retryAt has passed, and lands', async () => {
    const { ticket, seen } = await queuedOnBackoff();
    const begins = () => seen.begins;

    // The timer fires while Date.now() still reads half a millisecond before retryAt.
    clock = 1_000_561;
    await vi.advanceTimersByTimeAsync(562);
    expect(begins()).toBe(1);
    expect(ticket.op.state).toBe('queued');

    clock = 1_000_563;
    await vi.advanceTimersByTimeAsync(5);
    await vi.waitFor(() => expect(rowTicketState(ticket)).toBe('landed'));
    expect(begins()).toBe(2);
    expect(rows.docs.get(`global/${CATEGORY}/t.json`)!.body.toString('utf8')).toBe(JSON.stringify({ v: 1 }, null, 2));
  });
});
