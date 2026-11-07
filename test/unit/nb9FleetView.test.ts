import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../helpers/jsxRig';

// NB9 test 15 and test 14's P lines: the Usage tab's Capacity card rendered from a FleetState (21) the way FleetView
// builds its summary. The P lines live only in FleetView.jsx, so their variable cases are rows here.

const FLEET_VIEW = fileURLToPath(new URL('../../src/webui/public/components/usage/FleetView.jsx', import.meta.url));
const DAY = Date.UTC(2026, 10, 5, 14, 30);

function fleetState(over: Record<string, unknown> = {}) {
  return {
    success: true, running: true, initialized: true, dataBackend: 'postgres', shardCount: 4, shardSource: 'discord',
    recommendedShards: null, recommendedAt: null,
    shardTable: [{ shardId: 0, status: 'Ready', guildCount: 10 }, { shardId: 1, status: 'Ready', guildCount: 12 }],
    guildMap: {}, reshard: null, reshardWait: null, lastReshard: null, target: null, ...over,
  };
}

/** The card's lines of text for a FleetState. */
function card(over: Record<string, unknown> = {}): string[] {
  const view = mount(FLEET_VIEW, '(p => FleetCapacityCard({ cap: fleetCapacitySummary(p.fleet) }))', { fleet: fleetState(over) }, {});
  return view.all(el => el.type === 'div' && el.children.every(c => typeof c === 'string')).map(el => view.text(el)).filter(t => t !== '');
}
const joined = (over: Record<string, unknown> = {}): string => card(over).join('\n');

const overlap = (over: Record<string, unknown> = {}) => ({
  attempt: 'a-1', from: 4, to: 8, method: 'overlap', state: 'standby', startedAgoMs: 4 * 60_000 + 10_000, untilMs: 26 * 60_000 - 5_000,
  reason: null, connected: 3, waitingFor: [], ...over,
});

describe('P1, the count', () => {
  it('a database bot with FLEET_SHARD_COUNT set: the setting, its machine and its day', () => {
    expect(joined({ target: { count: 8, by: 'B', at: DAY } })).toContain('Shards: 4 (FLEET_SHARD_COUNT 8, set on B on 2026-11-05)');
  });

  it('a database bot with no setting, or one removed: it follows the recommendation upward', () => {
    expect(joined()).toContain("Shards: 4 (follows Discord's recommendation upward)");
    expect(joined({ target: { count: null, by: 'B', at: DAY } })).toContain("Shards: 4 (follows Discord's recommendation upward)");
  });

  it("a JSON bot keeps today's labels", () => {
    expect(joined({ dataBackend: 'file', shardSource: 'override' })).toContain('Shards: 4 (FLEET_SHARD_COUNT override)');
    expect(joined({ dataBackend: 'file', shardSource: 'discord' })).toContain("Shards: 4 (Discord's recommendation at boot)");
  });
});

describe('P2, an open attempt', () => {
  it('beside the running shards: connected, started and the call-off time', () => {
    expect(card({ reshard: overlap() })).toContain('Resharding from 4 to 8 shards beside the running ones: 3 of 8 new shards connected; started 4 min ago, called off if not done in 26 min');
  });

  it('switched: the machines that still hold old shards', () => {
    expect(card({ reshard: overlap({ state: 'flipped', waitingFor: ['A', 'C'] }) }))
      .toContain('Resharding from 4 to 8 shards: switched; the old shards save what they hold (still held by A, C), then the new ones serve');
  });

  it('by stopping and starting: its reason and the machines it waits for', () => {
    const reshard = overlap({ method: 'stop-start', state: 'stopping', reason: 'resharding beside the running shards is off on B (FLEET_RESHARD_OVERLAP=false)', waitingFor: ['A'] });
    expect(card({ reshard })).toContain('Resharding from 4 to 8 shards by stopping and starting every machine (resharding beside the running shards is off on B (FLEET_RESHARD_OVERLAP=false)): waiting for A to stop');
  });
});

