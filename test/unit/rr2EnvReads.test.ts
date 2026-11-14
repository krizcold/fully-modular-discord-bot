import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials, providerKeysToEnv } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

// L5 run A, chunk 17-2: providerKeysToEnv when one read of /data/.env fails and the other answers (made-up errors).

const ENV = dataPath('.env');
const DOC = '{"stripe":{"STRIPE_SECRET_KEY":"new"}}';

function failRead(which: number, error: unknown): void {
  const real = fs.readFileSync;
  let n = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, o: any) => {
    if (p === ENV) {
      n += 1;
      if (n === which) throw error;
    }
    return real(p, o);
  }) as typeof fs.readFileSync);
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const eio = () => Object.assign(new Error('rr2 EIO on read'), { code: 'EIO' });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fs.mkdirSync(dataPath(), { recursive: true });
  fs.writeFileSync(ENV, 'STRIPE_SECRET_KEY=old\n');
  loadCredentials();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(ENV, { force: true });
  loadCredentials();
});

describe('providerKeysToEnv refuses on a /data/.env it cannot read', () => {
  it("loadCredentials' read fails and a second read would answer: the plan is refused with the first cause", () => {
    failRead(1, eio());
    const error = thrown(() => providerKeysToEnv(DOC));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`${ENV} cannot be read: rr2 EIO on read`);
  });

  it("loadCredentials' read answers and the plan's own read fails: the plan is refused with that cause", () => {
    failRead(2, eio());
    const error = thrown(() => providerKeysToEnv(DOC));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`${ENV} cannot be read: rr2 EIO on read`);
  });

  it('a read that throws a bare null is refused with that value as the cause', () => {
    failRead(2, null);
    const error = thrown(() => providerKeysToEnv(DOC));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`${ENV} cannot be read: null`);
  });

  it("the plan's own read finds the file gone: the plan is made on empty text", () => {
    failRead(2, Object.assign(new Error('rr2 gone'), { code: 'ENOENT' }));
    const plan = providerKeysToEnv(DOC);
    expect(plan.text).toBe('');
    expect(plan.changes).toEqual({ STRIPE_SECRET_KEY: 'new' });
  });
});
