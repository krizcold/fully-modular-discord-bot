import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, FlushOutcome, GuildFlushBatch, LateCommit, RestoreOutcome, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { DELETE_TEXTS, RESTORE_TEXTS, deleteGuildNamespace, saveHeldWrites, setGuildDataBackend, setOwnerInfoProvider } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { LEASED } from '../helpers/readinessRig';
import { ShardClaims, notReleasedLine, releaseFailureLine, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { ClaimPausedError, classifyFailure } from '../../src/bot/internalSetup/fleet/claimStore';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { BotManager, childHeldOf } from '../../src/webui/botManager';

// NB5 section 8 test 7 (nb5Step), the working set's and dataManager's side of decision 12's re-save rule, and test 6's
// dataManager clauses (texts A and B of C7, D5 and H8; the restore on the wire at the latch). The shard layer's rows
// of test 7 are part 5's.

const OLD = 'db1:5432/bot';
const NEW_ENTRY = 'postgres://bot@db2:5432/bot';
const NEW = 'db2:5432/bot';
const WHY = 'db1:5432/bot was replaced by m2 (generation 2)';
const REASON = `re-saved by bot process process-a after it stopped writing to ${OLD}; these rows were not in its copy of the guild`;
const tokenOf = (shardId = 0, claim = 7): FenceToken => ({ nodeId: 'node-a', claim, processId: 'process-a', shardId, shardCount: 4 });
const keysOf = (keys: Array<{ module: string; filename: string }> | undefined) => (keys ?? []).map(k => `${k.module}/${k.filename}`).sort();

/** FakeStore with decision 13's epoch and latch, decision 12's replace mode, and scripted refusals and late answers. */
class EpochStore extends FakeStore {
  epoch = 0;
  latched = false;
  readonly sent: GuildFlushBatch[] = [];
  readonly graveyard: Array<{ row: string; reason: string }> = [];
  /** Filenames whose upsert the store refuses for its content (54000). */
  readonly refuse = new Set<string>();
  /** Every replace-mode batch refused for its content. */
  refuseReplace = false;
  /** COMMIT answered ok after the epoch moved: applied, answered with landedOn. */
  lateOk = false;
  onWire = 0;
  maxOnWire = 0;

  databaseEpoch(): number { return this.epoch; }
  latchReason(): string | null { return this.latched ? WHY : null; }
  chosenEntry(): string { return NEW_ENTRY; }

  override async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    this.sent.push(structuredClone(batch));
    if (this.latched) return { ok: false, reason: 'unavailable', detail: `${WHY}; this process does not write to it` };
    this.onWire += 1;
    this.maxOnWire = Math.max(this.maxOnWire, this.onWire);
    try {
      await new Promise<void>(resolve => { setImmediate(resolve); });
      if ((this.refuseReplace && batch.replace) || batch.upserts.some(u => this.refuse.has(u.key.filename))) {
        return { ok: false, reason: 'unavailable', detail: 'SQLSTATE 54000: value too long', code: '54000' };
      }
      if (batch.replace) {
        const keep = new Set(batch.replace.docKeys.map(k => `${guildId}|${k.module}/${k.filename}`));
        const keepStreams = new Set(batch.replace.appendKeys.map(k => `${guildId}|${k.module}/${k.filename}`));
        for (const [rows, kept] of [[this.docs, keep], [this.streams, keepStreams]] as const) {
          for (const row of [...rows.keys()]) {
            if (!row.startsWith(`${guildId}|`) || kept.has(row)) continue;
            this.graveyard.push({ row, reason: batch.replace.reason });
            rows.delete(row);
          }
        }
      }
      const answer = await super.flushGuild(guildId, batch, token);
      if (answer.ok && this.lateOk) return { ok: false, reason: 'unavailable', commitUnanswered: true, landedOn: OLD };
      return answer;
    } finally {
      this.onWire -= 1;
    }
  }
}

let errors: string[] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loaded(ws: WorkingSetManager, store: EpochStore, docs: string[], token = tokenOf()): Promise<string> {
  const g = freshGuild();
  for (const name of docs) store.docs.set(`${g}|m/${name}`, `"${name}"`);
  expect(await ws.hydrate(g, token)).toBe('ready');
  return g;
}

/** The latch (decision 11), then the move's (b) to (f): the flags get the move's epoch and the latch lifts. */
function latch(ws: WorkingSetManager, store: EpochStore): void {
  store.epoch += 1;
  store.latched = true;
  ws.markForResave(OLD);
}

function move(ws: WorkingSetManager, store: EpochStore): void {
  store.epoch += 1;
  ws.flagEpoch(store.epoch);
  store.latched = false;
}

function rig(): { store: EpochStore; ws: WorkingSetManager } {
  const store = new EpochStore();
  return { store, ws: initWorkingSet(store) };
}

