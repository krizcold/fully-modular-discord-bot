import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSession, statementBytes, watchSession, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';

// NB3 L5 chunk 3: the watchdog of a job session (watchSession), the bytes that set a statement's bound, and the end
// of a session (closeSession). Fake timers make each bound exact.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A session whose statements answer only when a test settles them, and whose socket records its destroy. */
function rig(boundMs = 100, busy?: () => Promise<boolean>) {
  const stream = Object.assign(new EventEmitter(), { destroyed: 0, bytesWritten: 0, writableLength: 0, destroy() { this.destroyed += 1; } });
  const pending: Array<{ text: string; resolve: (v: any) => void }> = [];
  const session = {
    query: (text: string) => new Promise(resolve => { pending.push({ text, resolve }); }),
    end: async () => undefined,
    connection: { stream },
  } as unknown as PgSession;
  return { w: watchSession(session, boundMs, busy), stream, pending };
}

/** The fate of a statement, read without awaiting it. */
function track(p: Promise<unknown>) {
  const s = { state: 'pending' as 'pending' | 'answered' | 'rejected', error: '' };
  p.then(() => { s.state = 'answered'; }, (e: Error) => { s.state = 'rejected'; s.error = e.message; });
  return s;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A busy() whose answers the test gives one at a time; calls counts the probes. */
function scriptedBusy() {
  const answers: Array<(v: boolean) => void> = [];
  const busy = { calls: 0, fn: () => { busy.calls += 1; return new Promise<boolean>(resolve => { answers.push(resolve); }); }, answers };
  return busy;
}

describe('the watchdog names the statement it ended', () => {
  it('names a statement sent with leading whitespace by its first word', async () => {
    const { w } = rig();
    const s = track(w.query('  INSERT INTO t VALUES (1)'));
    await vi.advanceTimersByTimeAsync(100);
    expect(s).toEqual({ state: 'rejected', error: 'The INSERT got no answer from the database within 0.1 s' });
  });

  it('names a CREATE by its first two words', async () => {
    const { w } = rig();
    const s = track(w.query('CREATE TABLE x (a int)'));
    await vi.advanceTimersByTimeAsync(100);
    expect(s.error).toBe('The CREATE TABLE got no answer from the database within 0.1 s');
  });

  it('calls an empty statement "statement"', async () => {
    const { w } = rig();
    const s = track(w.query(''));
    await vi.advanceTimersByTimeAsync(100);
    expect(s.error).toBe('The statement got no answer from the database within 0.1 s');
  });
});

describe('the watchdog ends a silent statement at its bound', () => {
  it('sleeps until the bound before it first looks', async () => {
    const { w } = rig(1000);
    track(w.query('SELECT 1'));
    const t0 = Date.now();
    await vi.advanceTimersToNextTimerAsync();
    expect(Date.now() - t0).toBe(1000);
  });

  it('ends the statement exactly at the bound and destroys the socket', async () => {
    const { w, stream } = rig();
    const s = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(99);
    expect(s.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe('rejected');
    expect(stream.destroyed).toBe(1);
  });

  it('a statement sent after an expiry still gets its own bound', async () => {
    const { w } = rig();
    const first = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(100);
    expect(first.state).toBe('rejected');
    const second = track(w.query('SELECT 2'));
    await vi.advanceTimersByTimeAsync(100);
    expect(second).toEqual({ state: 'rejected', error: 'The SELECT got no answer from the database within 0.1 s' });
  });

  it('a byte received restarts the bound from that byte', async () => {
    const { w, stream } = rig();
    const s = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(60);
    stream.emit('data');
    await vi.advanceTimersByTimeAsync(99);
    expect(s.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe('rejected');
  });

  it('a second statement does not push back the bound of the first', async () => {
    const { w } = rig();
    const a = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(60);
    const b = track(w.query('SELECT 2'));
    await vi.advanceTimersByTimeAsync(40);
    expect(a.state).toBe('rejected');
    expect(b.state).toBe('rejected');
  });

  it('when one of two statements answers, the other is still ended at its bound', async () => {
    const { w, pending } = rig();
    const a = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(10);
    const b = track(w.query('SELECT 2'));
    await vi.advanceTimersByTimeAsync(40);
    pending[0].resolve({ rows: [] });
    await flush();
    expect(a.state).toBe('answered');
    await vi.advanceTimersByTimeAsync(99);
    expect(b.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(b.state).toBe('rejected');
  });

  it('leaves no timer once every statement answered', async () => {
    const { w, pending } = rig();
    const a = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(50);
    pending[0].resolve({ rows: [] });
    await flush();
    expect(a.state).toBe('answered');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the watchdog asks the database before it ends a statement', () => {
  it('runs one probe at a time, even when a new statement reaches its bound during the probe', async () => {
    const busy = scriptedBusy();
    const { w, pending } = rig(100, busy.fn);
    track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(100);
    expect(busy.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    pending[0].resolve({ rows: [] });
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    track(w.query('SELECT 2'));
    await vi.advanceTimersByTimeAsync(110);
    expect(busy.calls).toBe(1);
  });

  it('a probe that answers after the statement answered does not destroy the session', async () => {
    const busy = scriptedBusy();
    const { w, pending, stream } = rig(100, busy.fn);
    const a = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(110);
    pending[0].resolve({ rows: [] });
    await flush();
    expect(a.state).toBe('answered');
    await vi.advanceTimersByTimeAsync(140);
    busy.answers[0](false);
    await flush();
    expect(stream.destroyed).toBe(0);
  });

  it('bytes handed to the kernel during the probe keep the statement alive', async () => {
    const busy = scriptedBusy();
    const { w, stream } = rig(100, busy.fn);
    const a = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(150);
    expect(busy.calls).toBe(1);
    stream.bytesWritten = 50;
    busy.answers[0](false);
    await flush();
    expect(a.state).toBe('pending');
    expect(stream.destroyed).toBe(0);
  });

  it('a probe that says not busy at the bound ends the statement at the bound', async () => {
    const { w, stream } = rig(100, async () => false);
    const a = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(a.state).toBe('rejected');
    expect(stream.destroyed).toBe(1);
  });

  it('after a probe, the bound runs from the last byte, not from the probe', async () => {
    let calls = 0;
    let first!: (v: boolean) => void;
    const busy = () => {
      calls += 1;
      return calls === 1 ? new Promise<boolean>(resolve => { first = resolve; }) : Promise.resolve(false);
    };
    const { w, stream } = rig(100, busy);
    const a = track(w.query('SELECT 1'));
    await vi.advanceTimersByTimeAsync(120);
    stream.emit('data');
    await vi.advanceTimersByTimeAsync(30);
    first(false);
    await flush();
    expect(a.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(69);
    await flush();
    expect(a.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(a.state).toBe('rejected');
  });
});

describe('a COMMIT is left to its own bound; every other statement is watched', () => {
  it('a COMMIT with whitespace around it is not ended by the watchdog', async () => {
    const { w } = rig();
    const s = track(w.query(' COMMIT '));
    await vi.advanceTimersByTimeAsync(300);
    expect(s.state).toBe('pending');
  });

  it('COMMIT AND CHAIN is watched', async () => {
    const { w } = rig();
    const s = track(w.query('COMMIT AND CHAIN'));
    await vi.advanceTimersByTimeAsync(100);
    expect(s.state).toBe('rejected');
  });

  it('a statement that only ends in the word commit is watched', async () => {
    const { w } = rig();
    const s = track(w.query('SELECT 1 AS commit'));
    await vi.advanceTimersByTimeAsync(100);
    expect(s.state).toBe('rejected');
  });
});

describe('statementBytes counts what pg sends', () => {
  it('counts the text alone when there are no parameters', () => {
    expect(statementBytes('abc')).toBe(3);
  });

  it('counts an object parameter as its JSON', () => {
    expect(statementBytes('x', [{ a: 1 }])).toBe(1 + Buffer.byteLength('{"a":1}'));
  });

  it('counts an object whose JSON is nothing as no bytes', () => {
    expect(statementBytes('x', [{ toJSON: () => undefined }])).toBe(1);
  });
});

describe('closeSession', () => {
  it('leaves no timer behind once the end answered', async () => {
    const stream = { destroyed: 0, destroy() { this.destroyed += 1; } };
    const session = { query: async () => ({ rows: [] }), end: async () => undefined, connection: { stream } } as unknown as PgSession;
    await closeSession(session, 5000);
    expect(vi.getTimerCount()).toBe(0);
    expect(stream.destroyed).toBe(0);
  });

  it('does not destroy a session whose end failed at once', async () => {
    const stream = { destroyed: 0, destroy() { this.destroyed += 1; } };
    const session = { query: async () => ({ rows: [] }), end: () => Promise.reject(new Error('gone')), connection: { stream } } as unknown as PgSession;
    await closeSession(session, 5000);
    expect(stream.destroyed).toBe(0);
  });
});
