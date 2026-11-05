import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackendKind } from '../helpers/backendKind';
import { flushAll, readRawStrict } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { dataPath } from '../../src/utils/dataRoot';
import { BACKUPS, FakeChild, backupNames, call, put, resetData, startConfigApp } from '../helpers/configRig';

// NB12 code review round 2 fixes (wip-redesign/sheets/NB12.md item 4 route rows): a key with a folder in its place.

const G = '444444444444444444';
const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  child.reset();
  setBackendKind('file');
  await resetData();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const update = (file: string, data: unknown) => call(base, 'POST', '/api/config/data/update', { file, data, guildId: G });

describe('readRawStrict over a folder in the file\'s place', () => {
  it('answers null for a folder and for an absent path, and the content for a file', () => {
    fs.mkdirSync(dataPath(G, 'm', 'foo.json'), { recursive: true });
    expect(readRawStrict(dataPath(G, 'm', 'foo.json'))).toBeNull();
    expect(readRawStrict(dataPath(G, 'm', 'none.json'))).toBeNull();
    put(dataPath(G, 'm', 'a.json'), '{"a":1}');
    expect(readRawStrict(dataPath(G, 'm', 'a.json'))).toBe('{"a":1}');
  });

  it('the bot\'s operator read of that key answers ok with no content', async () => {
    fs.mkdirSync(dataPath(G, 'm', 'foo.json'), { recursive: true });
    const reply = await applyOperatorDataRead({ guildId: G, module: 'm', filename: 'foo.json' });
    expect(reply.ok).toBe(true);
    expect((reply as { contentJson?: string }).contentJson).toBeUndefined();
  });
});

describe('/data/update of a key with a folder in its place', () => {
  it('an empty folder is removed and the write is saved, with no backup', async () => {
    fs.mkdirSync(dataPath(G, 'm', 'foo.json'), { recursive: true });
    const before = backupNames();
    expect(await update('m/foo.json', { b: 2 })).toMatchObject({ status: 200, body: { success: true, backupCreated: false } });
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(G, 'm', 'foo.json'), 'utf8'))).toEqual({ b: 2 });
    expect(backupNames()).toEqual(before);
  });

  it('a folder holding a file answers 422 with the reason, and the file is unchanged', async () => {
    put(dataPath(G, 'm', 'foo.json', 'x.json'), '{"x":1}');
    const answer = await update('m/foo.json', { b: 2 });
    expect(answer.status).toBe(422);
    expect(answer.body.success).toBe(false);
    expect(answer.body.error).toMatch(/^The data was not saved: .*m\/foo\.json/);
    await flushAll();
    expect(fs.readFileSync(dataPath(G, 'm', 'foo.json', 'x.json'), 'utf8')).toBe('{"x":1}');
    expect(fs.readdirSync(BACKUPS()).filter(name => !name.startsWith('.'))).toEqual([]);
  });

  it('a folder whose key is not a .json name, or a key with a parent step, still answers 404', async () => {
    fs.mkdirSync(dataPath(G, 'm', 'foo'), { recursive: true });
    expect((await update('m/foo', { b: 2 })).status).toBe(404);
    fs.mkdirSync(dataPath(G, 'n.json'), { recursive: true });
    expect((await update('m/../n.json', { b: 2 })).status).toBe(404);
    await flushAll();
    expect(fs.statSync(dataPath(G, 'm', 'foo')).isDirectory()).toBe(true);
    expect(fs.statSync(dataPath(G, 'n.json')).isDirectory()).toBe(true);
  });
});