describe('test 7: the re-save rule in the working set (decision 12)', () => {
  it('C1: at the latch a set in ready or frozen-retained, or restoring with its call not sent, is flagged; a hydrating set or a restore on the wire is not', async () => {
    const { store, ws } = rig();
    const ready = await loaded(ws, store, ['a.json']);
    const frozen = await loaded(ws, store, ['a.json']);
    ws.freeze(frozen);
    const restoring = await loaded(ws, store, ['a.json']);
    expect(ws.beginRestore(restoring)).toBe(true);
    const onWire = await loaded(ws, store, ['a.json']);
    store.hydrateMode = 'held';
    const hydrating = freshGuild();
    const pending = ws.hydrate(hydrating, tokenOf());
    latch(ws, store);
    expect(ws.resaveGuilds().sort()).toEqual([ready, frozen, restoring, onWire].sort());
    ws.endRestore(restoring, 'reopen');
    expect(ws.resaveGuilds()).toContain(restoring);
    expect(ws.beginRestore(onWire)).toBe(true);
    ws.noteRestoreSent(onWire);
    latch(ws, store);
    expect(ws.resaveGuilds()).not.toContain(onWire);
    store.releaseHydrations('ok');
    await pending;
  });

  it('C2: the latch flags only the sets of the shards this process still holds; a lost pair\'s set logs no re-save line', async () => {
    const { store, ws } = rig();
    const held = await loaded(ws, store, ['a.json'], tokenOf(1));
    const lost = await loaded(ws, store, ['a.json'], tokenOf(2));
    store.epoch += 1;
    store.latched = true;
    ws.markForResave(OLD, (shardId, count) => shardId === 1 && count === 4);
    expect(ws.resaveGuilds()).toEqual([held]);
    move(ws, store);
    await ws.flushAllDirty();
    expect(ws.resaveGuilds()).toEqual([]);
    expect(store.sent.map(b => b.replace !== undefined)).toEqual([true]);
    expect(errors.filter(l => l.includes('were not re-saved'))).toEqual([]);
    expect(ws.stateOf(lost)).toBe('ready');
  });

  it('with no dirty key, nothing is sent while latched, and after the move every loaded guild is re-saved in replace mode and the flag clears', async () => {
    const { store, ws } = rig();
    const g = await loaded(ws, store, ['a.json', 'b.json']);
    latch(ws, store);
    await ws.flushAllDirty();
    expect(store.sent).toEqual([]);
    expect(ws.writesSettled()).toBe(false);
    move(ws, store);
    await ws.flushAllDirty();
    expect(store.sent).toHaveLength(1);
    const batch = store.sent[0];
    expect(keysOf(batch.upserts.map(u => u.key))).toEqual(['m/a.json', 'm/b.json']);
    expect(keysOf(batch.replace?.docKeys)).toEqual(['m/a.json', 'm/b.json']);
    expect(batch.replace?.reason).toBe(REASON);
    expect(ws.resaveGuilds()).toEqual([]);
    expect(ws.writesSettled()).toBe(true);
    expect(store.doc(g, 'a.json')).toBe('"a.json"');
  });

  it('a flag of an earlier epoch is not sent, and a later latch takes its epoch away', async () => {
    const { store, ws } = rig();
    const g = await loaded(ws, store, ['a.json']);
    latch(ws, store);
    move(ws, store);
    store.epoch += 1;
    await ws.flushAllDirty();
    expect(store.sent).toEqual([]);
    expect(ws.resaveGuilds()).toEqual([g]);
    latch(ws, store);
    store.latched = false;
    await ws.flushAllDirty();
    expect(store.sent).toEqual([]);
    expect(ws.resaveGuilds()).toEqual([g]);
  });

  it('a set the latch did not flag is never sent in replace mode', async () => {
    const { store, ws } = rig();
    store.hydrateMode = 'held';
    const g = freshGuild();
    const pending = ws.hydrate(g, tokenOf());
    latch(ws, store);
    move(ws, store);
    store.releaseHydrations('ok');
    expect(await pending).toBe('ready');
    expect(ws.save(g, 'm', 'n.json', '1')).toBe('accepted');
    expect(await ws.flushGuildNow(g, 1000)).toBe('ok');
    expect(store.sent.every(b => b.replace === undefined && b.deletes.length === 0)).toBe(true);
  });

  it('heldGuilds and NB4\'s drop line do not count a flag; a deposed flagged set logs its re-save line', async () => {
    const { store, ws } = rig();
    const flagOnly = await loaded(ws, store, ['a.json', 'b.json']);
    const withWrite = await loaded(ws, store, ['a.json']);
    latch(ws, store);
    expect(ws.save(withWrite, 'm', 'c.json', '1')).toBe('accepted');
    expect(ws.heldGuilds().map(h => h.guildId)).toEqual([withWrite]);
    move(ws, store);
    store.takeOver(flagOnly, false);
    store.takeOver(withWrite, false);
    await ws.flushAllDirty();
    expect(errors.filter(l => l.includes('were not re-saved')).sort()).toEqual([
      `[Data] Guild ${flagOnly}: 2 document(s) were not re-saved on ${NEW} (shard 0 is held by another process)`,
      `[Data] Guild ${withWrite}: 2 document(s) were not re-saved on ${NEW} (shard 0 is held by another process)`,
    ].sort());
    expect(ws.takeDropLines()).toEqual([`[Shards] 1 unsaved change(s) of 1 guild(s) of shard 0 were dropped: ${withWrite}`]);
    expect(ws.resaveGuilds()).toEqual([]);
  });

  it('200 flagged sets after a move are flushed four at a time', async () => {
    const { store, ws } = rig();
    for (let i = 0; i < 200; i++) await loaded(ws, store, ['a.json']);
    latch(ws, store);
    move(ws, store);
    await ws.flushAllDirty();
    expect(store.sent).toHaveLength(200);
    expect(store.maxOnWire).toBe(4);
    expect(ws.resaveGuilds()).toEqual([]);
  });

  it('a flagged flush refused for a document\'s content is sent again without the dirty key, and its landing clears the flag', async () => {
    const { store, ws } = rig();
    const g = await loaded(ws, store, ['a.json', 'big.json']);
    latch(ws, store);
    expect(ws.save(g, 'm', 'big.json', '"too big"')).toBe('accepted');
    move(ws, store);
    store.refuse.add('big.json');
    expect(await ws.flushGuildNow(g, 5000)).toBe('held');
    expect(store.sent).toHaveLength(2);
    const resend = store.sent[1];
    expect(keysOf(resend.upserts.map(u => u.key))).toEqual(['m/a.json']);
    expect(keysOf(resend.replace?.docKeys)).toEqual(['m/a.json', 'm/big.json']);
    expect(resend.deletes).toEqual([]);
    expect(store.doc(g, 'big.json')).toBe('"big.json"');
    expect(store.graveyard).toEqual([]);
    expect(ws.resaveGuilds()).toEqual([]);
    expect(ws.heldGuilds().map(h => h.guildId)).toEqual([g]);
  });

  it('a content re-send refused too keeps the flag', async () => {
    const { store, ws } = rig();
    const g = await loaded(ws, store, ['a.json', 'big.json']);
    latch(ws, store);
    expect(ws.save(g, 'm', 'big.json', '"too big"')).toBe('accepted');
    move(ws, store);
    store.refuseReplace = true;
    expect(await ws.flushGuildNow(g, 5000)).toBe('held');
    expect(store.sent).toHaveLength(2);
    expect(ws.resaveGuilds()).toEqual([g]);
  });

  it('the replace mode keeps only the set\'s keys: the other rows go to the graveyard with the re-save\'s reason', async () => {
    const { store, ws } = rig();
    const g = await loaded(ws, store, ['a.json']);
    const full = await loaded(ws, store, ['a.json']);
    store.docs.set(`${g}|m/gone.json`, '1');
    store.streams.set(`${g}|m/log.txt`, 'one\ntwo\n');
    latch(ws, store);
    move(ws, store);
    await ws.flushAllDirty();
    expect(store.graveyard).toEqual([
      { row: `${g}|m/gone.json`, reason: REASON },
      { row: `${g}|m/log.txt`, reason: REASON },
    ]);
    expect(store.doc(g, 'a.json')).toBe('"a.json"');
    expect(store.graveyard.some(r => r.row.startsWith(`${full}|`))).toBe(false);
  });

  it('a flagged flush whose COMMIT answered ok after the epoch moved carries landedOn: counted with the re-save, and checked first on the next database', async () => {
    const { store, ws } = rig();
    const g = await loaded(ws, store, ['a.json']);
    latch(ws, store);
    move(ws, store);
    store.lateOk = true;
    expect(ws.save(g, 'm', 'a.json', '2')).toBe('accepted');
    expect(await ws.flushGuildNow(g, 5000)).toBe('pending');
    expect(ws.resaveGuilds()).toEqual([g]);
    expect(ws.unansweredGuilds()).toEqual({ all: [], only: [] });
    expect(ws.dirtyGuildIds()).toEqual([]);
    expect(ws.heldGuilds()).toEqual([]);
    const set = (ws as unknown as { sets: Map<string, { flushError: { text: string } | null }> }).sets.get(g)!;
    expect(set.flushError?.text).toBe(`this save landed on ${OLD} after this process stopped writing there; it is checked on the database written next before it is sent again`);
    expect(ws.writesSettled()).toBe(false);
    store.lateOk = false;
    const checks = store.checksSent;
    const sent = store.sent.length;
    await ws.flushAllDirty();
    expect(store.checksSent).toBe(checks + 1);
    expect(keysOf(store.sent[sent].upserts.map(u => u.key))).toEqual(['m/a.json']);
    expect(store.sent[sent].replace).toBeDefined();
    expect(ws.resaveGuilds()).toEqual([]);
  });

  it('saveHeldWrites answers resaveGuilds and no unsaved or unanswered count for a landedOn batch', async () => {
    const { store, ws } = rig();
    const driver = initDataReadiness(store, ws, { held: false });
    try {
      setGuildDataBackend(store);
      setBackendKind('postgres');
      const g = await loaded(ws, store, ['a.json']);
      latch(ws, store);
      move(ws, store);
      store.lateOk = true;
      expect(ws.save(g, 'm', 'a.json', '2')).toBe('accepted');
      await ws.flushGuildNow(g, 5000);
      store.checkMode = 'unknown';
      const left = await saveHeldWrites(200);
      expect(left).toMatchObject({ unsavedGuilds: 0, unansweredGuilds: 0, resaveGuilds: 1 });
    } finally {
      driver.stop();
      setGuildDataBackend(null);
    }
  });

  it('replaceShardClaim puts the claim taken again in the fence of that shard\'s sets only', async () => {
    const { store, ws } = rig();
    const two = await loaded(ws, store, ['a.json'], tokenOf(2, 40));
    const three = await loaded(ws, store, ['a.json'], tokenOf(3, 40));
    ws.replaceShardClaim(2, 91);
    expect(ws.fenceOf(two)?.claim).toBe(91);
    expect(ws.fenceOf(three)?.claim).toBe(40);
    latch(ws, store);
    move(ws, store);
    await ws.flushAllDirty();
    expect(store.commits.find(c => c.token.shardId === 2)?.token.claim).toBe(91);
  });

  it('flushGuildNow re-saves a flag in force before it answers ok', async () => {
    const { store, ws } = rig();
    const g = await loaded(ws, store, ['a.json']);
    latch(ws, store);
    move(ws, store);
    expect(await ws.flushGuildNow(g, 5000)).toBe('ok');
    expect(store.sent).toHaveLength(1);
    expect(store.sent[0].replace).toBeDefined();
    expect(ws.resaveGuilds()).toEqual([]);
  });
});

