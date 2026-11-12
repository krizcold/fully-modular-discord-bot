import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/sharedListener', async orig => {
  const real = await orig<any>();
  return { ...real, startSharedListener: () => undefined, stopSharedListener: () => undefined };
});

import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { runSharedPass, startSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { mirrorRig, setView } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// The bot's pass leaves an App Store key to this process's op while one is queued (NB6 decision 31 with 21 step 1).
// Once that op stored its version and left, the key is applied again, so a row another machine stored meanwhile
// reaches the mirror without waiting for the next minute's pass.

const m = mirrorRig('appstore');
const NAME = 're9skip.json';
const KEY = m.keyOf(NAME);
const LIST_KEYS = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';

beforeEach(async () => {
  await m.setup();
  setView(1, 'ALPHA');
});
afterEach(() => m.teardown());

describe("an App Store key the pass left to this process's op", () => {
  it('is applied again once the op stored its version, and takes the row stored after it (rd5-33)', async () => {
    startSharedPass();
    m.state.rows.put(KEY, 'v1');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let theirsPut = false;
    m.state.rows.fault = async (sql, params) => {
      if (sql === 'COMMIT') await held;
      if (sql === LIST_KEYS && !theirsPut && (params?.[0] as string[] | undefined)?.includes(KEY)) {
        theirsPut = true;
        m.state.rows.put(KEY, 'theirs');
      }
      return undefined;
    };
    rowQueue.accept(KEY, m.file(NAME), { body: Buffer.from('mine') }, { sha: sha('v1'), caller: false });
    await vi.waitFor(() => expect(m.sql()).toContain('COMMIT'), { timeout: 1000 });

    await expect(runSharedPass()).resolves.toMatchObject({ answered: true });
    expect(m.read(NAME)).toBeNull();

    release();
    await vi.waitFor(() => expect(rowQueue.ops(KEY)).toEqual([]), { timeout: 1000 });
    await vi.waitFor(() => expect(m.read(NAME)).toBe('theirs'), { timeout: 1000 });
    expect(m.state.pg.sent.filter(s => s.sql === LIST_KEYS).map(s => s.params ?? (s.raw as { values?: unknown[] }).values)).toEqual([[[KEY]]]);
    expect(m.superseded()).toEqual({});
    const record = readStoreRecord();
    expect(record.ok && record.record.docs[KEY]?.sha).toBe(sha('theirs'));
  });
});
