import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DM, FakeOwnerRest } from '../helpers/fakeOwnerRest';

// NB24 section 8 test 0: the shared fake REST answers a repeated enforced nonce as Discord does, within its window.

let rest: FakeOwnerRest;

const create = (nonce: string, enforce = true): Promise<any> => (rest as any).call('post', `/channels/${DM}/messages`, {
  signal: new AbortController().signal, body: { content: 'x', nonce, enforce_nonce: enforce },
});

beforeEach(() => { rest = new FakeOwnerRest(); });
afterEach(() => FakeOwnerRest.reset());

describe('NB24 test 0: the fake REST nonce dedupe', () => {
  it('two creates with one nonce answer the first message and add none', async () => {
    const first = await create('n1');
    const second = await create('n1');
    expect(second).toBe(first);
    expect(rest.messages.get(DM)).toHaveLength(1);
  });

  it('after expireNonces the same nonce adds a second message', async () => {
    await create('n1');
    rest.expireNonces();
    const again = await create('n1');
    expect(rest.messages.get(DM)).toHaveLength(2);
    expect(rest.messages.get(DM)![0]).toBe(again);
  });

  it('two nonces give two messages', async () => {
    const a = await create('n1');
    const b = await create('n2');
    expect(a).not.toBe(b);
    expect(rest.messages.get(DM)).toHaveLength(2);
  });

  it('a nonce that is not enforced is not deduplicated', async () => {
    await create('n1', false);
    await create('n1', false);
    expect(rest.messages.get(DM)).toHaveLength(2);
  });
});
