import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_DOWN_DATABASE_NOTICE, readServedGlobal, readServedGuild } from '../../src/webui/utils/servedRead';
import { _resetRowQueue, configureRowFlush } from '../../src/bot/internalSetup/utils/sharedStore';
import type { Plan } from '../../src/webui/utils/guildRequests';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { fakeBot, GUILD, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const pgError = (code: string, message = 'refused') => Object.assign(new Error(message), { code });

describe('ru9 the bot-down read of a shared key', () => {
  const target = { rel: 'ru9served/r.json', path: dataPath('global', 'ru9served', 'r.json') };
  const down = { isRunning: () => false } as any;
  const withSelect = (rows: any[]) => configureRowFlush({ backend: () => ({ sharedSelect: async () => ({ rows }) }) as any });

  beforeEach(() => {
    setBackendKind('postgres');
    _resetRowQueue();
  });
  afterEach(() => {
    configureRowFlush({ backend: () => null });
    _resetRowQueue();
    setBackendKind(null);
  });

  it('ru9 with no database connection answers 503 naming why', async () => {
    configureRowFlush({ backend: () => ({}) as any });
    expect(await readServedGlobal(down, target)).toEqual({
      ok: false, status: 503, error: "Can't reach the database to read this file (this process has no connection to the bot's database)",
    });
  });

  it('ru9 a row whose body is text reads that text', async () => {
    withSelect([{ body: '{"s":1}' }]);
    expect(await readServedGlobal(down, target)).toEqual({ ok: true, content: '{"s":1}', notice: BOT_DOWN_DATABASE_NOTICE });
  });

  it('ru9 a row whose body is null reads as empty', async () => {
    withSelect([{ body: null }]);
    expect(await readServedGlobal(down, target)).toEqual({ ok: true, content: '', notice: BOT_DOWN_DATABASE_NOTICE });
  });
});

describe('ru9 a guild read on the Postgres route', () => {
  const target = { guildId: GUILD, module: 'm', filename: 'a.json', path: path.join(dataPath(GUILD), 'm', 'a.json') };
  const STARTING = 'The bot is starting and has not opened its data files yet; nothing was saved. Try again in a moment.';
  let rig: Rig;

  beforeEach(() => {
    rig = nb7Rig();
    rig.docs.set(`${GUILD}/m/a.json`, '{"a":1}');
  });
  afterEach(() => {
    resetNb7();
    setBackendKind(null);
    vi.restoreAllMocks();
  });

  it("ru9 a request plan's database read is bounded by what is left of its deadline", async () => {
    const plan = { kind: 'request', op: 'write', deadline: performance.now() + 1500, holder: { name: 'BRAVO' } } as unknown as Plan;
    const read = await readServedGuild(fakeBot().bot, target, { plan });
    expect(read).toMatchObject({ ok: true, content: '{"a":1}' });
    expect(rig.readDocCalls).toHaveLength(1);
    expect(rig.readDocCalls[0].boundMs).toBeGreaterThan(1000);
    expect(rig.readDocCalls[0].boundMs).toBeLessThanOrEqual(1500);
  });

  it('ru9 a database read that fails answers 503 that the data backend is unreachable', async () => {
    rig.docs = { get: () => { throw new Error('connect ECONNREFUSED'); } } as any;
    const bot = fakeBot({ read: () => ({ ok: false, code: 'not-held' }) }).bot;
    expect(await readServedGuild(bot, target)).toEqual({ ok: false, status: 503, error: 'Data backend unreachable; retry shortly' });
  });

  it("ru9 a local plan whose holder check is refused for maintenance answers with the maintenance code", async () => {
    rig.holder = () => pgError('28000', 'maintenance');
    const plan: Plan = { kind: 'local', op: 'write', deadline: performance.now() + 60_000 };
    const bot = fakeBot({ read: () => ({ ok: false, code: 'not-held' }) }).bot;
    expect(await readServedGuild(bot, target, { plan })).toEqual({
      ok: false, status: 503, error: 'the bot is in maintenance, so nothing was changed', code: 'maintenance',
    });
  });

  it('ru9 a local plan with a starting bot whose error is no text answers the starting text', async () => {
    const plan: Plan = { kind: 'local', op: 'write', deadline: performance.now() + 60_000 };
    const bot = fakeBot({ read: () => ({ ok: false, code: 'starting', error: 42 }) }).bot;
    expect(await readServedGuild(bot, target, { plan })).toEqual({ ok: false, status: 503, error: STARTING });
  });
});
