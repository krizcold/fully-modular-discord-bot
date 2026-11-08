import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 15 (part 10): on one machine of a Postgres bot, NB10's routing orders the writers of a shared key: the bot
// process takes a shared op while it runs, else the web UI's local chain, which stores the row on its own session
// (row 23); an operator who saves again with the old expectSha meets NB10's executor compare once the first save is
// stored (row 24).

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});

import { BotManager } from '../../src/webui/botManager';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, shaOf, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { forks } from '../helpers/forkMock';
import { freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const CATEGORY = 'nb6onemachine';
const KEY = `global/${CATEGORY}/c.json`;
const FILE = dataPath('global', CATEGORY, 'c.json');
const A = 'postgres://bot:pw@a.example:5432/bot';

let s: ReturnType<typeof webuiSessions>;
let manager: BotManager;

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  freshWriterLock('webui');
  resetForks();
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  setGuildDataBackend(null);
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  s = webuiSessions();
  manager = new BotManager();
  useWebuiSessions({
    target: async () => ({ entry: A, tag: '1:M', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      const res = await s.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:M',
    session: config => s.session(config as Record<string, unknown>),
  });
});

afterEach(async () => {
  useWebuiSessions(null);
  await manager.shutdown(true).catch(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  freshWriterLock('webui');
  vi.restoreAllMocks();
});

const write = (expectSha: string, body: unknown) =>
  manager.runSharedOp('global.write', { rel: `${CATEGORY}/c.json`, contentJson: JSON.stringify(body), expectSha });

describe('row 23: the writers of a shared key on one machine', () => {
  it('while the bot process runs, a shared op goes to it; the web UI opens no session', async () => {
    await manager.start();
    forks.children[0].emit('message', { type: 'data:writer', data: { stage: 'shared' } });
    expect(manager.writerRoute('shared')).toEqual({ route: 'child' });
    expect(s.sessions()).toBe(0);
  });

  it('with no bot process, the local chain stores the row on its own session and writes the mirror', async () => {
    const reply = await write('absent', { v: 1 });
    expect(reply).toMatchObject({ ok: true });
    expect(s.rows.docs.get(KEY)?.body.toString()).toBe('{"v":1}');
    expect(fs.readFileSync(FILE, 'utf8')).toBe('{"v":1}');
    expect(s.configs.every(c => c.application_name === 'smdb-webui-shared')).toBe(true);
  });
});

describe("row 24: a repeated save with the old expectSha", () => {
  it("answers NB10's 409 changed once the first save is stored, and the row keeps the first", async () => {
    expect(await write('absent', { v: 1 })).toMatchObject({ ok: true });
    const again = await write('absent', { v: 1 });
    expect(again).toMatchObject({ ok: false, code: 'changed' });
    expect(s.rows.docs.get(KEY)?.sha).toBe(shaOf(Buffer.from('{"v":1}')));
    expect(s.rows.history.filter(h => h.key === KEY)).toHaveLength(1);
  });
});
