import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackendKind } from '../helpers/backendKind';
import { FakeChild, call, resetData, startConfigApp } from '../helpers/configRig';

// NB33: the Config tab's list route refuses a guild id that is not a Discord id before any discovery runs.

const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  child.reset();
  setBackendKind('file');
  await resetData();
});

describe('GET /api/config/list with a guild id that is not a Discord id', () => {
  it.each(['abc', 'global', '..'])('%j answers 400', async bad => {
    const listed = await call(base, 'GET', `/api/config/list?guildId=${encodeURIComponent(bad)}`);
    expect(listed.status).toBe(400);
    expect(listed.body).toEqual({ success: false, error: 'Invalid guildId format' });
  });
});