// Test 6's dataManager clauses: a retire or restore whose COMMIT answered after the epoch moved.

const LATE_OK: LateCommit = { committed: true, old: OLD, why: WHY };
const LATE_NONE: LateCommit = { committed: false, old: OLD, why: WHY };
const DELETE_TAIL = '`smdb graveyard list` reads the data of the bot behind the web panel it asks: once that bot runs on the main database, look there for a new entry of this server with the reason webui-operator-delete, and repeat the delete if there is none.';
const DELETE_A = `can't confirm whether this server's data was deleted on the main database: ${OLD} confirmed the delete only after this process stopped writing there (${WHY}). ${DELETE_TAIL}`;
const DELETE_B = `can't confirm whether this server's data was deleted: the database did not confirm the commit, and this process stopped writing to ${OLD} while it waited (${WHY}). ${DELETE_TAIL}`;
const restoreTail = (g: string) => `Once the bot runs on the main database, run: smdb graveyard restore ${g} 5 --replace. It is safe whether or not this restore reached that database: it copies entry 5 in and moves whatever the server holds into a new entry, so nothing is lost; if that database lists no entry 5, the restore answers "no graveyard entry for this guild" and changes nothing.`;
const restoreA = (g: string) => `can't confirm whether server ${g} was restored on the main database: ${OLD} confirmed the restore only after this process stopped writing there (${WHY}). ${restoreTail(g)}`;
const restoreB = (g: string) => `can't confirm whether server ${g} was restored: the database did not confirm the commit, and this process stopped writing to ${OLD} while it waited (${WHY}). ${restoreTail(g)}`;

