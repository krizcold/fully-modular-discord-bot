import { EventEmitter } from 'events';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

// A scripted Discord. Its clock (the Date header it serves) and the host's
// clock (Date.now) are set independently, so a test can put the host any
// distance ahead of or behind Discord.
const discord = vi.hoisted(() => ({
  serverNow: 0,
  reply: (_method: string, _path: string): { status: number; body: unknown } | null => null,
}));

vi.mock('https', () => {
  const request = (url: string, opts: { method: string }, onResponse: (res: EventEmitter) => void) => {
    const req = Object.assign(new EventEmitter(), { write: () => true, destroy: () => undefined, end: () => undefined });
    req.end = () => {
      setImmediate(() => {
        const answer = discord.reply(opts.method, url.replace('https://discord.com/api/v10', ''));
        if (!answer) {
          req.emit('error', new Error('unreachable'));
          return;
        }
        const res = Object.assign(new EventEmitter(), {
          statusCode: answer.status,
          headers: { date: new Date(discord.serverNow).toUTCString() },
          complete: true,
        });
        onResponse(res);
        res.emit('data', JSON.stringify(answer.body));
        res.emit('end');
        res.emit('close');
      });
    };
    return req;
  };
  return { request, default: { request } };
});

import { WITNESS_FRESH_WINDOW_MS } from '../../src/bot/internalSetup/fleet/constants';
import { liveMasterClaim } from '../../src/bot/internalSetup/fleet/seedHold';
import { DiscordWitness, type WitnessClaim } from '../../src/bot/internalSetup/fleet/witness';

const beacon = (nodeId: string, term: number) =>
  `FLEET BEACON v1\n${JSON.stringify({ nodeId, nodeName: nodeId, term, role: 'master' })}`;

/** One witness read of a master beacon last edited at editedAt (Discord's clock), on a host skewed by hostSkewMs. */
async function readWithClocks(serverNow: number, hostSkewMs: number, editedAt: number): Promise<{ claims: WitnessClaim[]; hostNow: number }> {
  discord.serverNow = serverNow;
  discord.reply = (method, path) => {
    if (method === 'GET' && path === '/users/@me') return { status: 200, body: { id: 'bot' } };
    if (method === 'GET' && path.startsWith('/channels/home/messages')) {
      return {
        status: 200,
        body: [{
          id: 'm1',
          author: { id: 'bot' },
          content: beacon('master-a', 7),
          timestamp: new Date(editedAt - 60_000).toISOString(),
          edited_timestamp: new Date(editedAt).toISOString(),
        }],
      };
    }
    return null;
  };
  const hostNow = serverNow + hostSkewMs;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(hostNow);
  try {
    const witness = new DiscordWitness({ token: 't', nodeId: 'backup-b', nodeName: 'backup-b', getChannelId: () => 'home' });
    const claims = await witness.readClaims();
    expect(claims).not.toBeNull();
    return { claims: claims!, hostNow };
  } finally {
    clock.mockRestore();
  }
}

const discordNow = fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 });
const hostSkew = fc.integer({ min: -86_400_000, max: 86_400_000 });

describe('witness freshness against host clock skew (inventory: "Witness freshness reads a local clock")', () => {
  it('reads the same beacon age whatever the host clock offset', async () => {
    await fc.assert(
      fc.asyncProperty(discordNow, fc.integer({ min: 0, max: 10 * 60_000 }), hostSkew, hostSkew, async (serverNow, age, skewA, skewB) => {
        const a = await readWithClocks(serverNow, skewA, serverNow - age);
        const b = await readWithClocks(serverNow, skewB, serverNow - age);
        const ageA = a.hostNow - a.claims[0].observedAt;
        const ageB = b.hostNow - b.claims[0].observedAt;
        expect(ageA).toBe(ageB);
        // The Date header carries whole seconds: an age reads up to a second young, never older.
        expect(ageA).toBeLessThanOrEqual(age);
        expect(ageA).toBeGreaterThan(age - 1000);
      }),
      { numRuns: 200 },
    );
  });

  it('keeps a live master live and a silent one dead on a host whose clock is a day off', async () => {
    const awayFromTheEdge = fc.integer({ min: 0, max: 2 * WITNESS_FRESH_WINDOW_MS }).filter(age => Math.abs(age - WITNESS_FRESH_WINDOW_MS) > 2000);
    await fc.assert(
      fc.asyncProperty(discordNow, awayFromTheEdge, hostSkew, async (serverNow, age, skew) => {
        const { claims, hostNow } = await readWithClocks(serverNow, skew, serverNow - age);
        expect(liveMasterClaim(claims, 'backup-b', hostNow) !== null).toBe(age <= WITNESS_FRESH_WINDOW_MS);
      }),
      { numRuns: 200 },
    );
  });
});
