import { afterEach, describe, expect, it } from 'vitest';
import { Client } from 'discord.js';
import { WebSocketServer, type WebSocket } from 'ws';

// NB9 test 7 (B8): what decision 16 relies on in discord.js 14.25.1 and @discordjs/ws 1.2.3, against a local gateway
// built with the ws package and a REST stub for /gateway/bot. The Client's ws.buildIdentifyThrottler is called once
// per gateway manager, waitForIdentify gets each shard's id before that shard's IDENTIFY frame is sent, and a shard
// destroyed while it waits aborts the signal and sends no IDENTIFY. This row characterizes the library: it is green
// before and after NB9's build.

interface Gateway {
  url: string;
  events: string[];
  close(): Promise<void>;
}

async function gateway(): Promise<Gateway> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}`;
  const events: string[] = [];
  const sockets = new Set<WebSocket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (frame.op !== 2) return;
      const [id, count] = frame.d.shard as [number, number];
      events.push(`identify:${id}`);
      socket.send(JSON.stringify({
        op: 0, t: 'READY', s: 1,
        d: {
          v: 10, user: { id: '11', username: 'bot', discriminator: '0', avatar: null, bot: true, global_name: null },
          guilds: [], session_id: `s-${id}`, resume_gateway_url: url, shard: [id, count], application: { id: '11', flags: 0 },
        },
      }));
    });
  });
  return {
    url,
    events,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function client(url: string, build: (manager: any) => Promise<unknown>): Client {
  const c = new Client({ intents: [], shards: [0, 1], shardCount: 2, ws: { buildIdentifyThrottler: build } as any });
  (c.rest as any).get = async () => ({
    url, shards: 2, session_start_limit: { total: 1000, remaining: 1000, reset_after: 60_000, max_concurrency: 1 },
  });
  return c;
}

const open: Array<{ client: Client; gateway: Gateway }> = [];
afterEach(async () => {
  for (const { client: c, gateway: g } of open.splice(0)) {
    await c.destroy().catch(() => undefined);
    await g.close();
  }
});

async function until(test: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('test 7: discord.js 14.25.1 and the identify throttler (16, B8)', () => {
  it('calls the builder once and each shard waits for its identify before its IDENTIFY frame', async () => {
    const g = await gateway();
    let builds = 0;
    const c = client(g.url, async manager => {
      builds += 1;
      const info = await manager.fetchGatewayInformation();
      return {
        maxConcurrency: info.session_start_limit.max_concurrency,
        waitForIdentify: async (shardId: number) => { g.events.push(`wait:${shardId}`); },
      };
    });
    open.push({ client: c, gateway: g });
    await c.login('x.y.z');
    await until(() => g.events.filter(e => e.startsWith('identify:')).length === 2);
    expect(builds).toBe(1);
    for (const id of [0, 1]) {
      const wait = g.events.indexOf(`wait:${id}`);
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThan(g.events.indexOf(`identify:${id}`));
    }
  }, 20_000);

  it('a shard destroyed while it waits aborts the signal and sends no IDENTIFY', async () => {
    const g = await gateway();
    const aborted: number[] = [];
    const waiting: number[] = [];
    const c = client(g.url, async () => ({
      waitForIdentify: (shardId: number, signal: AbortSignal) => new Promise<void>((_, reject) => {
        waiting.push(shardId);
        signal.addEventListener('abort', () => { aborted.push(shardId); reject(new Error('aborted')); }, { once: true });
      }),
    }));
    open.push({ client: c, gateway: g });
    void c.login('x.y.z').catch(() => undefined);
    await until(() => waiting.length === 2);
    await c.destroy();
    await until(() => aborted.length === 2);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(aborted.sort()).toEqual([0, 1]);
    expect(g.events.filter(e => e.startsWith('identify:'))).toEqual([]);
  }, 20_000);
});
