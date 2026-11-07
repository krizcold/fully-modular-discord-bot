import { describe, expect, it } from 'vitest';

import {
  heldLines, l11Line, l12Line, l13Line, l14Line, l15Line, l16Line, l17Line, l22Line, l5Line, l5NoneLine, l6Line, l7Line,
  lossCause, redrawHeldLines, retakeHeldLine, targetDate,
} from '../../src/bot/internalSetup/fleet/shardClaims';
import { l23Line, l24Line, l25Line } from '../../src/bot/internalSetup/fleet/identifySlots';
import { B4_LINE, B7_LINE, b1Line, b2Line, b3Line, b5Line, b6Line, b8Line, b9Line, b15Line } from '../../src/webui/botManager';

// NB9 test 14: the L, B and P lines of section 12 and the rulings after it, each rendered for its variables' cases.

describe('L15, the count change and its spread (12, 36)', () => {
  it('names this machine\'s shards and, per machine, the shards kept for it', () => {
    expect(l15Line(4, 8, [0, 1, 2], [{ nodeName: 'M2', shardIds: [3, 4, 5], seconds: 30 }, { nodeName: 'M3', shardIds: [7, 6], seconds: 60 }]))
      .toBe('[Shards] No machine holds a shard under 4 any more: the bot now runs 8 shards; this machine takes shard(s) 0, 1, 2; shard(s) 3, 4, 5 are kept for M2 for 30 s; shard(s) 6, 7 are kept for M3 for 60 s');
  });

  it('with no other machine', () => {
    expect(l15Line(2, 1, [0], [])).toBe('[Shards] No machine holds a shard under 2 any more: the bot now runs 1 shards; this machine takes shard(s) 0');
  });
});

describe('L13 and L14, a boot that waits for the old shards (13, 12)', () => {
  const rows = [{ shardCount: 4, shardId: 1, holderName: 'M2' }, { shardCount: 4, shardId: 0, holderName: 'M1' }, { shardCount: 4, shardId: 2, holderName: 'M2' }];
  it('L13 names every holder once, in order', () => {
    expect(l13Line(8, 4, rows)).toBe('[Shards] The bot is switching to 8 shards: this process takes shards once the 4 old ones are released (still held by M1, M2)');
  });
  it('L14', () => {
    expect(l14Line(8, 4, rows.slice(0, 1))).toBe('[Shards] Resharding to 8 shards: this process takes shards once every machine has stopped its 4 old ones (still held by M2)');
  });
});

describe('L16, this machine\'s FLEET_SHARD_COUNT changed (31, 52)', () => {
  it('changed from a value', () => {
    expect(l16Line(4, 8)).toBe('[Shards] FLEET_SHARD_COUNT on this machine changed from 4 to 8: the bot reshards to 8 shards');
  });
  it('set where it was unset', () => {
    expect(l16Line(null, 6)).toBe('[Shards] FLEET_SHARD_COUNT on this machine changed from unset to 6: the bot reshards to 6 shards');
  });
  it('removed', () => {
    expect(l16Line(4, null)).toBe("[Shards] FLEET_SHARD_COUNT on this machine was removed (it was 4): the bot follows Discord's recommended count upward");
  });
});

describe('L17, a setting that differs from the wanted count (4, 13, 74)', () => {
  it('with the target another machine set', () => {
    expect(l17Line(6, 8, { machine: 'M2', date: '2026-11-07' }))
      .toBe('[Shards] FLEET_SHARD_COUNT on this machine is 6, but the bot runs 8 shards (set on M2 on 2026-11-07); only a change of the setting reshards the bot, so change it on this machine to reshard to another count');
  });
  it("from Discord's recommendation", () => {
    expect(l17Line(6, 8, null))
      .toBe("[Shards] FLEET_SHARD_COUNT on this machine is 6, but the bot runs 8 shards (from Discord's recommendation); only a change of the setting reshards the bot, so change it on this machine to reshard to another count");
  });
  it('the date is the target time\'s UTC day', () => {
    expect(targetDate(Date.UTC(2026, 10, 7, 23, 59))).toBe('2026-11-07');
  });
});

