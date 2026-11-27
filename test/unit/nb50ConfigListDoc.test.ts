import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB50: a postgres-routed guild's config list marks a file present only when a document is stored under it.

const reader = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/webui/utils/webuiDataReader', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/webui/utils/webuiDataReader')>();
  return { ...real, getWebuiDataReader: () => reader.current };
});

import { setBackendKind } from '../helpers/backendKind';
import { FakeChild, call, resetData, startConfigApp } from '../helpers/configRig';

const G1 = '111111111111111111';

const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  child.reset();
  setBackendKind('postgres');
  await resetData();
});

/** A database of one guild: documents (guild_data) and keys holding appended lines only (guild_append). */
function fakeReader(docs: string[], appends: string[]) {
  const all = [...new Set([...docs, ...appends])];
  const split = (key: string) => (key.includes('/') ? [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)] : ['', key]);
  const either = async (_g: string, module: string, filename: string) => all.includes(module ? `${module}/${filename}` : filename);
  return {
    exists: either,
    hasDoc: async (_g: string, module: string, filename: string) => docs.includes(module ? `${module}/${filename}` : filename),
    listModules: async () => [...new Set(all.map(key => split(key)[0]).filter(Boolean))],
    listFiles: async (_g: string, module?: string) => all.map(split).filter(([m]) => m === (module ?? '')).map(([, f]) => f),
  };
}

const listed = async () => {
  const got = await call(base, 'GET', `/api/config/list?guildId=${G1}`);
  expect(got.status).toBe(200);
  const byKey = new Map<string, boolean>();
  for (const file of got.body.files) byKey.set(file.moduleName ? `${file.moduleName}/${file.id}` : file.id, file.exists);
  return byKey;
};

describe('GET /api/config/list for a postgres-routed guild', () => {
  it('lists an append-only schema file absent and a saved one present', async () => {
    reader.current = fakeReader([], ['examples/examples-config.json']);
    expect((await listed()).get('examples/examples-config.json')).toBe(false);
    reader.current = fakeReader(['examples/examples-config.json'], ['examples/examples-config.json']);
    expect((await listed()).get('examples/examples-config.json')).toBe(true);
  });

  it('lists an append-only orphan absent and a saved orphan present, in a module and at the root', async () => {
    reader.current = fakeReader(['mod/doc.json', 'root-doc.json'], ['mod/log.json', 'root-log.json']);
    const files = await listed();
    expect(files.get('mod/doc.json')).toBe(true);
    expect(files.get('root-doc.json')).toBe(true);
    expect(files.get('mod/log.json')).toBe(false);
    expect(files.get('root-log.json')).toBe(false);
  });
});
