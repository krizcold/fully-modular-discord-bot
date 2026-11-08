import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  closeMaintenanceGate,
  enterMaintenance,
  handleMaintenanceIpc,
} from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceFilePath } from '../../src/utils/maintenanceFile';
import { BotManager, childHeldOf } from '../../src/webui/botManager';
import { _resetRowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { installHoldingChooser, type Hold } from '../helpers/nb6Hold';
import { scriptedBackend } from '../helpers/scriptedPg';
import { pgError, sharedRows } from '../helpers/sharedRows';

// NB6 test 66 (wip-redesign/sheets/NB6.md C6, cells 426 to 429; part 7): the held counts of row ops through the real
// saveHeldWrites, enterMaintenance and the leave loop, over the real PostgresBackend on scripted clients answering as
// the shared tables do, set held (a chooser that confirms only when the row says so) or latched.

const CATEGORY = 'nb6held';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };

const UPSERT = /^INSERT INTO smdb_data\.shared_docs/;
const OPS_READ = 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)';
const T36 = (n: number) => `${n} file(s) hold a save the database did not answer, which may have landed`;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let hold: Hold;
let warns: string[];
let errors: string[];
const sent: any[] = [];
const restarts = () => sent.filter(m => m.type === 'control:restart-bot');

beforeEach(() => {
  warns = [];
  errors = [];
  sent.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  _resetMaintenance();
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ leaveRetryMs: 30, filePollMs: 20, restartResendMs: 60, leaveSaveBoundMs: 100 });
  fs.rmSync(maintenanceFilePath(), { force: true });
  _resetRowQueue();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  hold = installHoldingChooser(rig.backend);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  _resetMaintenance();
  _setMaintenanceSender(null);
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  vi.restoreAllMocks();
});

function save(name: string, value: unknown): RowTicket {
  const ticket = (dm.saveDataTracked(name, opts, value) as { ticket?: { kind: string } }).ticket;
  expect(ticket?.kind).toBe('row');
  return ticket as unknown as RowTicket;
}

/** An op whose COMMIT answer was lost: it holds one unknown id, no attempt on the wire, and the backend is held. */
async function unanswered(name: string): Promise<RowTicket> {
  let commits = 0;
  rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? 'lose' : undefined);
  const ticket = save(name, { v: 1 });
  await dm.flushAll();
  expect(ticket.op.state).toBe('queued');
  expect(ticket.op.unknown).toHaveLength(1);
  expect(rig.backend.holdWords()).not.toBeNull();
  return ticket;
}

describe('cell 426: NB5\'s hold refuses the attempt at checkout', () => {
  it('saveHeldWrites calls confirmNow while held; nothing is sent; the op counts in unsavedFiles', async () => {
    rig.connect.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }));
    const ticket = save('c426.json', { v: 1 });
    await dm.flushAll();
    expect(rig.backend.holdWords()).not.toBeNull();
    const sentBefore = rig.sent.length;
    const left = await dm.saveHeldWrites(300);
    expect(hold.confirms).toBeGreaterThan(0);
    expect(rig.sent.length).toBe(sentBefore);
    expect(ticket.op.state).toBe('queued');
    expect(left).toEqual({ unsavedGuilds: 0, unsavedFiles: 1, unansweredGuilds: 0, unconfirmedFiles: 0 });
  });

  it('once the hold ends the drain stores the op, and nothing is held', async () => {
    rig.connect.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }));
    const ticket = save('c426b.json', { v: 1 });
    await dm.flushAll();
    hold.release();
    const left = await dm.saveHeldWrites(2000);
    expect(rowTicketState(ticket)).toBe('landed');
    expect(left).toEqual({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 });
  });
});

describe('cell 428: the maintenance hook with one row op holding an unknown id', () => {
  it('answers saved null with unansweredFiles 1, and logs T36', async () => {
    await unanswered('c428.json');
    const answer = await enterMaintenance('m', { handlerWaitMs: 0, saveBoundMs: 200 });
    expect(answer).toEqual({ saved: null, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 1 });
    expect(warns).toContain(`[Maintenance] ${T36(1)}; can't confirm whether every change this process held is saved`);
  });

  it('the counts: an op queued with no unknown id is unsaved, one holding an unknown id is unanswered', async () => {
    await unanswered('c428a.json');
    // The database answers the landing check and the upsert with a serialization failure: each try ends with no outcome.
    rows.fault = sql => (UPSERT.test(sql) || sql === OPS_READ ? pgError('40001') : undefined);
    hold.release();
    const plain = save('c428b.json', { v: 1 });
    await dm.flushAll();
    expect(plain.op.state).toBe('queued');
    expect(plain.op.unknown).toEqual([]);
    const answer = await enterMaintenance('m', { handlerWaitMs: 0, saveBoundMs: 200 });
    expect(answer).toEqual({ saved: false, unsavedGuilds: 0, unsavedFiles: 1, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 1 });
    expect(warns).toContain(`[Maintenance] 0 guild(s) and 1 file(s) hold changes that could not be saved; ${T36(1)}`);
  });
});