describe('L32, the three forms (56, 69, 74)', () => {
  const rows = [{ shardCount: 6, shardId: 3, holderName: 'M3' }, { shardCount: 2, shardId: 1, holderName: 'M2' }, { shardCount: 2, shardId: 0, holderName: 'M1' }];
  it('the boot or running take: one line per count still held, lowest count first', () => {
    expect(heldLines(4, rows, 5000)).toEqual([
      '[Shards] Not taking shards of the 4-shard set yet: shard(s) 0, 1 of the 2-shard set are still held by M1, M2; trying again every 5 s',
      '[Shards] Not taking shards of the 4-shard set yet: shard(s) 3 of the 6-shard set are still held by M3; trying again every 5 s',
    ]);
  });
  it('the redraw', () => {
    expect(redrawHeldLines(rows.slice(1))).toEqual([
      '[Shards] Not serving the new shards: shard(s) 0, 1 of the 2-shard set are still held by M1, M2 on this database; this process restarts, and its next start waits until they are released or expire',
    ]);
  });
  it('the re-take, the counts joined in one line', () => {
    expect(retakeHeldLine([2, 1], 4, 'db2', rows)).toBe(
      '[Database] Not taking shard(s) 1, 2 of the 4-shard set again on db2 yet: shard(s) 0, 1 of the 2-shard set and shard(s) 3 of the 6-shard set are still held there by M1, M2, M3; this process keeps its unsaved changes and tries again at the next check',
    );
  });
});

describe("part 3: the standby lanes' lines (7, 8, 11, 27, 30, E6)", () => {
  it('L5, with shards and with none (B11)', () => {
    expect(l5Line(8, [5, 4, 6])).toBe('[Shards] Standby for the reshard to 8 shards: took shard(s) 4, 5, 6; connecting them to Discord');
    expect(l5NoneLine(8, 0, 6, 2)).toBe("[Shards] Standby for the reshard to 8 shards: took none (FLEET_SHARD_CAPACITY 0): 6 taken by other machines' standbys, 2 left to machines with room; this process runs this machine's bot once its old bot process stops");
  });
  it('L6', () => {
    expect(l6Line(3)).toBe('[Shards] Standby: all 3 new shard(s) of this process are connected; waiting for the other machines');
  });
  it('L7', () => {
    expect(l7Line(8, 4)).toBe('[Shards] All 8 new shards are connected: switched the bot to 8 shards; the 4 old shards save what they hold and stop, then the new ones serve');
  });
  it('L11, with and without the next try', () => {
    expect(l11Line(8, 'A is not healthy', 4, Date.UTC(2026, 10, 7, 9, 5, 30))).toBe('[Shards] Called off the reshard to 8 shards: A is not healthy; the bot keeps 4 shards; the next try is after 2026-11-07 09:05 UTC');
    expect(l11Line(8, 'FLEET_SHARD_COUNT was removed on A after this reshard started', 4, null)).toBe('[Shards] Called off the reshard to 8 shards: FLEET_SHARD_COUNT was removed on A after this reshard started; the bot keeps 4 shards');
  });
  it('L12 (E7)', () => {
    expect(l12Line(8, 'A is not healthy')).toBe('[Shards] The reshard to 8 shards was called off (A is not healthy); this standby process stops');
  });
  it("L22's standby form (E6), each cause", () => {
    expect(l22Line('no claim renewal for 20 s')).toBe('[Shards] Standby: no claim renewal for 20 s; this standby process stops');
    expect(l22Line(lossCause(5))).toBe("[Shards] Standby: shard 5's claim is no longer this process's; this standby process stops");
  });
  it('L23, each failure class, L24 and L25', () => {
    expect(l23Line({ kind: 'timeout' }, 3, 5000)).toBe('[Shards] Cannot reserve a gateway login slot in the database (timeout); shard 3 waits and tries again every 5 s');
    expect(l23Line({ kind: 'error', code: '40P01', message: 'deadlock detected' }, 0, 2500)).toBe('[Shards] Cannot reserve a gateway login slot in the database (error: SQLSTATE 40P01 deadlock detected); shard 0 waits and tries again every 2.5 s');
    expect(l24Line(7)).toBe('[Shards] The database refused the login while shard 7 waited for a gateway login slot; this process spaces its own logins from now on');
    expect(l25Line(2)).toBe("[Shards] The web UI did not answer a gateway login slot request within 5 s; shard 2 uses this process's own spacing");
  });
});

// NB9 part 4a: the lines shardClaims.ts, maintenance.ts and reshard.ts render (E3, E6, E7, D4, H5, C8's end).
import { h5Line, l12ReplacedLine, l22PromotedLine, L33_LINE } from '../../src/bot/internalSetup/fleet/shardClaims';
import { l1Line, l2Line, l3Line, l4Line, l4bLine, l8Reason, l18Line, l19Line, l26Reason, l27Line, l28Line } from '../../src/bot/internalSetup/fleet/reshard';