class ScriptedStore extends EpochStore {
  restoreImpl: () => Promise<RestoreOutcome> = async () => ({ ok: false, reason: 'no-entry' });
  retireImpl: () => Promise<RetireOutcome> = async () => ({ ok: true, moved: 1, retiredAt: 5 });
  override async restoreGuild(): Promise<RestoreOutcome> { this.restoresSent += 1; return this.restoreImpl(); }
  override async retireGuild(): Promise<RetireOutcome> { return this.retireImpl(); }
  restoresSent = 0;
  /** While set, a flush waits for it before it is sent (the latch can fall meanwhile). */
  flushGate: Promise<void> | null = null;
  override async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    if (this.flushGate) await this.flushGate;
    return super.flushGuild(guildId, batch, token);
  }
}

describe('test 6: the operator\'s answer to a retire or a restore answered after the latch (texts A and B)', () => {
  const drivers: DataReadinessDriver[] = [];
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.stop();
    setGuildDataBackend(null);
  });

  function setup(): { store: ScriptedStore; ws: WorkingSetManager } {
    const store = new ScriptedStore();
    const ws = initWorkingSet(store);
    const driver = initDataReadiness(store, ws, { held: false });
    drivers.push(driver);
    driver.onLeaseChanged(LEASED);
    setGuildDataBackend(store);
    setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 7 }));
    setBackendKind('postgres');
    return { store, ws };
  }

  async function readyGuild(ws: WorkingSetManager): Promise<string> {
    const g = freshGuild();
    expect(await ws.hydrate(g, { ...tokenOf(), shardCount: 1 })).toBe('ready');
    return g;
  }

  it.each([['A', LATE_OK, DELETE_A], ['B', LATE_NONE, DELETE_B]] as const)('a delete answered unknown after the latch answers text %s and logs it once', async (_name, late, text) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 5, moved: 1, afterLatch: true, late });
    expect(await deleteGuildNamespace(g, 'webui-operator-delete', 1000)).toEqual({ ok: false, code: 'backend-unavailable', error: text });
    expect(errors.filter(l => l.includes(g) && l.includes("can't confirm"))).toEqual([`[Data] Guild ${g}: ${text}`]);
  });

  it.each([
    ['latched', { ok: false, reason: 'latched', detail: WHY } as const, DELETE_TEXTS.latched(WHY), RESTORE_TEXTS.latched(WHY)],
    ['held', { ok: false, reason: 'held', detail: 'H' } as const, DELETE_TEXTS.held('H'), RESTORE_TEXTS.held('H')],
  ])('G12: a retire and a restore refused %s answer the operator its text, with nothing changed', async (_name, refusal, deleteText, restoreText) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => refusal as never;
    store.restoreImpl = async () => refusal as never;
    expect(await deleteGuildNamespace(g, 'webui-operator-delete', 1000)).toEqual({ ok: false, code: 'backend-unavailable', error: deleteText });
    const request = { guildId: g, module: '', filename: '', op: 'restore-graveyard' as const, contentJson: JSON.stringify({ retiredAt: 5 }) };
    expect(await applyOperatorDataWrite(request)).toEqual({ ok: false, code: 'backend-unavailable', error: restoreText });
  });

  it.each([['A', LATE_OK, restoreA], ['B', LATE_NONE, restoreB]] as const)('a restore answered unknown after the latch answers text %s through the operator route and logs it once', async (_name, late, text) => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 5, afterLatch: true, late });
    const request = { guildId: g, module: '', filename: '', op: 'restore-graveyard' as const, contentJson: JSON.stringify({ retiredAt: 5 }) };
    expect(await applyOperatorDataWrite(request)).toEqual({ ok: false, code: 'backend-unavailable', error: text(g) });
    expect(errors.filter(l => l.includes("can't confirm"))).toEqual([`[Data] Guild ${g}: ${text(g)}`]);
  });

  it('a restore on the wire at the latch leaves its set unflagged, and its ok answer evicts the set', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    const wire: { answer?: (outcome: RestoreOutcome) => void } = {};
    store.restoreImpl = () => new Promise<RestoreOutcome>(resolve => { wire.answer = resolve; });
    const request = { guildId: g, module: '', filename: '', op: 'restore-graveyard' as const, contentJson: JSON.stringify({ retiredAt: 5 }) };
    const reply = applyOperatorDataWrite(request);
    await vi.waitFor(() => expect(wire.answer).toBeDefined());
    expect(ws.stateOf(g)).toBe('restoring');
    ws.markForResave(OLD);
    expect(ws.resaveGuilds()).toEqual([]);
    const hydrations = store.hydrationsSent;
    wire.answer!({ ok: true, copied: 1, retiredAt: 5, reason: 'r', usedAt: 1000 });
    await reply;
    expect(store.hydrationsSent).toBeGreaterThan(hydrations);
    expect(ws.resaveGuilds()).toEqual([]);
  });

  it("C1: a latch during the restore's own flush, before its call is sent, keeps the set's flag when the restore reopens it", async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    expect(ws.save(g, 'm', 'x.json', '"x"')).toBe('accepted');
    let release!: () => void;
    store.flushGate = new Promise<void>(resolve => { release = resolve; });
    const request = { guildId: g, module: '', filename: '', op: 'restore-graveyard' as const, contentJson: JSON.stringify({ retiredAt: 5 }) };
    const reply = applyOperatorDataWrite(request);
    await vi.waitFor(() => expect(ws.stateOf(g)).toBe('restoring'));
    store.epoch += 1;
    store.latched = true;
    ws.markForResave(OLD);
    release();
    await reply;
    expect(store.restoresSent).toBe(0);
    expect(ws.stateOf(g)).not.toBe('restoring');
    expect(ws.resaveGuilds()).toEqual([g]);
  });

  it("R2-C1: a latch during the restore's statements, answered 'latched', reopens the set flagged, and the move re-saves its documents on the target", async () => {
    const { store, ws } = setup();
    const g = freshGuild();
    for (const name of ['a.json', 'b.json']) store.docs.set(`${g}|m/${name}`, `"${name}"`);
    expect(await ws.hydrate(g, { ...tokenOf(), shardCount: 1 })).toBe('ready');
    const wire: { answer?: (outcome: RestoreOutcome) => void } = {};
    store.restoreImpl = () => new Promise<RestoreOutcome>(resolve => { wire.answer = resolve; });
    const request = { guildId: g, module: '', filename: '', op: 'restore-graveyard' as const, contentJson: JSON.stringify({ retiredAt: 5 }) };
    const reply = applyOperatorDataWrite(request);
    await vi.waitFor(() => expect(wire.answer).toBeDefined());
    store.epoch += 1;
    store.latched = true;
    ws.markForResave(OLD);
    expect(ws.resaveGuilds()).toEqual([]);
    wire.answer!({ ok: false, reason: 'latched', detail: WHY });
    expect(await reply).toEqual({ ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.latched(WHY) });
    expect(ws.stateOf(g)).toBe('ready');
    expect(ws.resaveGuilds()).toEqual([g]);
    for (const name of ['a.json', 'b.json']) store.docs.delete(`${g}|m/${name}`);
    move(ws, store);
    await ws.flushAllDirty();
    expect(store.sent.at(-1)?.replace).toBeDefined();
    expect(store.docs.get(`${g}|m/a.json`)).toBe('"a.json"');
    expect(store.docs.get(`${g}|m/b.json`)).toBe('"b.json"');
    expect(ws.resaveGuilds()).toEqual([]);
  });

  it.each([
    ['live-rows', { ok: false, reason: 'live-rows', retiredAt: 5 } as const, (g: string) => RESTORE_TEXTS.live(g, 5)],
    ['refused', { ok: false, reason: 'refused', detail: 'D', code: '57014' } as const, () => RESTORE_TEXTS.refused('D', '57014')],
  ])("R3-C1: a latch during the restore's ROLLBACK, answered '%s', reopens the set flagged, and the move re-saves its documents on the target", async (_name, answer, text) => {
    const { store, ws } = setup();
    const g = freshGuild();
    for (const name of ['a.json', 'b.json']) store.docs.set(`${g}|m/${name}`, `"${name}"`);
    expect(await ws.hydrate(g, { ...tokenOf(), shardCount: 1 })).toBe('ready');
    const wire: { answer?: (outcome: RestoreOutcome) => void } = {};
    store.restoreImpl = () => new Promise<RestoreOutcome>(resolve => { wire.answer = resolve; });
    const request = { guildId: g, module: '', filename: '', op: 'restore-graveyard' as const, contentJson: JSON.stringify({ retiredAt: 5 }) };
    const reply = applyOperatorDataWrite(request);
    await vi.waitFor(() => expect(wire.answer).toBeDefined());
    store.epoch += 1;
    store.latched = true;
    ws.markForResave(OLD);
    wire.answer!(answer);
    expect(await reply).toEqual(answer.reason === 'live-rows'
      ? { ok: false, code: 'invalid', refusal: 'live-data', retiredAt: 5, error: text(g) }
      : { ok: false, code: 'backend-unavailable', error: text(g) });
    expect(ws.stateOf(g)).toBe('ready');
    expect(ws.resaveGuilds()).toEqual([g]);
    for (const name of ['a.json', 'b.json']) store.docs.delete(`${g}|m/${name}`);
    move(ws, store);
    await ws.flushAllDirty();
    expect(store.docs.get(`${g}|m/a.json`)).toBe('"a.json"');
    expect(store.docs.get(`${g}|m/b.json`)).toBe('"b.json"');
    expect(ws.resaveGuilds()).toEqual([]);
  });
});

