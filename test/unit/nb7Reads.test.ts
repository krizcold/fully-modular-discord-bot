import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BOT_DOWN_DATABASE_NOTICE, readServedGuild } from '../../src/webui/utils/servedRead';
import { WebuiDataReader, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';

const READER_ENTRY = 'postgres://reader:pw@db.example:5432/smdb';
import { ROUTE_TEXT } from '../../src/webui/botManager';
import { fakeBot, GUILD, heldRow, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

// NB7 decision 10: a read of a server this machine's bot does not run comes from the database with a notice that names
// the machine; the database read is the guild_data row under the canonical key, on the reader pool.

const target = { guildId: GUILD, module: 'm', filename: 'a.json', path: '/data/x/m/a.json' };
const HELD_NOTICE = (name: string) => `This server runs on ${name}: this was read from the database, and a change ${name} has not saved yet is not in it.`;
const NO_HOLDER_NOTICE = "No machine runs this server's shard right now: this was read from the database.";
const pgError = (code: string, message = 'refused') => Object.assign(new Error(message), { code });

let rig: Rig;
beforeEach(() => {
  rig = nb7Rig();
  rig.docs.set(`${GUILD}/m/a.json`, '{"a":1}');
});
afterEach(() => {
  setWebuiDataStoreUrl(null);
  resetNb7();
  vi.restoreAllMocks();
});

const notHeldBot = () => fakeBot({ read: () => ({ ok: false, code: 'not-held' }) }).bot;
const downBot = () => fakeBot({ route: { ok: false, code: 'bot-down' }, read: () => ({ ok: false, code: 'bot-down', error: 'bot process is not running' }) }).bot;
const startingBot = () => fakeBot({ read: () => ({ ok: false, code: 'starting', error: ROUTE_TEXT.starting }) }).bot;

describe('after not-held', () => {
  it('a held row on another machine: the database read with the notice naming it', async () => {
    expect(await readServedGuild(notHeldBot(), target)).toEqual({ ok: true, content: '{"a":1}', notice: HELD_NOTICE('BRAVO') });
    expect(rig.readDocCalls[0]).toMatchObject({ guildId: GUILD, module: 'm', filename: 'a.json' });
    expect(rig.readDocCalls[0].boundMs).toBeLessThanOrEqual(5000);
    expect(rig.holderCalls[0].boundMs).toBeLessThanOrEqual(10_000);
  });

  it('a held row on this machine: the database read, naming this machine', async () => {
    rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a', holder_name: 'ALPHA' })] });
    expect(await readServedGuild(notHeldBot(), target)).toEqual({ ok: true, content: '{"a":1}', notice: HELD_NOTICE('ALPHA') });
  });

  it('no holder: the no-holder notice', async () => {
    rig.holder = () => ({ rows: [heldRow({ expires_up_ms: '100' })] });
    expect(await readServedGuild(notHeldBot(), target)).toEqual({ ok: true, content: '{"a":1}', notice: NO_HOLDER_NOTICE });
  });

  it('a check that fails: 503 naming why', async () => {
    rig.holder = () => pgError('42501', 'denied');
    expect(await readServedGuild(notHeldBot(), target)).toEqual({
      ok: false, status: 503,
      error: "This machine's bot does not run this server, and the database could not be read to find the one that does (SQLSTATE 42501: denied); nothing was changed. Try again in a moment.",
    });
  });
});

describe('after bot-down or an NB10 refusal', () => {
  it('a row on this machine, bot down: as today, the bot-down notice', async () => {
    rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a', holder_name: 'ALPHA' })] });
    expect(await readServedGuild(downBot(), target)).toEqual({ ok: true, content: '{"a":1}', notice: BOT_DOWN_DATABASE_NOTICE });
  });

  it('a row on this machine, the bot starting: NB10\'s refusal, as today', async () => {
    rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a', holder_name: 'ALPHA' })] });
    expect(await readServedGuild(startingBot(), target)).toMatchObject({ ok: false, status: 503, error: ROUTE_TEXT.starting });
  });

  it('a row on another machine, bot down or starting: the remote notice', async () => {
    expect(await readServedGuild(downBot(), target)).toEqual({ ok: true, content: '{"a":1}', notice: HELD_NOTICE('BRAVO') });
    expect(await readServedGuild(startingBot(), target)).toEqual({ ok: true, content: '{"a":1}', notice: HELD_NOTICE('BRAVO') });
  });

  it('a check that fails: what the read answered before NB7', async () => {
    rig.holder = () => new Error('connect ECONNREFUSED');
    expect(await readServedGuild(downBot(), target)).toEqual({ ok: true, content: '{"a":1}', notice: BOT_DOWN_DATABASE_NOTICE });
    expect(await readServedGuild(startingBot(), target)).toMatchObject({ ok: false, error: ROUTE_TEXT.starting });
  });

  it('no read opens a request session', async () => {
    await readServedGuild(notHeldBot(), target);
    await readServedGuild(downBot(), target);
    expect(rig.connects).toHaveLength(0);
  });
});

describe('the reader\'s readDoc', () => {
  function reader() {
    const sent: any[] = [];
    const r = new WebuiDataReader();
    const client = {
      query: async (q: any, values?: any[]) => {
        const cfg = typeof q === 'string' ? { text: q, values } : q;
        sent.push(cfg);
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client, query: async (text: string, values: any[]) => client.query(text, values), end: async () => undefined, on: () => undefined };
    (r as any).pool = pool;
    setWebuiDataStoreUrl({ url: READER_ENTRY });
    (r as any).poolUrl = READER_ENTRY;
    return { r, sent };
  }

  it('reads the guild_data row only, under the canonical key, bounded at 5 s; no exists', async () => {
    const { r, sent } = reader();
    const exists = vi.spyOn(r, 'exists');
    expect(await r.readDoc(GUILD, 'm', 'sub/../a.json')).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/smdb_data\.guild_data\b/);
    expect(sent[0].text).not.toMatch(/guild_append/);
    expect(sent[0].values).toEqual([GUILD, 'm', 'a.json']);
    expect(sent[0].query_timeout).toBeGreaterThan(4900);
    expect(sent[0].query_timeout).toBeLessThanOrEqual(5000);
    expect(exists).not.toHaveBeenCalled();
  });

  it('a key with only appended lines reads as absent', async () => {
    const { r, sent } = reader();
    const client = await (r as any).pool.connect();
    const query = client.query;
    client.query = async (q: any, values?: any[]) => {
      const cfg = typeof q === 'string' ? { text: q, values } : q;
      if (/guild_append/.test(cfg.text)) {
        sent.push(cfg);
        return { rows: [{ doc: 'x\n', chunk: 'x\n' }] };
      }
      return query(q, values);
    };
    expect(await r.readDoc(GUILD, 'm', 'log.jsonl')).toBeNull();
    expect(sent.some(s => /guild_append/.test(s.text))).toBe(false);
  });

  describe('a stalled hand-out ends at 5 s', () => {
    afterEach(() => { vi.useRealTimers(); });

    it.each([
      ['every connection busy', 2, 0, "every connection of the web UI's reader pool was in use for 5 s"],
      ['no connection taken', 0, 0, 'the database did not take a connection within 5 s'],
    ])('%s', async (_what, total, idle, text) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const r = new WebuiDataReader();
      (r as any).pool = { connect: () => new Promise(() => undefined), totalCount: total, idleCount: idle, end: async () => undefined, on: () => undefined };
      setWebuiDataStoreUrl({ url: READER_ENTRY });
      (r as any).poolUrl = READER_ENTRY;
      let failure: unknown;
      let settled = false;
      void r.readDoc(GUILD, 'm', 'a.json').then(() => { settled = true; }, error => { settled = true; failure = error; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((failure as Error).message).toBe(text);
    });
  });
});