describe('part 4a: L12 (E7), L22 (E3, E6), L33 (D4) and H5', () => {
  it('L12, both forms', () => {
    expect(l12Line(8, 'A is not healthy')).toBe('[Shards] The reshard to 8 shards was called off (A is not healthy); this standby process stops');
    expect(l12ReplacedLine(8, 6)).toBe('[Shards] The reshard to 8 shards has ended and a reshard to 6 shards has started in its place; this standby process stops');
  });
  it("L22's standby form with each cause (E6)", () => {
    expect(l22Line('no claim renewal for 30 s')).toBe('[Shards] Standby: no claim renewal for 30 s; this standby process stops');
    expect(l22Line("shard 3's claim is no longer this process's")).toBe("[Shards] Standby: shard 3's claim is no longer this process's; this standby process stops");
  });
  it("L22's promoted form, the cause capitalised (E3)", () => {
    expect(l22PromotedLine('the bot left maintenance')).toBe('[Shards] The bot left maintenance before this process served the new shards; asking the web UI process to restart it');
    expect(l22PromotedLine('no claim renewal for 30 s')).toBe('[Shards] No claim renewal for 30 s before this process served the new shards; asking the web UI process to restart it');
  });
  it('L33 (D4)', () => {
    expect(L33_LINE).toBe('[Shards] The database was not verified 300 s after this process was promoted to run the new shards; releasing them now');
  });
  it('H5', () => {
    expect(h5Line([3, 1], 4, 8)).toBe('[Shards] Released the old shard(s) 1, 3 of the 4-shard set: the 8 new shards take their servers once every old shard is released');
  });
});

describe("part 4a: reshard.ts's lines (L1 to L4b, L8, L18, L19, L26 to L28)", () => {
  it('L1 and L27', () => {
    expect(l1Line(4, 8, 10)).toBe('[Shards] Resharding from 4 to 8 shards beside the running ones: each machine connects its new shards in a second bot process, and the bot switches once all 8 are connected (called off if not done in 10 min)');
    expect(l27Line(1, 2, 10)).toBe('[Shards] Resharding from 1 to 2 shards beside the running ones: a second bot process connects the new shards, and the bot switches once all 2 are connected (called off if not done in 10 min)');
  });
  it('L2, with and without machines that run without the web UI', () => {
    expect(l2Line(4, 8, 'A has no room in memory (100 MB free, 700 MB used)', [])).toBe('[Shards] Resharding from 4 to 8 shards by stopping and starting every machine (A has no room in memory (100 MB free, 700 MB used)): the bot\'s shards are offline until the machines start again under 8');
    expect(l2Line(4, 8, 'B runs without the web UI', ['B', 'C'])).toBe('[Shards] Resharding from 4 to 8 shards by stopping and starting every machine (B runs without the web UI): the bot\'s shards are offline until the machines start again under 8; B, C run without the web UI and stay stopped until started by hand');
  });
  it('L3, L4 and L4b', () => {
    expect(l3Line()).toBe('[Shards] Asked the web UI to start a second bot process for the new shards');
    expect(l4Line('the memory reading is 20 min old')).toBe('[Shards] The web UI could not start a second bot process for the new shards: the memory reading is 20 min old');
    expect(l4bLine('another operation is in progress')).toBe('[Shards] The web UI cannot start the second bot process for the new shards now (another operation is in progress); asking again at the next check');
  });
  it('L8 and L26, the leave reasons', () => {
    expect(l8Reason(8)).toBe('Resharding to 8 shards: this process hands its shards to the new ones');
    expect(l26Reason(8)).toBe('Resharding to 8 shards by stopping and starting every machine');
  });
  it('L18, database and JSON forms', () => {
    expect(l18Line(8, 4, 'B runs without the web UI', false)).toBe('[Shards] Discord recommends 8 shards (the bot runs 4), and a reshard beside the running shards cannot run: B runs without the web UI. Set FLEET_SHARD_COUNT to 8 on one machine to reshard by stopping and starting every machine');
    expect(l18Line(2, 1, 'two tries beside the running shards were called off', true)).toBe('[Shards] Discord recommends 2 shards (the bot runs 1), and a reshard beside the running shards cannot run: two tries beside the running shards were called off. Set FLEET_SHARD_COUNT to 2 and restart the bot to reshard by restarting it');
  });
  it('L19', () => {
    expect(l19Line(8, 10, Date.UTC(2026, 10, 7, 9, 5))).toBe('[Shards] Resharding to 8 shards waits: Discord allows 10 more gateway logins until 2026-11-07 09:05 UTC, and a reshard needs 16');
  });
  it('L28', () => {
    expect(l28Line(2, 'gate', 1, Date.UTC(2026, 10, 7, 9, 20))).toBe('[Shards] Called off the reshard to 2 shards: this process was not healthy (gate) when the new shards were ready; the bot keeps 1 shards; the next try is after 2026-11-07 09:20 UTC');
  });
});