// TEST 7, THE SHARD LAYER (C4, C5, D1, D2, D6, D9, E1, E2, E4, E5): ShardClaims over MemClaimStore with NB4's fake
// clocks. One store stands for both databases: the test rewrites its rows to the target's before the move.

const CT = claimTimings(30);
const DB_WHY = 'db1:5432/bot was replaced by node-b (generation 4)';
const MOVE_TARGET = { address: 'db2:5432/bot', generation: 0 };

function shardRig(over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new MemClaimStore(() => Date.now());
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls = { stopStep: 0, lapsed: [] as number[], lost: [] as number[][], replaced: [] as Array<[number, number]> };
  const state = { latched: null as string | null };
  const me = { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' };
  const claims = new ShardClaims({
    store, me, timings: CT, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    clocks: () => ({ perf: performance.now(), wall: Date.now() }),
    fitness: () => null,
    gateClosed: () => false,
    isStopping: () => false,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: seconds => { calls.lapsed.push(seconds); },
    noteLost: lost => { calls.lost.push(lost.map(p => p.shardId)); },
    restartForShards: () => true,
    releaseRefusal: () => state.latched,
    replaceShardClaim: (shardId, claim) => { calls.replaced.push([shardId, claim]); },
    guildsOfShard: () => [],
    log,
    ...over,
  });
  const lines = () => [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(c => String(c[0]));
  const latchNow = (why = DB_WHY) => { state.latched = why; claims.stopServingForDatabase(why); };
  return { store, claims, calls, state, lines, latchNow, me };
}

async function bootedShards(r: ReturnType<typeof shardRig>, count = 2) {
  r.claims.start();
  expect(await r.claims.firstRenewal()).toBe(true);
  const taken = await r.claims.bootTake(async () => count);
  r.claims.noteGranted();
  return taken!;
}

const rowOf = (r: ReturnType<typeof shardRig>, shardId: number, count = 2) => r.store.rows.get(`${count}:${shardId}`)!;
const toOther = (r: ReturnType<typeof shardRig>, shardId: number, claim: number) =>
  Object.assign(rowOf(r, shardId), { holderProcess: 'p-z', holderNode: 'node-z', holderName: 'Z', claim });

describe('test 7: the shard layer across the latch and the move (C5, D1, D2, E1, E2, E4, E5)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('C5 (e): the database stop runs the stop-serving step once and pauses the store; nothing is sent over 3 x TTL, no lapse', async () => {
    const r = shardRig();
    await bootedShards(r);
    const pause = vi.spyOn(r.store, 'pause');
    const renewals = r.store.renewals.length;
    r.latchNow();
    r.claims.stopServingForDatabase(DB_WHY);
    expect(r.calls.stopStep).toBe(1);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(r.claims.databaseStopWhy()).toBe(DB_WHY);
    await vi.advanceTimersByTimeAsync(3 * CT.ttlMs);
    expect(r.store.renewals.length).toBe(renewals);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lapsed).toEqual([]);
    expect(r.lines().some(l => l.includes('No claim renewal'))).toBe(false);
  });

  it('C5 (f), D1 and C4: (c) runs no loss; the end of (d) re-takes one pair into the fence, loses the other with its row read on the target, and the next tick renews the new claim', async () => {
    const r = shardRig();
    const taken = await bootedShards(r);
    expect(taken.pairs.map(p => p.shardId)).toEqual([0, 1]);
    r.latchNow();
    r.store.rows.delete('2:0');
    toOther(r, 1, 77);
    const renewal = await r.claims.moveRenewal();
    expect(renewal.missing.map(p => p.shardId)).toEqual([0, 1]);
    expect(r.calls.lost).toEqual([]);
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    const claim0 = r.claims.claimOf(0)!;
    expect(claim0).toBeGreaterThan(77);
    expect(r.calls.replaced).toEqual([[0, claim0]]);
    expect(r.calls.lost).toEqual([[1]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.lines().filter(l => l.startsWith('[Shards] Shard 1'))).toEqual([
      "[Shards] Shard 1's claim row holds claim 77 of Z (process p-z), not this process's claim 2",
    ]);
    const before = r.store.renewals.length;
    await vi.advanceTimersByTimeAsync(CT.renewMs);
    const next = r.store.renewals.slice(before);
    expect(next.length).toBeGreaterThan(0);
    expect(next[0].pairs).toEqual([{ shardCount: 2, shardId: 0, claim: claim0 }]);
  });

  it('C5 (g): an attempt that ends at (e) sends nothing until the next attempt\'s (c), whose renewal returns the re-taken pair with no loss', async () => {
    const r = shardRig();
    await bootedShards(r);
    r.latchNow();
    r.store.rows.delete('2:1');
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    r.claims.moveAttemptEnded();
    const sent = r.store.renewals.length + r.store.takes.length + r.store.retakes.length + r.store.reads;
    await vi.advanceTimersByTimeAsync(3 * CT.renewMs);
    expect(r.store.renewals.length + r.store.takes.length + r.store.retakes.length + r.store.reads).toBe(sent);
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    expect(r.store.retakes).toHaveLength(1);
    expect(r.calls.lost).toEqual([]);
  });

  it('C5 (h) and E2: once the database stop ran, bootTake answers null and firstRenewal false, also after the end of (d) resumed the lanes', async () => {
    const r = shardRig();
    await bootedShards(r);
    r.latchNow();
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    const takes = r.store.takes.length;
    expect(await r.claims.firstRenewal()).toBe(false);
    expect(await r.claims.bootTake(async () => 2)).toBeNull();
    expect(r.store.takes.length).toBe(takes);
  });

  it('D1 (3): a renewal whose connect completes after the latch, with its row taken by another process meanwhile: no loss, nothing recorded', async () => {
    const r = shardRig();
    await bootedShards(r);
    const held = r.claims.heldPairs();
    r.store.connectMode = 'hang';
    await vi.advanceTimersByTimeAsync(CT.renewMs);
    const renewals = r.store.renewals.length;
    r.latchNow();
    toOther(r, 1, 90);
    r.store.releaseConnects();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls.lost).toEqual([]);
    expect(r.lines().some(l => l.includes('no longer held'))).toBe(false);
    expect(r.claims.heldPairs()).toEqual(held);
    expect(r.store.renewals.length).toBe(renewals);
  });

  it('D1 (4) and E2: a boot take pending at the latch takes nothing and answers null', async () => {
    const r = shardRig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    r.store.connectMode = 'hang';
    const take = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    r.latchNow();
    r.store.releaseConnects();
    expect(await take).toBeNull();
    expect(r.store.takes).toHaveLength(0);
    expect(r.lines().some(l => l.includes('Cannot take shards yet'))).toBe(false);
  });

  it('D2 and E4: a re-take whose answer is lost after onCommitSent logs the can\'t-confirm line once; the next pass takes the row again', async () => {
    const r = shardRig();
    await bootedShards(r);
    const claim1 = r.claims.claimOf(1)!;
    r.latchNow();
    r.store.rows.delete('2:1');
    r.store.bounds = { renewMs: CT.renewMs, workMs: 2 * CT.renewMs };
    r.store.retakeMode = 'hang';
    r.store.takeCommitsAtDestroy = true;
    const first = r.claims.moveClaims(MOVE_TARGET);
    await vi.advanceTimersByTimeAsync(2 * CT.renewMs);
    expect(await first).toBe(false);
    const line = "[Database] Not moving to db2:5432/bot yet: can't confirm whether the re-take of shard 1 reached it (timeout); this process keeps its unsaved changes and stays stopped, and the next attempt on db2:5432/bot takes shard 1 again if its claim row there still names this process";
    expect(r.lines().filter(l => l === line)).toHaveLength(1);
    expect(r.claims.claimOf(1)).toBe(claim1);
    expect(r.calls.lost).toEqual([]);
    expect(rowOf(r, 1).holderProcess).toBe('p-a');
    r.store.retakeMode = 'ok';
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    expect(r.claims.claimOf(1)).toBeGreaterThan(rowOf(r, 0).claim);
    expect(r.claims.claimOf(1)).toBe(rowOf(r, 1).claim);
    expect(r.calls.lost).toEqual([]);
  });

  it('D2: the same with the cut rolling the re-take back: the next pass takes the missing row', async () => {
    const r = shardRig();
    await bootedShards(r);
    r.latchNow();
    r.store.rows.delete('2:1');
    r.store.bounds = { renewMs: CT.renewMs, workMs: 2 * CT.renewMs };
    r.store.retakeMode = 'hang';
    const first = r.claims.moveClaims(MOVE_TARGET);
    await vi.advanceTimersByTimeAsync(2 * CT.renewMs);
    expect(await first).toBe(false);
    expect(r.store.rows.has('2:1')).toBe(false);
    r.store.retakeMode = 'ok';
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    expect(r.claims.claimOf(1)).toBe(rowOf(r, 1).claim);
    expect(r.calls.lost).toEqual([]);
  });

  it('D2: a COMMIT answered 40001 and a failure before COMMIT give the rolled-back line, a failed (c) its line; a repeat logs nothing new; the next pass completes', async () => {
    const r = shardRig();
    await bootedShards(r);
    r.latchNow();
    r.store.rows.delete('2:1');
    r.store.retakeMode = Object.assign(new Error('could not serialize access'), { code: '40001', severity: 'ERROR' });
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(false);
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(false);
    r.store.retakeFailsAt = 'statement';
    r.store.retakeMode = Object.assign(new Error('could not obtain lock'), { code: '55P03', severity: 'ERROR' });
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(false);
    r.store.retakeMode = 'ok';
    r.store.renewMode = Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:5432'), { code: 'ECONNREFUSED' });
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(false);
    expect(r.lines().filter(l => l.startsWith('[Database] Not moving'))).toEqual([
      '[Database] Not moving to db2:5432/bot yet: the re-take of shard 1 failed there (error: SQLSTATE 40001 could not serialize access); this process keeps its unsaved changes and stays stopped',
      '[Database] Not moving to db2:5432/bot yet: the re-take of shard 1 failed there (error: SQLSTATE 55P03 could not obtain lock); this process keeps its unsaved changes and stays stopped',
      '[Database] Not moving to db2:5432/bot yet: the claim renewal there failed (unreachable); this process keeps its unsaved changes and stays stopped',
    ]);
    r.store.renewMode = 'ok';
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    expect(r.calls.lost).toEqual([]);
  });

  it('E4: a later latch during the move words the cause "the move stopped while it waited", for one shard and for two', async () => {
    const WHY2 = "can't confirm that db2:5432/bot is still the main (another database accepts writes at generation 5)";
    for (const lose of [[1], [0, 1]]) {
      const r = shardRig();
      await bootedShards(r);
      r.latchNow();
      for (const id of lose) r.store.rows.delete(`2:${id}`);
      r.store.retakeMode = 'hang';
      const move = r.claims.moveClaims(MOVE_TARGET);
      await vi.advanceTimersByTimeAsync(0);
      r.latchNow(WHY2);
      expect(await move).toBe(false);
      const shards = lose.length === 1 ? 'shard 1' : 'shards 0, 1';
      const tail = lose.length === 1 ? 'takes shard 1 again if its claim row there still names this process' : 'takes shards 0, 1 again if their claim rows there still name this process';
      expect(r.lines()).toContain(`[Database] Not moving to db2:5432/bot yet: can't confirm whether the re-take of ${shards} reached it (the move stopped while it waited: ${WHY2}); this process keeps its unsaved changes and stays stopped, and the next attempt on db2:5432/bot ${tail}`);
      expect(r.calls.lost).toEqual([]);
      vi.useRealTimers();
    }
  });

  it('E4: the later latch before onCommitSent gives the rolled-back line, and during (c) the renewal line, with that cause', async () => {
    const WHY2 = 'db2:5432/bot was replaced by node-c (generation 5)';
    const r = shardRig();
    await bootedShards(r);
    r.latchNow();
    r.store.rows.delete('2:1');
    r.store.retakeFailsAt = 'statement';
    r.store.retakeMode = 'hang';
    const move = r.claims.moveClaims(MOVE_TARGET);
    await vi.advanceTimersByTimeAsync(0);
    r.latchNow(WHY2);
    expect(await move).toBe(false);
    r.store.retakeMode = 'ok';
    r.store.renewMode = 'hang';
    const again = r.claims.moveClaims(MOVE_TARGET);
    await vi.advanceTimersByTimeAsync(0);
    const WHY3 = 'db2:5432/bot was replaced by node-d (generation 6)';
    r.latchNow(WHY3);
    expect(await again).toBe(false);
    expect(r.lines().filter(l => l.startsWith('[Database] Not moving'))).toEqual([
      `[Database] Not moving to db2:5432/bot yet: the re-take of shard 1 failed there (the move stopped while it waited: ${WHY2}); this process keeps its unsaved changes and stays stopped`,
      `[Database] Not moving to db2:5432/bot yet: the claim renewal there failed (the move stopped while it waited: ${WHY3}); this process keeps its unsaved changes and stays stopped`,
    ]);
    expect(r.calls.lost).toEqual([]);
  });

  it('E5: a loss row read the pause ends is worded as paused', async () => {
    const r = shardRig();
    await bootedShards(r);
    r.latchNow();
    toOther(r, 1, 77);
    r.store.readMode = 'hang';
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    r.claims.moveAttemptEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.lines()).toContain('[Shards] Shard 1 is no longer held by this process; its claim row could not be read (not read: the claims are paused since this process stopped writing to its database)');
  });

  it('E1: a boot take acknowledged after D whose renewal the latch ends keeps its pairs, and the move\'s (c) carries them', async () => {
    const r = shardRig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    const take = r.store.take.bind(r.store);
    r.store.take = async (...args: Parameters<MemClaimStore['take']>) => {
      const answer = await take(...args);
      vi.setSystemTime(Date.now() + CT.deadlineMs + 1);
      r.store.renewMode = 'hang';
      return answer;
    };
    const boot = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    r.latchNow();
    expect(await boot).toBeNull();
    expect(r.claims.heldPairs().map(p => p.shardId)).toEqual([0, 1]);
    expect(r.calls.lapsed).toEqual([]);
    r.store.renewMode = 'ok';
    r.store.rows.delete('2:1');
    const renewals = r.store.renewals.length;
    expect(await r.claims.moveClaims(MOVE_TARGET)).toBe(true);
    expect(r.store.renewals[renewals].pairs.map(p => p.shardId)).toEqual([0, 1]);
    expect(r.claims.claimOf(1)).toBe(rowOf(r, 1).claim);
    expect(r.calls.lost).toEqual([]);
    r.state.latched = null;
    await r.claims.finishStop();
    expect(r.store.releases).toHaveLength(1);
    expect(r.lines().some(l => l.startsWith('[Shards] Released shards 0, 1'))).toBe(true);
  });

  it('E1: the move\'s (c) waits for a renewal on the wire and the boot take\'s renewal behind it, then carries both pairs', async () => {
    const r = shardRig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    const take = r.store.take.bind(r.store);
    r.store.take = async (...args: Parameters<MemClaimStore['take']>) => {
      const answer = await take(...args);
      vi.setSystemTime(Date.now() + CT.deadlineMs + 1);
      r.store.connectMode = 'hang';
      void r.claims.renewOnce();
      return answer;
    };
    const boot = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    r.latchNow();
    r.store.connectMode = 'ok';
    const renewals = r.store.renewals.length;
    const move = r.claims.moveRenewal();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.renewals.length).toBe(renewals);
    r.store.releaseConnects();
    const answer = await move;
    expect(await boot).toBeNull();
    expect(r.store.renewals.length).toBe(renewals + 1);
    expect(r.store.renewals[renewals].pairs.map(p => p.shardId)).toEqual([0, 1]);
    expect(answer.returned.map(p => p.shardId)).toEqual([0, 1]);
  });

  it('D9 and D6: a database stop during the stop\'s wait for a renewal on the wire sends no release and logs the not-released line', async () => {
    const r = shardRig();
    await bootedShards(r);
    r.claims.beginStop();
    r.store.renewMode = 'hang';
    void r.claims.renewOnce();
    const stop = r.claims.finishStop();
    await vi.advanceTimersByTimeAsync(500);
    r.latchNow();
    await vi.advanceTimersByTimeAsync(2000);
    await stop;
    expect(r.store.releases).toHaveLength(0);
    expect(r.lines()).toContain(`[Shards] Shards 0, 1 were not released: ${DB_WHY}; their claims expire after 30 s`);
  });

  it('D6: the not-released line\'s one-shard and empty-list forms', () => {
    expect(notReleasedLine([{ shardCount: 4, shardId: 3, claim: 40 }], DB_WHY, 30_000)).toBe(`[Shards] Shard 3 was not released: ${DB_WHY}; its claim expires after 30 s`);
    expect(notReleasedLine([{ shardCount: 4, shardId: 3, claim: 40 }, { shardCount: 4, shardId: 2, claim: 41 }], DB_WHY, 30_000)).toBe(`[Shards] Shards 2, 3 were not released: ${DB_WHY}; their claims expire after 30 s`);
    expect(notReleasedLine([], DB_WHY, 30_000)).toBe(`[Shards] The release was not sent: ${DB_WHY}; any shard row still naming this process frees once its claim expires`);
  });

  it('E3: the release lines a pause meets, by whether COMMIT was sent (F2\'s pure rows)', () => {
    const failure = classifyFailure(new ClaimPausedError());
    const two = [{ shardCount: 4, shardId: 3, claim: 40 }, { shardCount: 4, shardId: 2, claim: 41 }];
    const one = [two[0]];
    const why = 'db1:5432 was replaced by node-b (generation 4)';
    const cant = `[Shards] Can't confirm whether the release of shards 2, 3 applied: this process stopped writing to its database while the release waited for its answer (${why}); if it did not apply, any machine with room may take them once their claims expire`;
    expect(releaseFailureLine(two, failure, true, true, why)).toBe(cant);
    expect(releaseFailureLine(one, failure, true, true, why)).toBe(cant.replace('shards 2, 3', 'shards 3'));
    expect(releaseFailureLine(two, failure, true, true, null)).toBe(cant.replace(` (${why})`, ''));
    expect(releaseFailureLine(two, { kind: 'timeout' }, true, true, why)).toBe(cant);
    const not = `[Shards] The release of shards 2, 3 did not apply: this process stopped writing to its database before the release sent its COMMIT (${why}); any machine with room may take them once their claims expire`;
    expect(releaseFailureLine(two, failure, false, false, why)).toBe(not);
    expect(releaseFailureLine(two, failure, false, true, why)).toBe(not);
    expect(releaseFailureLine(one, failure, false, false, why)).toBe(not.replace('shards 2, 3', 'shards 3'));
    expect(releaseFailureLine(two, failure, false, false, null)).toBe(not.replace(` (${why})`, ''));
  });
});

