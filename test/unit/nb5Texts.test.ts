import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// NB5 section 8 test 15: the operator texts the sheet gives, rendered for their cases and matched word for word, and
// every rendered text free of long dashes, curly quotes and the test URLs' password. Texts that only a route or the
// working set renders are matched exactly in their own files (nb5NotifyOwnerRoute, nb5SwitchNoticeRoute,
// nb5AddressesRoute, nb5OwnerChannel, nb5Watch, nb5Settle, nb5Step, nb5Latch, nb5Migration); this file holds the
// texts built by functions, and I2's JSON writer row.

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  // writeGraveyardNote writes the note through the handle of its temp file, .graveyard.json.<pid>.<ms>.<n>.tmp.
  const open = vi.fn(async (file: any, ...rest: any[]) => {
    const fh = await real.promises.open(file, ...rest);
    if (failGraveyardNote.on && /[\\/]\.graveyard\.json\.[^\\/]*$/.test(String(file))) {
      fh.writeFile = () => Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    }
    return fh;
  });
  const promises = { ...real.promises, open };
  return { ...real, promises, default: { ...real, promises } };
});
const failGraveyardNote = vi.hoisted(() => ({ on: false }));

import {
  behindNoticeText, cantCheckText, decideMain, markerTexts, replacedText, tieText, usingLine, type AnsweredProbe, type Probe,
} from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { latchWords, moveCheckTexts, notReadyLine } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { heldClauses } from '../../src/bot/internalSetup/utils/heldWords';
import { notReleasedLine, releaseFailureLine } from '../../src/bot/internalSetup/fleet/shardClaims';
import type { Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { DELETE_TEXTS, RESTORE_TEXTS, deleteGuildNamespace } from '../../src/bot/internalSetup/utils/dataManager';
import { listGraveyardEntries } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { checkAddressList } from '../../src/utils/databaseAddress';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

const PASSWORD = 'pw-secret-9';
const STORE = 'store-a';
const DATE = '2026-11-01T10:00:00.000Z';
const rendered: string[] = [];
const seen = <T extends string>(text: T): T => { rendered.push(text); return text; };

function db(address: string, over: Partial<AnsweredProbe> = {}): AnsweredProbe {
  return {
    kind: 'answered', address, entry: `postgresql://bot:${PASSWORD}@${address}`, inRecovery: false, readOnly: false,
    generation: 1, machine: 'node-a', since: DATE, sysid: `sys-${address}`, started: `start-${address}`, storeId: STORE,
    ...over,
  };
}
const opts = { markerStoreId: STORE, noticeCheckOff: false };
function reasonOf(probes: Probe[], notice?: Parameters<typeof decideMain>[1], o = opts): string {
  const d = decideMain(probes, notice, o);
  if (!('reason' in d)) throw new Error(`no wait: ${d.outcome}`);
  return seen(d.reason);
}
const pairs = (...ids: number[]): Pair[] => ids.map(shardId => ({ shardCount: 4, shardId, claim: 40 }));

afterAll(() => {
  for (const text of rendered) {
    expect(text).not.toMatch(/[\u2013\u2014\u2018\u2019\u201C\u201D]/);
    expect(text).not.toContain(PASSWORD);
  }
});

describe("decision 9's wait reasons and decision 6's lines", () => {
  it('unreachable names each address with its cause', () => {
    expect(reasonOf([
      { kind: 'failed', address: 'a:5432/bot', entry: `postgresql://bot:${PASSWORD}@a:5432/bot`, cause: 'a timeout' },
      { kind: 'failed', address: 'b:5432/bot', entry: `postgresql://bot:${PASSWORD}@b:5432/bot`, cause: 'unreachable (ECONNREFUSED)' },
    ])).toBe('No database in DATA_BACKEND_URL answers (a:5432/bot: a timeout, b:5432/bot: unreachable (ECONNREFUSED))');
  });

  it('login-refused', () => {
    expect(reasonOf([{ kind: 'refused', address: 'a:5432/bot', entry: 'a' }]))
      .toBe("Every database in DATA_BACKEND_URL that answers refuses the bot's login (SQLSTATE 28000); the Bot Manager blocks the login during maintenance");
  });

  it('no-main with a live copy and a read-only database', () => {
    expect(reasonOf([db('a:5432/bot', { inRecovery: true }), db('b:5432/bot', { readOnly: true })]))
      .toBe('No address in DATA_BACKEND_URL reaches a database that accepts writes at main generation 1 (node-a): a:5432/bot is a live copy, b:5432/bot is read-only; the bot waits until the main answers or the owner switches in the Bot Manager');
  });

  it('replaced, worded from the higher row: a remote main seen from a copy machine (R2-RUN-5)', () => {
    expect(reasonOf([db('local:5432/bot', { machine: 'node-a' }), db('remote:5432/bot', { generation: 2, machine: 'node-b', inRecovery: true })]))
      .toBe(`The database at local:5432/bot (generation 1, node-a) was replaced by node-b on ${DATE} (generation 2); the bot stays stopped. If that database is on this machine, rejoin it as a live copy in the Bot Manager; otherwise join the new main's code, or add its address to DATA_BACKEND_URL`);
    expect(seen(replacedText('a:5432/bot', 1, 'node-a', 'node-b', DATE, 2))).toContain('was replaced by node-b on');
  });

  it('tie between two addresses, and a tie from the notice', () => {
    expect(reasonOf([db('a:5432/bot'), db('b:5432/bot', { machine: 'node-b' })]))
      .toBe("Two databases accept writes at main generation 1: a:5432/bot (node-a) and b:5432/bot (node-b); can't confirm which is the main, so the bot stays stopped until the owner chooses one in the Bot Manager");
    expect(seen(tieText(2, 'a:5432/bot (node-a)', 'node-b (node-b)')))
      .toBe("Two databases accept writes at main generation 2: a:5432/bot (node-a) and node-b (node-b); can't confirm which is the main, so the bot stays stopped until the owner chooses one in the Bot Manager");
  });

  it('the two behind-notice texts', () => {
    expect(seen(behindNoticeText('a:5432/bot', 2, 'node-a', { generation: 3, machine: 'node-a', date: DATE })))
      .toBe(`can't confirm that a:5432/bot is the main: it holds generation 2, but generation 3 was announced for this machine (node-a) on ${DATE}; a restore may have lowered it. The bot stays stopped until the Bot Manager raises this database's generation to 3 or above`);
    expect(seen(behindNoticeText('a:5432/bot', 2, 'node-a', { generation: 3, machine: 'node-b', date: DATE })))
      .toBe(`can't confirm that a:5432/bot is the main: it holds generation 2 (node-a), but generation 3 was announced for node-b on ${DATE}, and no database in DATA_BACKEND_URL holds it. The bot stays stopped. If node-b holds the main now and a:5432/bot is on this machine, rejoin it as a live copy in the Bot Manager; otherwise join the new main's code or add its address to DATA_BACKEND_URL. If a restore lowered this database's generation, the Bot Manager must raise it to 3 or above`);
  });

  it('cant-check, with the next step only for a 4xx other than 429', () => {
    expect(seen(cantCheckText('a:5432/bot', 2, { cause: 'HTTP 403 (Missing Access)', status: 403 })))
      .toBe("can't confirm that a:5432/bot (generation 2) is still the main: the switch notices could not be read (HTTP 403 (Missing Access)); fix the bot's DMs with its owner, or set DATA_NOTICE_CHECK=off to rely on the databases alone");
    expect(seen(cantCheckText('a:5432/bot', 2, { cause: 'HTTP 429 (rate limited, retry after 8 s)', status: 429 })))
      .toBe("can't confirm that a:5432/bot (generation 2) is still the main: the switch notices could not be read (HTTP 429 (rate limited, retry after 8 s))");
    expect(seen(cantCheckText('a:5432/bot', 2, { cause: 'a timeout' })))
      .toBe("can't confirm that a:5432/bot (generation 2) is still the main: the switch notices could not be read (a timeout)");
  });

  it('mixed-stores', () => {
    expect(reasonOf([db('a:5432/bot'), db('b:5432/bot', { storeId: 'store-b' })], undefined, { markerStoreId: null as unknown as string, noticeCheckOff: false }))
      .toBe('DATA_BACKEND_URL reaches databases of different bots (store store-a at a:5432/bot, store store-b at b:5432/bot) and this machine records no store id yet; remove the wrong address');
  });

  it('the Using lines at a generation and at 0', () => {
    expect(seen(usingLine('a:5432/bot', 2, 'node-a'))).toBe('[Database] Using a:5432/bot (generation 2, node-a): the database that accepts writes with the highest main generation');
    expect(seen(usingLine('a:5432/bot', 0, null))).toBe('[Database] Using a:5432/bot: it accepts writes and no main generation is recorded');
  });
});

describe("decision 11's <why> for the three causes", () => {
  it.each([
    [{ kind: 'replaced', machine: 'node-b', generation: 2 } as const, 'a:5432/bot was replaced by node-b (generation 2)'],
    [{ kind: 'tie', generation: 2 } as const, "can't confirm that a:5432/bot is still the main (another database accepts writes at generation 2)"],
    [{ kind: 'behind-notice', machine: 'node-b', generation: 3 } as const, "can't confirm that a:5432/bot is still the main (generation 3 was announced for node-b)"],
  ])('%j', (cause, text) => {
    expect(seen(latchWords(cause, 'a:5432/bot'))).toBe(text);
  });
});

describe('NB5F: the texts of a marker that cannot be read, the move check and the bootstrap line', () => {
  const why = "/data/.backend.json cannot be read (EACCES: permission denied, open '/data/.backend.json')";

  it("T1, T3 to T5 and T7, the chooser's", () => {
    expect(seen(markerTexts.bootWait(why))).toBe(`${why}, so the bot can't confirm which store this machine records; it chooses no database and reads that file again at every check`);
    expect(seen(markerTexts.notMoving(why))).toBe(`[Database] Not moving yet: ${why}, so the bot can't confirm which store this machine records; this process keeps its unsaved changes and stays stopped`);
    expect(seen(markerTexts.watchOwn(why, 'store-a', 'a:5432/bot'))).toBe(`[Database] ${why}, so the bot can't confirm which store this machine records; until it can, the watch counts only the databases of store store-a, the store at a:5432/bot, and a hold does not end`);
    expect(seen(markerTexts.watchAll(why))).toBe(`[Database] ${why}, so the bot can't confirm which store this machine records; until it can, the watch counts every database that answers, and a hold does not end`);
    expect(seen(markerTexts.step('a:5432/bot', 1, 'b:5432/bot', 'writable', 2, why))).toBe(`can't confirm that this bot process's database a:5432/bot (generation 1) is still the main: b:5432/bot accepts writes at generation 2, and ${why}, so the bot can't tell whether that database holds this bot's store`);
    expect(seen(markerTexts.step('a:5432/bot', 1, 'b:5432/bot', 'live copy', 2, why))).toBe(`can't confirm that this bot process's database a:5432/bot (generation 1) is still the main: b:5432/bot is a live copy at generation 2, and ${why}, so the bot can't tell whether that database holds this bot's store`);
    expect(seen(markerTexts.step('a:5432/bot', 1, 'b:5432/bot', 'read-only', 2, why))).toBe(`can't confirm that this bot process's database a:5432/bot (generation 1) is still the main: b:5432/bot is read-only at generation 2, and ${why}, so the bot can't tell whether that database holds this bot's store`);
    expect(seen(markerTexts.confirming(why))).toBe(`${why}, so the bot can't confirm which store this machine records; checking again`);
  });

  it("T6, the latch's <why> for 'unknown-store', and its variants for a live copy and a read-only database", () => {
    expect(seen(latchWords({ kind: 'unknown-store', other: 'b:5432/bot', generation: 2, standing: 'writable' }, 'a:5432/bot')))
      .toBe("can't confirm that a:5432/bot is still the main (b:5432/bot accepts writes at generation 2, and the store this machine records is unknown)");
    expect(seen(latchWords({ kind: 'unknown-store', other: 'b:5432/bot', generation: 2, standing: 'live copy' }, 'a:5432/bot')))
      .toBe("can't confirm that a:5432/bot is still the main (b:5432/bot is a live copy at generation 2, and the store this machine records is unknown)");
    expect(seen(latchWords({ kind: 'unknown-store', other: 'b:5432/bot', generation: 2, standing: 'read-only' }, 'a:5432/bot')))
      .toBe("can't confirm that a:5432/bot is still the main (b:5432/bot is read-only at generation 2, and the store this machine records is unknown)");
  });

  it('T8 to T17, the move check and the bootstrap line', () => {
    expect(seen(moveCheckTexts.markerUnknown(why))).toBe(`${why}, so the bot can't confirm which store this machine records`);
    expect(seen(moveCheckTexts.version('{"v":5}'))).toBe('the database holds schema version {"v":5}, and this bot reads only version 8');
    expect(seen(moveCheckTexts.empty)).toBe("the database holds no tables in smdb_data, so it holds no copy of this bot's store; a move does not provision a database");
    expect(seen(moveCheckTexts.noStoreId)).toBe("the database's smdb_data matches this bot's schema (version 8) but smdb_data.meta holds no store_id row, and this machine records no store id, so this bot can't confirm whose store it is; a move writes no store id");
    expect(seen(moveCheckTexts.unreadableStoreId)).toBe("its store id can't be read (the stored value is not a JSON string)");
    expect(seen(moveCheckTexts.otherStore('store-x', 'store-a'))).toBe("the configured database is not the one this deployment's data lives in (store store-x vs recorded store-a)");
    expect(seen(moveCheckTexts.incomplete('SQLSTATE 42501: permission denied for schema smdb_data'))).toBe('the check of its store could not be completed (SQLSTATE 42501: permission denied for schema smdb_data)');
    expect(seen(moveCheckTexts.incomplete(moveCheckTexts.silent(40)))).toBe('the check of its store could not be completed (the database did not answer within 40 s)');
    expect(seen(moveCheckTexts.overBound)).toBe('the check of its store did not finish within 60 s');
    expect(seen(moveCheckTexts.notMoving('w:5432/bot', moveCheckTexts.empty))).toBe(`[Database] Not moving to w:5432/bot: the database holds no tables in smdb_data, so it holds no copy of this bot's store; a move does not provision a database; this process keeps its unsaved changes and stays stopped`);
    expect(seen(notReadyLine('a:5432/bot was replaced by node-b (generation 2); this process does not write to it')))
      .toBe('[PostgresBackend] Connected and provisioned; not ready: a:5432/bot was replaced by node-b (generation 2); this process does not write to it');
  });
});

describe("C3: the held clauses with the re-save clause second", () => {
  it('all four counts, in the order g and f, r, u, c', () => {
    expect(seen(heldClauses({ unsavedGuilds: 2, unsavedFiles: 1, resaveGuilds: 40, unansweredGuilds: 3, unconfirmedFiles: 4 }))).toBe(
      "2 guild(s) and 1 file(s) hold changes that could not be saved; 40 guild(s) are not re-saved yet on the bot's main database; their latest changes may exist only in the bot process; 3 guild(s) hold a save the database did not answer, which may have landed; 4 file(s) hold appended lines the disk did not confirm; can't confirm whether they are stored",
    );
  });
  it('only flags', () => {
    expect(seen(heldClauses({ resaveGuilds: 40 }))).toBe("40 guild(s) are not re-saved yet on the bot's main database; their latest changes may exist only in the bot process");
  });
});

describe("D6's not-released line and E3's paused release lines, for one shard and for two", () => {
  const why = 'a:5432/bot was replaced by node-b (generation 2)';
  it('not released', () => {
    expect(seen(notReleasedLine(pairs(3, 1), why, 30_000))).toBe(`[Shards] Shards 1, 3 were not released: ${why}; their claims expire after 30 s`);
    expect(seen(notReleasedLine(pairs(3), why, 30_000))).toBe(`[Shards] Shard 3 was not released: ${why}; its claim expires after 30 s`);
    expect(seen(notReleasedLine([], why, 30_000))).toBe(`[Shards] The release was not sent: ${why}; any shard row still naming this process frees once its claim expires`);
  });

  const failure = { kind: 'timeout' } as Parameters<typeof releaseFailureLine>[1];
  it.each([
    [pairs(1, 3), true, `[Shards] Can't confirm whether the release of shards 1, 3 applied: this process stopped writing to its database while the release waited for its answer (${why}); if it did not apply, any machine with room may take them once their claims expire`],
    [pairs(3), true, `[Shards] Can't confirm whether the release of shards 3 applied: this process stopped writing to its database while the release waited for its answer (${why}); if it did not apply, any machine with room may take them once their claims expire`],
    [[], true, `[Shards] Can't confirm whether the release applied: this process stopped writing to its database while the release waited for its answer (${why}); any shard row still naming this process frees once its claim expires`],
    [pairs(1, 3), false, `[Shards] The release of shards 1, 3 did not apply: this process stopped writing to its database before the release sent its COMMIT (${why}); any machine with room may take them once their claims expire`],
    [[], false, `[Shards] The release did not apply: this process stopped writing to its database before the release sent its COMMIT (${why}); any shard row still naming this process frees once its claim expires`],
  ])('paused release %#', (asked, sent, text) => {
    expect(seen(releaseFailureLine(asked as Pair[], failure, sent as boolean, false, why))).toBe(text);
  });

  it('a pause with no <why> leaves the parenthesis out', () => {
    expect(seen(releaseFailureLine(pairs(2), failure, false, false, null)))
      .toBe('[Shards] The release of shards 2 did not apply: this process stopped writing to its database before the release sent its COMMIT; any machine with room may take them once their claims expire');
  });
});

describe("texts A and B (C7, D5, H8) and G12's refusals", () => {
  const why = 'a:5432/bot was replaced by node-b (generation 2)';
  const old = 'a:5432/bot';
  it('text A and text B for a restore', () => {
    const tail = 'Once the bot runs on the main database, run: smdb graveyard restore 880000000000000001 5 --replace. It is safe whether or not this restore reached that database: it copies entry 5 in and moves whatever the server holds into a new entry, so nothing is lost; if that database lists no entry 5, the restore answers "no graveyard entry for this guild" and changes nothing.';
    expect(seen(RESTORE_TEXTS.late('880000000000000001', { committed: true, old, why }, 5)))
      .toBe(`can't confirm whether server 880000000000000001 was restored on the main database: ${old} confirmed the restore only after this process stopped writing there (${why}). ${tail}`);
    expect(seen(RESTORE_TEXTS.late('880000000000000001', { committed: false, old, why }, 5)))
      .toBe(`can't confirm whether server 880000000000000001 was restored: the database did not confirm the commit, and this process stopped writing to ${old} while it waited (${why}). ${tail}`);
  });

  it('text A and text B for a delete, with H8 sentence', () => {
    const tail = '`smdb graveyard list` reads the data of the bot behind the web panel it asks: once that bot runs on the main database, look there for a new entry of this server with the reason webui-operator-delete, and repeat the delete if there is none.';
    expect(seen(DELETE_TEXTS.late({ committed: true, old, why })))
      .toBe(`can't confirm whether this server's data was deleted on the main database: ${old} confirmed the delete only after this process stopped writing there (${why}). ${tail}`);
    expect(seen(DELETE_TEXTS.late({ committed: false, old, why })))
      .toBe(`can't confirm whether this server's data was deleted: the database did not confirm the commit, and this process stopped writing to ${old} while it waited (${why}). ${tail}`);
  });

  it('the latched and held refusals', () => {
    const held = "the database did not answer; this process checks that a:5432/bot is still the main before writing to it";
    expect(seen(DELETE_TEXTS.latched(why))).toBe(`this bot process stopped writing to its database (${why}); nothing was removed; try again once the bot runs on its main database`);
    expect(seen(DELETE_TEXTS.held(held))).toBe(`this bot process is not writing to its database for now (${held}); nothing was removed; try again in a moment`);
    expect(seen(RESTORE_TEXTS.latched(why))).toBe(`this bot process stopped writing to its database (${why}); nothing was restored; try again once the bot runs on its main database`);
    expect(seen(RESTORE_TEXTS.held(held))).toBe(`this bot process is not writing to its database for now (${held}); nothing was restored; try again in a moment`);
  });
});

describe("decision 18's check of the list", () => {
  it('one entry keeps the plain text; a list names the entry by its position; a good list passes', () => {
    expect(seen(checkAddressList('mysql://a') as string)).toBe('DATA_BACKEND_URL must start with postgresql:// or postgres://');
    expect(seen(checkAddressList(`postgresql://bot:${PASSWORD}@a/bot, mysql://b`) as string)).toBe('entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://');
    expect(checkAddressList(`postgresql://bot:${PASSWORD}@a/bot, postgres://bot:${PASSWORD}@b/bot`)).toBeNull();
  });
});

describe("I2: a JSON delete whose graveyard note cannot be written", () => {
  const G = '880000000000000077';
  afterEach(() => {
    failGraveyardNote.on = false;
    setBackendKind(null);
  });

  it('answers ok and the list holds one entry for the guild with the reason empty', async () => {
    setBackendKind('file');
    fs.mkdirSync(path.join(dataPath(G), 'mod'), { recursive: true });
    fs.writeFileSync(path.join(dataPath(G), 'mod', 'a.json'), '{"a":1}');
    failGraveyardNote.on = true;
    const reply = await deleteGuildNamespace(G, 'webui-operator-delete', 5000);
    expect(reply.ok).toBe(true);
    const entries = (await listGraveyardEntries()).filter(e => e.guildId === G);
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('');
  });

  it('with the note written, the entry carries the reason (the mock above is what empties it)', async () => {
    setBackendKind('file');
    const g = '880000000000000078';
    fs.mkdirSync(path.join(dataPath(g), 'mod'), { recursive: true });
    fs.writeFileSync(path.join(dataPath(g), 'mod', 'a.json'), '{"a":1}');
    expect((await deleteGuildNamespace(g, 'webui-operator-delete', 5000)).ok).toBe(true);
    const entries = (await listGraveyardEntries()).filter(e => e.guildId === g);
    expect(entries.map(e => e.reason)).toEqual(['webui-operator-delete']);
  });
});
