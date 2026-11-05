import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dropPendingForGuild,
  enqueueDelete,
  enqueueWrite,
  flushAll,
  getFlushFailures,
  getPending,
  guildFailingWrite,
  guildHasQueuedOps,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

// NB11 (sheets/NB11.md): a delete names the file that keeps failing to save and refuses; these pin which guild and
// which error code that answer carries, and that a failure the bot moved past never blocks a later delete.

let guilds = 870_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const errno = (code: string) => Object.assign(new Error(code), { code });
const same = (a: unknown, b: unknown) => path.resolve(String(a)) === path.resolve(String(b));
const isTmpOf = (p: unknown, target: string) => {
  const s = path.resolve(String(p));
  const t = path.resolve(target);
  return s.startsWith(t + '.') && s.endsWith('.tmp');
};
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${label}`);
    await immediate();
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const realOpen = fs.promises.open;
/** Makes the temp-file open of a write to target answer with the given promise maker; other opens are real. */
function holdOpen(target: string, answer: () => Promise<any>) {
  const calls: string[] = [];
  const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => {
    if (isTmpOf(p, target)) {
      calls.push(String(p));
      return answer();
    }
    return (realOpen as any).call(fs.promises, p, ...rest);
  }) as any);
  return { calls, spy };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await flushAll();
});

describe('which failing write a delete names', () => {
  it('names only its own guild, and an error without a code as EIO', async () => {
    const gA = freshGuild();
    const gB = freshGuild();
    const fileA = dataPath(gA, 'm', 'a.json');
    holdOpen(fileA, () => Promise.reject(new Error('the disk said no')));
    const failures = getFlushFailures();
    enqueueWrite(fileA, '{"n":1}');
    await until(() => getFlushFailures() > failures, 'the failed flush');

    expect(guildFailingWrite(gA)).toEqual({ file: 'm/a.json', code: 'EIO' });
    expect(guildHasQueuedOps(gA)).toBe(true);
    expect(guildFailingWrite(gB)).toBeNull();
    expect(guildHasQueuedOps(gB)).toBe(false);

    vi.restoreAllMocks();
    await flushAll();
    expect(fs.readFileSync(fileA, 'utf8')).toBe('{"n":1}');
    expect(guildFailingWrite(gA)).toBeNull();
  });

  it('counts an op queued on the guild folder path itself as queued for that guild', async () => {
    const g = freshGuild();
    enqueueDelete(dataPath(g));
    expect(guildHasQueuedOps(g)).toBe(true);
    await flushAll();
    expect(guildHasQueuedOps(g)).toBe(false);
  });
});

describe('a failure the bot moved past does not refuse a later delete', () => {
  it('a write that landed after a failed flush leaves no failing file behind', async () => {
    const g = freshGuild();
    const file = dataPath(g, 'm', 'a.json');
    let failed = false;
    holdOpen(file, () => {
      failed = true;
      return Promise.reject(errno('ENOSPC'));
    });
    enqueueWrite(file, '{"n":1}');
    await until(() => guildFailingWrite(g)?.code === 'ENOSPC', 'the failing write');
    expect(failed).toBe(true);

    vi.restoreAllMocks();
    enqueueWrite(file, '{"n":2}');
    await until(() => getPending(file) === undefined, 'the second write to land');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"n":2}');

    enqueueWrite(file, '{"n":3}');
    expect(guildFailingWrite(g)).toBeNull();
    await flushAll();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"n":3}');
  });

  it('a flush that failed after its op was dropped is forgotten at its retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = freshGuild();
    const file = dataPath(g, 'm', 'a.json');
    const held = deferred<never>();
    const { calls } = holdOpen(file, () => held.promise);
    enqueueWrite(file, '{"n":1}');
    await until(() => calls.length === 1, 'the flush on the wire');

    dropPendingForGuild(g);
    const failures = getFlushFailures();
    held.reject(errno('EROFS'));
    await until(() => getFlushFailures() > failures, 'the failed flush');
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    vi.restoreAllMocks();

    enqueueWrite(file, '{"n":2}');
    expect(guildFailingWrite(g)).toBeNull();
    await flushAll();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"n":2}');
    expect(calls.every(c => !same(c, file))).toBe(true);
  });
});
