import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reshard: null as null | { onMessage: (m: unknown) => Promise<void> },
  json: null as null | { onMessage: (m: unknown) => unknown },
}));

vi.mock('../../src/bot/internalSetup/fleet/shardBoot', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/fleet/shardBoot')>();
  return { ...real, getReshard: () => h.reshard, getJsonReshard: () => h.json };
});

import { setupFleetIPCHandlers } from '../../src/bot/internalSetup/utils/ipcFleetHandler';

let sent: Array<Record<string, unknown>> = [];
let realSend: typeof process.send;
let added: Array<(...a: any[]) => void> = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.reshard = null;
  h.json = null;
  sent = [];
  realSend = process.send;
  process.send = ((message: any, ...rest: any[]) => {
    if (message && typeof message === 'object' && 'requestId' in message && 'data' in message) {
      sent.push(message);
      return true;
    }
    return realSend ? (realSend as any).call(process, message, ...rest) : true;
  }) as typeof process.send;
  const before = new Set(process.listeners('message'));
  setupFleetIPCHandlers();
  added = process.listeners('message').filter(l => !before.has(l)) as typeof added;
});

afterEach(() => {
  for (const l of added) process.removeListener('message', l);
  process.send = realSend;
  vi.restoreAllMocks();
});

const deliver = (message: Record<string, unknown>) => {
  for (const l of added) l(message);
};

describe('the web UI messages about a standby', () => {
  it('a standby-state message with a request id gets no answer', () => {
    h.json = { onMessage: () => ({ accepted: true }) };
    deliver({ type: 'reshard:standby-state', requestId: 'rk7-state' });
    expect(sent).toEqual([]);
  });

  it('a retire message whose request id is not a string gets no answer', () => {
    h.json = { onMessage: () => ({ accepted: true }) };
    deliver({ type: 'reshard:retire', requestId: 5 });
    expect(sent).toEqual([]);
  });

  it('a retire message no JSON driver answers is answered not accepted', () => {
    deliver({ type: 'reshard:retire', requestId: 'rk7-retire' });
    expect(sent).toEqual([{ requestId: 'rk7-retire', data: { accepted: false } }]);
  });

  it('a retire message the JSON driver answers carries that answer', () => {
    h.json = { onMessage: () => ({ accepted: true }) };
    deliver({ type: 'reshard:retire', requestId: 'rk7-retire2' });
    expect(sent).toEqual([{ requestId: 'rk7-retire2', data: { accepted: true } }]);
  });

  it('a standby state the reshard driver fails on is logged with its error', async () => {
    const failure = new Error('driver broke');
    h.reshard = { onMessage: () => Promise.reject(failure) };
    deliver({ type: 'reshard:standby-state' });
    const error = console.error as unknown as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 50 && error.mock.calls.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    expect(error.mock.calls).toEqual([['[Shards] Could not handle the standby state the web UI sent:', failure]]);
  });
});
