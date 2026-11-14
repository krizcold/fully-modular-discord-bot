import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataPath } from '../../src/utils/dataRoot';
import { sharedPlan, type SharedTxOutcome, type SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  LOCK_SQL, UPSERT_SQL,
  _resetRowQueue, configureRowFlush, deposeRows, flushRows, reopenRows, rowChange, rowCommitOwed, rowOpsLanded, rowQueue,
  rowsDeposed, rowTicketState, useStoreLanding, type RowBackend, type RowTicket,
} from '../../src/bot/internalSetup/utils/sharedStore';

// L5 run A, rp1 chunk of sharedStore.ts: how a stored op lands and counts, the deposition (another process took the
// data files) and the reopen that follows the web UI's next take. The flush runs over a fake row backend whose
// transaction can be held at its COMMIT.

const rig = {
  calls: 0,
  gate: null as Promise<void> | null,
  fail: false,
  on: true,
};

function answer(text: string): any[] {
  if (text === LOCK_SQL) return [{ now: new Date('2026-11-13T10:00:00.000Z') }];
  if (text === UPSERT_SQL) return [{ rev: '1' }];
  return [];
}

const fake: RowBackend = {
  async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
    rig.calls += 1;
    const plan = sharedPlan(() => spec.statements(null));
    if (!Array.isArray(plan)) return plan;
    const queue = [...plan];
    while (queue.length > 0) {
      const st = queue.shift()!;
      const rows = answer(st.text);
      const after = st.next?.({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as any);
      if (Array.isArray(after)) queue.unshift(...after);
      else if (after) return { kind: 'stopped', value: after.stop };
    }
    if (rig.gate) await rig.gate;
    if (rig.fail) return { kind: 'failed', step: 'statements', detail: 'Connection terminated unexpectedly' };
    spec.onCommitSent?.();
    return { kind: 'committed', results: [] };
  },
};

function gate(): () => void {
  let open!: () => void;
  rig.gate = new Promise<void>(resolve => { open = resolve; });
  return open;
}

const fileOf = (dir: string, name: string) => dataPath('global', dir, name);

function accept(dir: string, name: string, value: unknown): RowTicket {
  return rowQueue.accept(`global/${dir}/${name}`, fileOf(dir, name), { body: Buffer.from(JSON.stringify(value)) }, { sha: 'absent', caller: true });
}

async function ticks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
}

function heldStoreLanding(): () => void {
  let open!: () => void;
  const held = new Promise<void>(resolve => { open = resolve; });
  useStoreLanding({
    acquire: async () => { await held; return { release: () => undefined }; },
    locked: fn => fn(),
  });
  return open;
}

let error: { mock: { calls: unknown[][] } };

beforeEach(() => {
  _resetRowQueue();
  rig.calls = 0;
  rig.gate = null;
  rig.fail = false;
  rig.on = true;
  configureRowFlush({ backend: () => (rig.on ? fake : null) });
  fs.mkdirSync(dataPath('global', 'rp1'), { recursive: true });
  fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  _resetRowQueue();
  useStoreLanding(null);
  configureRowFlush({ backend: () => null });
  vi.restoreAllMocks();
});

describe('a stored op', () => {
  it('counts once among the row ops stored', async () => {
    const before = rowOpsLanded();
    const t = accept('rp1', 'count.json', { n: 1 });
    await flushRows();
    expect(rowTicketState(t)).toBe('landed');
    expect(rowOpsLanded()).toBe(before + 1);
    expect(fs.readFileSync(fileOf('rp1', 'count.json'), 'utf8')).toBe('{"n":1}');
  });

  it("an App Store key's op wakes its waiters as soon as it is stored, while its landing block waits for the store mutex", async () => {
    const open = heldStoreLanding();
    const t = accept('appstore', 'wake.json', { s: 1 });
    let woke: string | null = null;
    void rowChange(t).then(() => { woke = t.op.state; });
    await vi.waitFor(() => expect(woke).not.toBeNull(), { timeout: 1000, interval: 5 });
    expect(woke).toBe('store');
    expect(rowCommitOwed(t)).toBe(true);
    expect(rowTicketState(t)).toBe('open');
    open();
    await flushRows();
  });
});

describe('the deposition', () => {
  it("an App Store key's op stored after the deposition lands with no mirror written", async () => {
    const open = gate();
    const t = accept('appstore', 'late.json', { s: 2 });
    await vi.waitFor(() => expect(rig.calls).toBe(1), { timeout: 1000, interval: 5 });
    deposeRows('node-b/proc-2');
    open();
    await flushRows();
    expect(rowTicketState(t)).toBe('landed');
    expect(rowCommitOwed(t)).toBe(false);
    expect(rowQueue.ops('global/appstore/late.json')).toHaveLength(0);
    expect(fs.existsSync(fileOf('appstore', 'late.json'))).toBe(false);
  });

  it("an App Store key's op waiting for its landing block lands at the deposition, and its block never runs", async () => {
    const open = heldStoreLanding();
    const t = accept('appstore', 'held.json', { s: 3 });
    await vi.waitFor(() => expect(t.op.state).toBe('store'), { timeout: 1000, interval: 5 });
    deposeRows('node-b/proc-2');
    expect(rowTicketState(t)).toBe('landed');
    expect(rowQueue.ops('global/appstore/held.json')).toHaveLength(0);
    open();
    await flushRows();
    expect(fs.existsSync(fileOf('appstore', 'held.json'))).toBe(false);
  });

  it('a second deposition keeps the words of the first: a try that fails after both names the first holder', async () => {
    const open = gate();
    rig.fail = true;
    const t = accept('rp1', 'words.json', { w: 1 });
    await vi.waitFor(() => expect(rig.calls).toBe(1), { timeout: 1000, interval: 5 });
    deposeRows('node-b/proc-2');
    deposeRows('node-c/proc-3');
    open();
    await flushRows();
    expect(rowTicketState(t)).toBe('refused');
    expect(t.op.refusal).toEqual({ cause: 'writer-lost' });
    const lines = error.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[Data] Not saved'));
    expect(lines).toEqual([`[Data] Not saved: ${fileOf('rp1', 'words.json')}; another process (node-b/proc-2) took the data files' lock`]);
  });
});

describe('the reopen', () => {
  it('after a deposition, the flush sends the op accepted meanwhile and it lands', async () => {
    deposeRows('node-b/proc-2');
    const t = accept('rp1', 'reopen.json', { r: 1 });
    await ticks();
    expect(rig.calls).toBe(0);
    reopenRows();
    expect(rowsDeposed()).toBe(false);
    await vi.waitFor(() => expect(rowTicketState(t)).toBe('landed'), { timeout: 1000, interval: 5 });
    expect(rig.calls).toBe(1);
  });

  it('with no deposition, it starts no send', async () => {
    rig.on = false;
    const t = accept('rp1', 'idle.json', { r: 2 });
    await ticks();
    rig.on = true;
    reopenRows();
    await ticks();
    expect(rig.calls).toBe(0);
    expect(rowTicketState(t)).toBe('open');
  });
});
