import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRowQueue,
  configureRowFlush,
  flushRows,
  rowQueue,
  rowTicketState,
  UPSERT_SQL,
} from '../../src/bot/internalSetup/utils/sharedStore';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

// L5 run A, chunk rp8: an upsert of a doc whose RETURNING answers no row (a row trigger that returned NULL) still ends
// in the op id and the notification, the notification naming no rev; the flush does not fail building the statements.

const CATEGORY = 'rp8upsert';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const file = (name: string) => dataPath('global', CATEGORY, name);

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  _resetRowQueue();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend((sql, params, call, client) => (sql === UPSERT_SQL ? { rows: [], rowCount: 0 } : rows.answer(sql, params, call, client)));
  configureRowFlush({ backend: () => rig.backend });
});

afterEach(async () => {
  configureRowFlush({ backend: () => null });
  _resetRowQueue();
  await rig.backend.stop();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('an upsert that returns no row', () => {
  it('the op commits with its op id and a notification whose rev is null, and lands', async () => {
    const body = Buffer.from(JSON.stringify({ v: 1 }));
    const ticket = rowQueue.accept(keyOf('a.json'), file('a.json'), { body }, { sha: 'absent', caller: false });
    await flushRows();
    expect(ticket.op.refusal).toBeNull();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rig.sent.some(s => s.sql === UPSERT_SQL)).toBe(true);
    expect(rows.ops.size).toBe(1);
    expect(rows.notices.map(n => JSON.parse(n))).toEqual([{ k: 'doc', key: keyOf('a.json'), sha: sha(body), rev: null, by: processId() }]);
    expect(errors.filter(line => /Cannot read|Not saved/.test(line))).toEqual([]);
  });
});
