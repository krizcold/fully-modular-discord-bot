import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';
import { PANEL_CHANNEL } from '../../src/bot/internalSetup/fleet/panelLive';

const G = 'guild-1';

class FakeListen extends EventEmitter {
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: vi.fn() } };
  readonly queries: string[] = [];
  holdChecks = false;
  readonly heldChecks: (() => void)[] = [];
  endWith: () => Promise<unknown> = () => Promise.resolve();
  readonly end = vi.fn(() => this.endWith());
  constructor(readonly config: unknown) { super(); }
  connect() { return Promise.resolve(); }
  query(text: string) {
    this.queries.push(text);
    if (text === 'SELECT 1' && this.holdChecks) return new Promise(done => { this.heldChecks.push(() => done({ rows: [] })); });
    return Promise.resolve({ rows: [] });
  }
}

function makeRig() {
  const pending: { panelId: string; done: (a: FetchAnswer) => void }[] = [];
  const asked: string[] = [];
  const clients: FakeListen[] = [];
  const state = { entry: 'postgres://bot@localhost/bot' };
  const deps: WatchDeps = {
    fetch: (_g, panelId) => new Promise(done => { asked.push(panelId); pending.push({ panelId, done }); }),
    emitUpdate: () => 1,
    emitStatus: () => undefined,
    entry: () => ({ entry: state.entry }),
    makeClient: config => { const c = new FakeListen(config); clients.push(c); return c as any; },
  };
  return { w: new PanelLiveWatch(deps), pending, asked, clients, state };
}

type Rig = ReturnType<typeof makeRig>;
let rig: Rig;

const settle = () => vi.advanceTimersByTimeAsync(0);
const answer = (): FetchAnswer => ({
  status: null, holderProcess: 'p-b', reply: { success: true, data: { content: 'Kept state' }, since: 5, version: 3, notifying: true, servedBy: 'BRAVO' },
});

async function drain(r: Rig) {
  await settle();
  for (let i = 0; i < 10 && r.pending.length; i++) { r.pending.shift()!.done(answer()); await settle(); }
  expect(r.pending.length).toBe(0);
}

async function listening(r: Rig) {
  r.w.watch(G, 'p', 'owner', 'BRAVO');
  await drain(r);
  expect(r.w.listenerUp()).toBe(true);
  expect(r.clients.length).toBe(1);
}

/** The address changes, the next check reconnects, and the new connection listens with its fetches answered. */
async function reconnected(r: Rig) {
  await listening(r);
  r.state.entry = 'postgres://bot@127.0.0.1/other';
  await vi.advanceTimersByTimeAsync(30_000);
  await drain(r);
  expect(r.clients.length).toBe(2);
  expect(r.w.listenerUp()).toBe(true);
}

const notice = (p = 'p') => JSON.stringify({ g: G, p });

beforeEach(() => {
  vi.useFakeTimers();
  rig = makeRig();
});
afterEach(() => {
  rig.w.stop();
  vi.useRealTimers();
});

describe('rr9 the connection check', () => {
  it('rr9 a changed database address closes the old connection when the next one opens', async () => {
    await reconnected(rig);
    expect(rig.clients[0].end).toHaveBeenCalledTimes(1);
    expect(rig.clients[1].end).not.toHaveBeenCalled();
  });

  it('rr9 a database address changed after the first check is noticed at the second', async () => {
    await listening(rig);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rig.clients[0].queries.filter(q => q === 'SELECT 1').length).toBe(1);
    expect(rig.clients.length).toBe(1);
    rig.state.entry = 'postgres://bot@127.0.0.1/other';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rig.clients.length).toBe(2);
    expect(rig.clients[0].end).toHaveBeenCalledTimes(1);
  });

  it('rr9 a check of a closed connection that answers late leaves no timer running after stop', async () => {
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    await settle();
    rig.clients[0].holdChecks = true;
    await drain(rig);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rig.clients[0].heldChecks.length).toBe(1);
    rig.w.stop();
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    await drain(rig);
    expect(rig.clients.length).toBe(2);
    expect(rig.w.listenerUp()).toBe(true);
    rig.clients[0].heldChecks[0]();
    await settle();
    rig.w.stop();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('rr9 notifications', () => {
  it('rr9 a notification on another channel fetches nothing, one on the panel channel fetches the pair', async () => {
    await listening(rig);
    const before = rig.asked.length;
    rig.clients[0].emit('notification', { channel: 'some_other_channel', payload: notice() });
    await settle();
    expect(rig.asked.length).toBe(before);
    rig.clients[0].emit('notification', { channel: PANEL_CHANNEL, payload: notice() });
    await settle();
    expect(rig.asked.length).toBe(before + 1);
  });

  it('rr9 a notification whose payload is null is ignored without an error', async () => {
    await listening(rig);
    const before = rig.asked.length;
    expect(() => rig.clients[0].emit('notification', { channel: PANEL_CHANNEL, payload: 'null' })).not.toThrow();
    await settle();
    expect(rig.asked.length).toBe(before);
  });

  it('rr9 a notification from the closed connection fetches nothing after a reconnect', async () => {
    await reconnected(rig);
    const before = rig.asked.length;
    rig.clients[0].emit('notification', { channel: PANEL_CHANNEL, payload: notice() });
    await settle();
    expect(rig.asked.length).toBe(before);
    rig.clients[1].emit('notification', { channel: PANEL_CHANNEL, payload: notice() });
    await settle();
    expect(rig.asked.length).toBe(before + 1);
  });

  it('rr9 the end of the closed connection leaves the new connection listening', async () => {
    await reconnected(rig);
    rig.clients[0].emit('end');
    rig.clients[0].emit('error', new Error('Connection terminated'));
    await settle();
    expect(rig.w.listenerUp()).toBe(true);
    expect(rig.clients[1].end).not.toHaveBeenCalled();
    expect(rig.clients.length).toBe(2);
  });
});

describe('rr9 retries', () => {
  it('rr9 a connection lost while nothing is watched waits for no retry: the next watch connects at once', async () => {
    await listening(rig);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(rig.w.count()).toBe(0);
    rig.clients[0].emit('error', new Error('Connection terminated'));
    await settle();
    expect(rig.w.listenerUp()).toBe(false);
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    expect(rig.clients.length).toBe(2);
    await drain(rig);
    expect(rig.w.listenerUp()).toBe(true);
  });
});

describe('rr9 closing the connection', () => {
  it('rr9 a close that never answers destroys the socket after 2 s', async () => {
    await listening(rig);
    rig.clients[0].endWith = () => new Promise(() => undefined);
    rig.w.stop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(rig.clients[0].connection.stream.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rig.clients[0].connection.stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('rr9 a close the database refuses destroys the socket at once', async () => {
    await listening(rig);
    rig.clients[0].endWith = () => Promise.reject(new Error('Connection terminated'));
    rig.w.stop();
    await settle();
    expect(rig.clients[0].connection.stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('rr9 a close the database refuses leaves no timer running', async () => {
    await listening(rig);
    rig.clients[0].endWith = () => Promise.reject(new Error('Connection terminated'));
    rig.w.stop();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rr9 stop after a clean connect and close leaves no timer running', async () => {
    await listening(rig);
    rig.w.stop();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});