// NB9 part 4b: the lines standbyBoot.ts renders (E8, L20, L29, L31, L11's budget reason).
import { l12GoneLine } from '../../src/bot/internalSetup/fleet/shardClaims';
import { budgetReason, l20Line, l29Line, l31Line } from '../../src/bot/internalSetup/fleet/standbyBoot';

describe("part 4b: the standby's lines", () => {
  it("L12's form for a row that names no attempt (E8)", () => {
    expect(l12GoneLine(8)).toBe('[Shards] The reshard to 8 shards has ended: the database no longer records it; this standby process stops');
  });
  it('L20', () => {
    expect(l20Line(['GuildMembers'])).toBe('[Shards] The modules ask for gateway intents GuildMembers that this process did not log in with; they apply at its next restart');
    expect(l20Line(['GuildMembers', 'MessageContent'])).toBe('[Shards] The modules ask for gateway intents GuildMembers, MessageContent that this process did not log in with; they apply at its next restart');
  });
  it('L29 (54)', () => {
    expect(l29Line(8, 5)).toBe("[Shards] The reshard to 8 shards was done 5 min ago, but this machine's old bot process has not stopped; this standby process stops");
  });
  it('L31', () => {
    expect(l31Line('HTTP 503')).toBe("[Shards] Standby: cannot read Discord's gateway login limit (HTTP 503); not connecting the new shards until it is read, trying again every 30 s");
  });
  it("L11's budget reason (61), the sum printed", () => {
    expect(budgetReason(11, Date.UTC(2026, 10, 7, 9, 5), 4, 8)).toBe('Discord allows 11 more gateway logins until 2026-11-07 09:05 UTC, and the new shards not connected yet (4) plus one more full start (8) need 12');
  });
});

describe("part 5a: BotManager's lines (B1 to B9, B15)", () => {
  it('B1, B3, B4 and B7', () => {
    expect(b1Line(8)).toBe('[BotManager] Starting a second bot process for the reshard to 8 shards');
    expect(b3Line(8)).toBe('[BotManager] The bot process hands over to the second bot process for the reshard to 8 shards');
    expect(B4_LINE).toBe('[BotManager] The second bot process now runs the bot');
    expect(B7_LINE).toBe('[BotManager] The bot process finished its hand-over, but the second bot process is not running; starting a new bot process');
  });
  it("B2 with a 'memory' reason and the unasked exit's reason (76)", () => {
    expect(b2Line('the memory reading is 20 min old')).toBe('[BotManager] Not starting a second bot process for the reshard: the memory reading is 20 min old');
    expect(b2Line("the previous bot process ended (code null, signal SIGKILL) while the second bot process ran, so room for both can't be confirmed"))
      .toBe("[BotManager] Not starting a second bot process for the reshard: the previous bot process ended (code null, signal SIGKILL) while the second bot process ran, so room for both can't be confirmed");
  });
  it('B5 with and without the self-stop reason', () => {
    expect(b5Line(1, null, null)).toBe('[BotManager] The second bot process for the reshard exited (code 1, signal null) before the hand-over');
    expect(b5Line(0, null, 'no claim renewal for 31 s')).toBe('[BotManager] The second bot process for the reshard exited (code 0, signal null) before the hand-over: no claim renewal for 31 s');
  });
  it('B6, B8 and B9', () => {
    expect(b6Line('the bot is restarting')).toBe('[BotManager] Stopping the second bot process for the reshard: the bot is restarting');
    expect(b8Line('a restart is under way')).toBe("[BotManager] Not acting on the bot process's hand-over yet: a restart is under way; it asks again within 60 s");
    expect(b9Line(5)).toBe('[BotManager] The bot process did not exit 5 s after it was killed during its hand-over; starting a new bot process, which waits until the old one has exited');
  });
  it('B15 (62, yes)', () => {
    expect(b15Line('SIGKILL')).toBe('[BotManager] BOT CRASHED - Killed by signal SIGKILL with no stop asked');
  });
});