describe('P3 and P4, a wanted count that waits or cannot run', () => {
  it.each([
    ['a machine not healthy', 'B is not healthy'],
    ["L19's budget clause", 'Discord allows 3 more gateway logins until 15:00 UTC, and a reshard needs 16'],
    ['the last try called off', 'the last try was called off (shard 2 of B is no longer renewed); the next try is after 15:00 UTC'],
    ['the first memory reading', "waiting up to 4 min for B's first memory reading"],
    ['another count held', 'B still holds shards of another count'],
    ["can't confirm the room", "can't confirm that B has room in memory: /proc/meminfo has no MemAvailable line"],
  ])('P3, %s, from the setting', (_name, reason) => {
    const wait = { wanted: 8, source: 'setting', reason };
    expect(card({ reshardWait: wait, target: { count: 8, by: 'B', at: DAY } })).toContain(`8 shards wanted (set on B on 2026-11-05); resharding waits: ${reason}`);
  });

  it("P3 from Discord's recommendation", () => {
    expect(card({ reshardWait: { wanted: 6, source: 'discord', reason: 'B is not healthy' } })).toContain("6 shards wanted (from Discord's recommendation); resharding waits: B is not healthy");
  });

  it.each([
    ['postgres', 'B has no room in memory (100 MB free, 900 MB used)', 'Set FLEET_SHARD_COUNT to 6 on one machine to reshard by stopping and starting every machine'],
    ['file', 'two tries beside the running shards were called off', 'Set FLEET_SHARD_COUNT to 6 and restart the bot to reshard by restarting it'],
  ])("P4 on a %s bot: L18's text without its tag", (dataBackend, reason, tail) => {
    const lines = card({ dataBackend, reshardWait: { wanted: 6, source: 'discord', reason, cannot: true } });
    expect(lines).toContain(`Discord recommends 6 shards (the bot runs 4), and a reshard beside the running shards cannot run: ${reason}. ${tail}`);
    expect(lines.some(l => l.includes('shards wanted'))).toBe(false);
  });
});

describe('P5, the last reshard', () => {
  it.each([
    ['overlap', 'Last reshard: 4 to 8 shards on 2026-11-05, beside the running shards'],
    ['stop-start', 'Last reshard: 4 to 8 shards on 2026-11-05, by stopping and starting'],
  ])('done by %s', (method, line) => {
    expect(card({ lastReshard: { from: 4, to: 8, method, state: 'done', endedAt: DAY, reason: null } })).toContain(line);
  });

  it('called off, with its reason', () => {
    const last = { from: 4, to: 8, method: 'overlap', state: 'cancelled', endedAt: DAY, reason: 'not all 8 new shards were connected within 30 min (5 were)' };
    expect(card({ lastReshard: last })).toContain('The last reshard to 8 shards was called off on 2026-11-05: not all 8 new shards were connected within 30 min (5 were)');
  });

  it('no line with no attempt ever', () => {
    expect(card().some(l => /reshard/i.test(l))).toBe(false);
  });
});

describe('the capacity hint', () => {
  const busy = { shardTable: [{ shardId: 0, status: 'Ready', guildCount: 1400 }] };

  it('a count that follows Discord: the bot reshards to the recommendation', () => {
    expect(card(busy)).toContain('Approaching per-shard capacity: Discord will recommend more shards, and the bot reshards to them');
    expect(card({ ...busy, dataBackend: 'file', shardSource: 'discord' })).toContain('Approaching per-shard capacity: Discord will recommend more shards, and the bot reshards to them');
  });

  it('a count set by FLEET_SHARD_COUNT: the line as it was', () => {
    expect(card({ ...busy, target: { count: 4, by: 'A', at: DAY } })).toContain('Approaching per-shard capacity: plan to add shards.');
    expect(card({ ...busy, dataBackend: 'file', shardSource: 'override' })).toContain('Approaching per-shard capacity: plan to add shards.');
  });

  it.each([
    ['postgres', 'resharding beside the running shards is off on B (FLEET_RESHARD_OVERLAP=false)'],
    ['file', 'the web UI has no channel to the bot process'],
  ])("a %s bot that follows Discord but whose reshard cannot run (P4): the line as it was", (dataBackend, reason) => {
    const lines = card({ ...busy, dataBackend, shardSource: 'discord', reshardWait: { wanted: 6, source: 'discord', reason, cannot: true } });
    expect(lines).toContain('Approaching per-shard capacity: plan to add shards.');
    expect(lines.some(l => l.includes('the bot reshards to them'))).toBe(false);
  });
});

describe("the CLI's fleet state (21)", () => {
  it('prints the four reshard fields with the rest', async () => {
    const { dispatch } = await import('../../src/cli/commands');
    const state = fleetState({ reshard: overlap(), reshardWait: null, lastReshard: null, target: { count: 8, by: 'B', at: DAY } });
    const client: any = { request: async () => ({ ok: true, status: 200, body: state }) };
    const printed: string[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as any);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { printed.push(String(chunk)); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
    try {
      await expect(dispatch(client, ['fleet', 'state'], {})).rejects.toThrow('exit 0');
    } finally {
      exit.mockRestore(); out.mockRestore(); log.mockRestore();
    }
    const body = JSON.parse(printed.join(''));
    expect(body.reshard).toEqual(overlap());
    expect(body.target).toEqual({ count: 8, by: 'B', at: DAY });
    expect(body).toHaveProperty('reshardWait', null);
    expect(body).toHaveProperty('lastReshard', null);
  });
});
