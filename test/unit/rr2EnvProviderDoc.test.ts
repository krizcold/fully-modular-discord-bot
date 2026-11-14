import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadCredentials,
  providerCredentialsPath,
  providerCredentialsUnread,
  providerKeysFromEnv,
  providerKeysToEnv,
  resetDataBackendCache,
  useSharedDocReader,
} from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

// L5 run A, chunk 17-2: the credentials doc reads (docEntry, providerEntry), the doc built from /data/.env and the
// plan a migration to JSON writes to /data/.env, on made-up keys and values.

const ENV = dataPath('.env');
const FILE = 'payment-providers/credentials.json';

function readerOf(answer: string | Error): void {
  useSharedDocReader(absPath => {
    if (absPath !== providerCredentialsPath()) return undefined;
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

function clean(): void {
  fs.rmSync(ENV, { recursive: true, force: true });
  // An empty file, not a missing one, is what makes loadCredentials forget the keys it seeded from the last file.
  fs.writeFileSync(ENV, '');
  loadCredentials();
  fs.rmSync(ENV, { force: true });
  for (const key of Object.keys(process.env)) {
    if (/^(STRIPE_|PAYPAL_|PATREON_|LEMONSQUEEZY_)/.test(key) || key === 'DATA_BACKEND') delete process.env[key];
  }
  resetDataBackendCache();
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fs.mkdirSync(dataPath(), { recursive: true });
  clean();
});

afterEach(() => {
  useSharedDocReader(null);
  clean();
  vi.restoreAllMocks();
});

describe('providerCredentialsUnread names why the credentials doc cannot be read', () => {
  it('a read that throws gives its cause', () => {
    readerOf(new Error('rr2 read failed'));
    expect(providerCredentialsUnread('stripe')).toBe(`${FILE} cannot be read (rr2 read failed)`);
  });

  it('a doc that holds a number, a string, null or an array holds no object', () => {
    for (const text of ['5', '"text"', 'null', '[]', '[{"stripe":{}}]']) {
      readerOf(text);
      expect(providerCredentialsUnread('stripe'), text).toBe(`${FILE} cannot be read (it holds no object)`);
    }
  });

  it('an object doc with no entry for the provider reads as readable', () => {
    readerOf('{"paypal":{}}');
    expect(providerCredentialsUnread('stripe')).toBeNull();
  });

  it('a custom provider reads nothing from the doc, so a doc that cannot be read leaves it null', () => {
    readerOf(new Error('rr2 read failed'));
    expect(providerCredentialsUnread('custom')).toBeNull();
    readerOf('{"custom":5}');
    expect(providerCredentialsUnread('custom')).toBeNull();
  });

  it('with no reader loaded, a JSON bot reads no doc', () => {
    useSharedDocReader(null);
    expect(providerCredentialsUnread('stripe')).toBeNull();
  });

  it('with no reader loaded, a Postgres bot cannot read the doc', () => {
    useSharedDocReader(null);
    process.env.DATA_BACKEND = 'postgres';
    resetDataBackendCache();
    expect(providerCredentialsUnread('stripe')).toBe(`${FILE} cannot be read (this process has not loaded the data layer)`);
  });
});

describe('providerKeysFromEnv builds the doc from the keys this machine reads', () => {
  it('keys are sorted within a provider, whatever order /data/.env holds them in', () => {
    fs.writeFileSync(ENV, 'STRIPE_ZETA=z1\nSTRIPE_ALPHA=a1\nSTRIPE_MID=m1\n');
    const out = providerKeysFromEnv();
    expect(out.keys).toBe(3);
    expect(out.body!.toString('utf8')).toBe(JSON.stringify({ stripe: { STRIPE_ALPHA: 'a1', STRIPE_MID: 'm1', STRIPE_ZETA: 'z1' } }, null, 2));
  });

  it('a key whose value is a placeholder is not set and counts for nothing', () => {
    process.env.STRIPE_SECRET_KEY = 'REPLACE WITH YOUR KEY';
    expect(providerKeysFromEnv()).toEqual({ body: null, keys: 0 });
  });
});

describe('providerKeysToEnv: a plan that reads nothing', () => {
  it('no row: nothing changes, no text, UTF-8', () => {
    fs.writeFileSync(ENV, 'STRIPE_SECRET_KEY=old\n');
    const plan = providerKeysToEnv(null);
    expect(plan).toEqual({ changes: {}, unread: {}, held: 0, unreadDoc: null, unreadEntries: [], pinned: [], text: '', utf8: true });
  });

  it('a doc with no built-in entry: /data/.env is not read, so its text stays out of the plan', () => {
    fs.writeFileSync(ENV, 'A=1\nSTRIPE_SECRET_KEY=old\n');
    const plan = providerKeysToEnv('{"custom":{"X":"1"}}');
    expect(plan.text).toBe('');
    expect(plan.utf8).toBe(true);
    expect(plan.changes).toEqual({});
  });
});

describe('providerKeysToEnv: reading /data/.env', () => {
  it('a /data/.env that loadCredentials last could not read is read again before the plan is made', () => {
    fs.mkdirSync(ENV);
    loadCredentials();
    fs.rmSync(ENV, { recursive: true, force: true });
    fs.writeFileSync(ENV, 'STRIPE_SECRET_KEY=old\n');
    const plan = providerKeysToEnv('{"stripe":{"STRIPE_SECRET_KEY":"new"}}');
    expect(plan.changes).toEqual({ STRIPE_SECRET_KEY: 'new' });
    expect(plan.text).toBe('STRIPE_SECRET_KEY=old\n');
  });

  it('a /data/.env that is a directory cannot be read, and the error says so', () => {
    fs.mkdirSync(ENV);
    let message: string | null = null;
    try {
      providerKeysToEnv('{"stripe":{"STRIPE_SECRET_KEY":"new"}}');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBeNull();
    expect(message!.startsWith(`${ENV} cannot be read: `)).toBe(true);
    expect(message!.length).toBeGreaterThan(`${ENV} cannot be read: `.length);
  });

  it('no /data/.env: the plan sets the key on empty text', () => {
    const plan = providerKeysToEnv('{"stripe":{"STRIPE_SECRET_KEY":"new"}}');
    expect(plan.text).toBe('');
    expect(plan.utf8).toBe(true);
    expect(plan.changes).toEqual({ STRIPE_SECRET_KEY: 'new' });
    expect(plan.held).toBe(1);
  });

  it('a /data/.env that is not valid UTF-8 is marked so', () => {
    fs.writeFileSync(ENV, Buffer.concat([Buffer.from('A=1\nB='), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
    const plan = providerKeysToEnv('{"stripe":{"STRIPE_SECRET_KEY":"new"}}');
    expect(plan.utf8).toBe(false);
    expect(plan.changes).toEqual({ STRIPE_SECRET_KEY: 'new' });
  });

  it('a valid UTF-8 /data/.env is marked UTF-8', () => {
    fs.writeFileSync(ENV, 'A=café\n');
    expect(providerKeysToEnv('{"stripe":{"STRIPE_SECRET_KEY":"new"}}').utf8).toBe(true);
  });
});

describe('providerKeysToEnv: an entry that cannot be read', () => {
  it("removes only the provider's own keys from /data/.env, in sorted order", () => {
    fs.writeFileSync(ENV, 'A=1\nSTRIPE_ZETA=z\nPAYPAL_CLIENT_ID=p\nSTRIPE_ALPHA=a\n');
    const plan = providerKeysToEnv('{"stripe":5}');
    expect(Object.keys(plan.changes)).toEqual(['STRIPE_ALPHA', 'STRIPE_ZETA']);
    expect(plan.changes).toEqual({ STRIPE_ALPHA: null, STRIPE_ZETA: null });
    expect(Object.keys(plan.unread)).toEqual(['STRIPE_ALPHA', 'STRIPE_ZETA']);
    expect(plan.unread).toEqual({ STRIPE_ALPHA: 'stripe', STRIPE_ZETA: 'stripe' });
    expect(plan.unreadEntries).toEqual([{ provider: 'stripe', cause: 'the entry of stripe is not an object' }]);
  });

  it('lists the keys the container pins in sorted order, whatever order the environment holds them in', () => {
    const original = process.env;
    const ordered: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(original)) ordered[key] = value;
    ordered.STRIPE_ZETA = 'container-z';
    ordered.STRIPE_ALPHA = 'container-a';
    process.env = ordered;
    try {
      expect(Object.keys(process.env).filter(k => k.startsWith('STRIPE_'))).toEqual(['STRIPE_ZETA', 'STRIPE_ALPHA']);
      const plan = providerKeysToEnv('{"stripe":5}');
      expect(plan.pinned).toEqual([
        { key: 'STRIPE_ALPHA', kind: 'entry', provider: 'stripe' },
        { key: 'STRIPE_ZETA', kind: 'entry', provider: 'stripe' },
      ]);
    } finally {
      process.env = original;
    }
  });
});

describe('providerKeysToEnv: a readable entry', () => {
  it("a key of another provider in the entry is not the provider's, so it neither counts nor changes", () => {
    fs.writeFileSync(ENV, 'A=1\n');
    const plan = providerKeysToEnv('{"stripe":{"PAYPAL_CLIENT_ID":"p","A":"2"}}');
    expect(plan.held).toBe(0);
    expect(plan.changes).toEqual({});
  });

  it('a null key that /data/.env does not hold changes nothing; one it holds is removed', () => {
    fs.writeFileSync(ENV, 'STRIPE_OLD=x\n');
    const plan = providerKeysToEnv('{"stripe":{"STRIPE_NEVER":null,"STRIPE_OLD":null}}');
    expect(plan.held).toBe(2);
    expect(plan.changes).toEqual({ STRIPE_OLD: null });
  });
});