// Test 7, C3 (b) and (c): the web UI process's enter answer and migrationBotState with only re-save flags.

describe('C3: botManager with only flags', () => {
  const CLAUSE = "40 guild(s) are not re-saved yet on the bot's main database; their latest changes may exist only in the bot process";
  const ONLY_FLAGS = { saved: false, unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, resaveGuilds: 40 };

  const state = (over: object) => (BotManager.prototype as any).migrationBotState.call({
    operationInProgress: false, stoppingRestart: false, queuedRestart: false, isRunning: () => true,
    childMaintenanceBoot: false, childModeReported: true, childEnterAnswer: null, childHeld: null, ...over,
  });

  it('(b) the enter answer to a flags-only reply carries resaveGuilds 40 and the clause as its note', async () => {
    const self: any = { isRunning: () => true, botProcess: {}, stageReached: () => true, sendIPCMessage: vi.fn(async () => ONLY_FLAGS) };
    const answer = await (BotManager.prototype as any).enterMaintenance.call(self, 'm');
    expect(answer).toEqual({ saved: false, unsavedGuilds: 0, unsavedFiles: 0, resaveGuilds: 40, note: CLAUSE });
    expect(answer.note).not.toContain('0 guild(s) and 0 file(s)');
  });

  it('(c) migrationBotState in maintenance after it, and in held after a flags-only held report, names the 40 guilds', () => {
    const text = `The bot holds changes a stop or restart can drop: ${CLAUSE}`;
    expect(state({ childMode: 'maintenance', childEnterAnswer: { ...ONLY_FLAGS, note: CLAUSE } })).toEqual({ ok: false, error: text });
    const held = childHeldOf('held', { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, resaveGuilds: 40 });
    expect(held).toEqual({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, resaveGuilds: 40 });
    expect(state({ childMode: 'held', childHeld: held })).toEqual({ ok: false, error: text });
  });

  it('a held report with r = 0 keeps the shape it had', () => {
    expect(childHeldOf('held', { unsavedGuilds: 1, unsavedFiles: 0 })).toEqual({ unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 0 });
  });

  it('the re-save clause beside real changes follows the unsaved head', () => {
    expect(state({ childMode: 'held', childHeld: { unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 0, resaveGuilds: 1 } })).toEqual({
      ok: false, error: "The bot holds unsaved changes (1 guilds, 0 files); a stop or restart drops them; 1 guild(s) are not re-saved yet on the bot's main database; their latest changes may exist only in the bot process",
    });
  });
});
