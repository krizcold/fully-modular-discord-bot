import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { setGuildDataBackend, writeRawAtomicTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowQueue, useWebuiSessions, type WebuiSessionDeps } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { carryWrites } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const CATEGORY = 'rs2rowcancel';
const KEY = `global/${CATEGORY}/r.json`;
const FILE = dataPath('global', CATEGORY, 'r.json');
const A = 'postgres://bot:pw@a.example:5432/bot';
const OTHER = 6465;
const live = new Set<number>([process.pid, OTHER]);
const CANT_USE = "the web panel cannot use the bot's main database now: choosing the main database";

let s: ReturnType<typeof webuiSessions>;
let manager: BotManager;

function deps(): WebuiSessionDeps {
  return {
    target: async () => ({ refusal: 'choosing the main database', held: false }),
    commitCheck: () => null,
    select: async (text, values) => {
      const res = await s.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:M',
    session: config => s.session(config as Record<string, unknown>),
  };
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  freshWriterLock('webui', live);
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  setGuildDataBackend(null);
  s = webuiSessions();
  manager = new BotManager();
  useWebuiSessions(deps());
});

afterEach(() => {
  useWebuiSessions(null);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  freshWriterLock('webui');
  vi.restoreAllMocks();
});

async function cancelledRowWith(reply: Record<string, unknown>): Promise<any> {
  return manager.runLocalOp('write', async () => {
    expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
    await vi.waitFor(() => expect(rowQueue.entryOf(KEY)?.triesFailed).toBeGreaterThanOrEqual(1));
    return reply;
  });
}

describe('a cancelled row op of an op that saved part of its change', () => {
  it('a reply marked partial answers not saved in full', async () => {
    const reply = await cancelledRowWith({ ok: true, partial: true, result: 1 });
    expect(reply).toEqual({
      ok: false, status: 503, code: 'disk',
      error: `The database did not take the write of r.json (${CANT_USE}), so your change was not saved in full. Try again in a moment.`,
    });
  });

  it('a reply whose writes cannot be known answers not saved in full', async () => {
    const writes = { tickets: [], refused: false, unknowable: true, landedBefore: false };
    const reply = await cancelledRowWith(carryWrites({ ok: true, result: 1 }, writes));
    expect(reply).toEqual({
      ok: false, status: 503, code: 'disk',
      error: `The database did not take the write of r.json (${CANT_USE}), so your change was not saved in full. Try again in a moment.`,
    });
  });

  it('a reply with neither answers not saved', async () => {
    const writes = { tickets: [], refused: false, unknowable: false, landedBefore: false };
    const reply = await cancelledRowWith(carryWrites({ ok: true, result: 1 }, writes));
    expect(reply.error).toBe(`The database did not take the write of r.json (${CANT_USE}), so your change was not saved. Try again in a moment.`);
  });
});
