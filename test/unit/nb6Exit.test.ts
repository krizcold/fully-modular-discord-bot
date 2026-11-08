import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetMaintenance, _setMaintenanceSender, enterMaintenance } from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceFilePath } from '../../src/utils/maintenanceFile';
import { _resetRowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { pgError, sharedRows } from '../helpers/sharedRows';

// NB6 test 20 (wip-redesign/sheets/NB6.md row 74 and C6; part 7): the maintenance hook's save waits for the row ops
// as it waits for the file queue, and its unsavedFiles counts the shared keys it could not store.

const CATEGORY = 'nb6exit';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const UPSERT = /^INSERT INTO smdb_data\.shared_docs/;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetMaintenance();
  _setMaintenanceSender(() => undefined);
  fs.rmSync(maintenanceFilePath(), { force: true });
  _resetRowQueue();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
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

describe('row 74: the maintenance hook and the row ops', () => {
  it('a key whose first try failed is stored by the hook\'s save, not left to its backoff', async () => {
    let upserts = 0;
    rows.fault = sql => (UPSERT.test(sql) && ++upserts === 1 ? pgError('40001') : undefined);
    const ticket = save('a.json', { v: 1 });
    await dm.flushAll();
    expect(ticket.op.state).toBe('queued');
    expect(ticket.op.retryAt).toBeGreaterThan(Date.now());
    expect(await enterMaintenance('m', { handlerWaitMs: 0, saveBoundMs: 2000 })).toEqual({ saved: true });
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rows.docs.get(keyOf('a.json'))!.body.toString('utf8')).toBe(JSON.stringify({ v: 1 }, null, 2));
  });

  it('the keys the database does not take are counted in unsavedFiles', async () => {
    rows.fault = sql => (UPSERT.test(sql) ? pgError('40001') : undefined);
    save('b.json', { v: 1 });
    save('c.json', { v: 1 });
    expect(await enterMaintenance('m', { handlerWaitMs: 0, saveBoundMs: 300 }))
      .toEqual({ saved: false, unsavedGuilds: 0, unsavedFiles: 2, unansweredGuilds: 0, unconfirmedFiles: 0 });
  });
});

describe('sharedWritesSettled (decision 39)', () => {
  it('false while a row op is in the queue, true once it is stored and its mirror written', async () => {
    expect(dm.sharedWritesSettled()).toBe(true);
    save('d.json', { v: 1 });
    expect(dm.sharedWritesSettled()).toBe(false);
    await dm.flushAll();
    expect(dm.sharedWritesSettled()).toBe(true);
  });
});