describe('cell 429: the leave step while a row op holds an unknown id', () => {
  it('waits as for unansweredGuilds, reports held with unansweredFiles and T36, then restarts once the op lands', async () => {
    const ticket = await unanswered('c429.json');
    closeMaintenanceGate('hook', 'm');
    await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l429', data: {} });
    await vi.waitFor(() => expect(sent).toContainEqual({
      type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unansweredFiles: 1 } },
    }), { timeout: 10_000 });
    expect(restarts()).toHaveLength(0);
    expect(warns.some(line => line.startsWith(`[Maintenance] ${T36(1)}; the bot process keeps them and tries again in `))).toBe(true);
    const held = errors.filter(line => line.startsWith('[Maintenance] ') && line.includes('holding a save the database did not answer, which may have landed'));
    expect(held).toHaveLength(1);
    expect(held[0]).toContain('3 saves in a row left 1 file(s) holding a save the database did not answer, which may have landed; ');
    expect(held[0]).toContain('does not restart until they are saved or found stored');
    hold.release();
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 10_000 });
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rows.docs.get(keyOf('c429.json'))).toBeDefined();
  }, 20_000);
});

describe('cell 427 (the hook\'s half): latched, the save skips the row ops and counts them', () => {
  it('nothing is sent while latched; the queued op counts in unsavedFiles, the one holding an unknown id in unansweredFiles', async () => {
    await unanswered('c427a.json');
    hold.release();
    rig.backend.latch({ kind: 'tie', generation: 2 });
    save('c427b.json', { v: 1 });
    await dm.flushAll();
    const sentBefore = rig.sent.length;
    const started = Date.now();
    const left = await dm.saveHeldWrites(2000);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(rig.sent.length).toBe(sentBefore);
    expect(left).toEqual({ unsavedGuilds: 0, unsavedFiles: 1, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 1 });
  });
});

describe('cell 427: the exit drain while latched', () => {
  /** The exit drain runs once a process and closes the facade: a fresh data layer of its own. */
  async function freshLayer() {
    vi.resetModules();
    (await import('../helpers/backendKind')).setBackendKind('postgres');
    const fresh = await import('../../src/bot/internalSetup/utils/dataManager');
    const store = await import('../../src/bot/internalSetup/utils/sharedStore');
    const scripted = await import('../helpers/scriptedPg');
    const freshRows = sharedRows();
    const freshRig = scripted.scriptedBackend(freshRows.answer);
    fresh.setGuildDataBackend(freshRig.backend);
    return { fresh, store, freshRig };
  }

  it('skips the row ops; the drain ends on the files, and its log counts the queued op', async () => {
    const listeners = process.listeners('uncaughtException');
    const { fresh, store, freshRig } = await freshLayer();
    try {
      freshRig.backend.latch({ kind: 'tie', generation: 2 });
      const res = fresh.saveDataTracked('c427x.json', opts, { v: 1 }) as { ticket?: { kind: string; op: { state: string } } };
      expect(res.ticket?.kind).toBe('row');
      await fresh.flushAll();
      const sentBefore = freshRig.sent.length;
      const started = Date.now();
      await fresh.drainForExit(5000);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(freshRig.sent.length).toBe(sentBefore);
      expect(res.ticket!.op.state).toBe('queued');
      expect(warns).toContain('[Data] Shutdown drain left 1 file(s) with queued writes');
    } finally {
      fresh.setGuildDataBackend(null);
      store._resetRowQueue();
      await freshRig.backend.stop();
      for (const l of process.listeners('uncaughtException')) if (!listeners.includes(l)) process.off('uncaughtException', l);
    }
  });
});

describe('the web UI\'s relays of unansweredFiles (C6)', () => {
  it('the hook\'s null answer reaches the route with unansweredFiles and T36 in its note', async () => {
    await unanswered('relay.json');
    const answer = await enterMaintenance('m', { handlerWaitMs: 0, saveBoundMs: 200 });
    const relayed = await (BotManager.prototype as any).enterMaintenance.call({
      isRunning: () => true, botProcess: {}, stageReached: () => true, sendIPCMessage: vi.fn(async () => answer),
    }, 'm');
    expect(relayed).toEqual({
      saved: null, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 1,
      note: `${T36(1)}; can't confirm whether the held changes were saved`,
    });
  });

  it('a false answer keeps unansweredFiles beside the unsaved counts', async () => {
    const relayed = await (BotManager.prototype as any).enterMaintenance.call({
      isRunning: () => true, botProcess: {}, stageReached: () => true,
      sendIPCMessage: vi.fn(async () => ({ saved: false, unsavedGuilds: 0, unsavedFiles: 1, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 2 })),
    }, 'm');
    expect(relayed).toEqual({
      saved: false, unsavedGuilds: 0, unsavedFiles: 1, unansweredFiles: 2,
      note: `0 guild(s) and 1 file(s) hold changes that could not be saved; ${T36(2)}`,
    });
  });

  it('the held report keeps unansweredFiles only above 0, and the migration check names it', () => {
    expect(childHeldOf('held', { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unansweredFiles: 1 }))
      .toEqual({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unansweredFiles: 1 });
    expect(childHeldOf('held', { unsavedGuilds: 0, unsavedFiles: 1, unansweredGuilds: 0, unansweredFiles: 0 }))
      .toEqual({ unsavedGuilds: 0, unsavedFiles: 1, unansweredGuilds: 0 });
    const state = (over: object) => (BotManager.prototype as any).migrationBotState.call({
      operationInProgress: false, stoppingRestart: false, queuedRestart: false, isRunning: () => true,
      childMaintenanceBoot: false, childModeReported: true, childEnterAnswer: null, childHeld: null, ...over,
    });
    expect(state({ childMode: 'held', childHeld: { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unansweredFiles: 1 } })).toEqual({
      ok: false, error: `can't confirm whether every change the bot held is saved: ${T36(1)}`,
    });
    expect(state({ childMode: 'maintenance', childEnterAnswer: { saved: null, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 1 } })).toEqual({
      ok: false, error: `can't confirm whether every change the bot held is saved: ${T36(1)}`,
    });
  });
});
