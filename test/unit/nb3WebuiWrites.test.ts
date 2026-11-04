import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigRoutes } from '../../src/webui/routes/config';
import {
  appendDataTracked, deleteDataTracked, deleteRawAtomic, flushAll, saveDataTracked, setGuildWriteGate, writeRawAtomic,
} from '../../src/bot/internalSetup/utils/dataManager';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { drainGuildWrites } from '../../src/bot/internalSetup/utils/dataMigration';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { dataPath } from '../../src/utils/dataRoot';
import { FakeChild, botFor, call, resetData, startApp } from '../helpers/configRig';
import { setBackendKind } from '../helpers/backendKind';
import { JOURNAL, MARKER, writeJson } from '../helpers/migrationRig';

// NB3 decision 4: the web UI's own guild writes, at its routes and below them at the facade.

const G = '333333333333333333';
const lock = { running: null as null | { jobId: string; to: string } };
const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  const manager = { ...botFor(child), migrationRunning: () => lock.running } as any;
  ({ url: base, close } = await startApp(app => app.use('/api/config', createConfigRoutes(manager))));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  await resetData();
  child.reset();
  lock.running = null;
  setGuildWriteGate(null);
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => setGuildWriteGate(null));

const WRITES: Array<[string, object]> = [
  ['/update', { file: 'config.json', config: { a: 1 }, guildId: G }],
  ['/restore', { filename: 'config_2026-10-28_00-00-00.json', file: 'config.json', guildId: G }],
  ['/data/update', { file: 'mod/x.json', data: { a: 1 }, guildId: G }],
  ['/data/delete', { file: 'mod/x.json', guildId: G }],
  ['/data/delete-guild', { guildId: G }],
];

describe('the five guild write routes', () => {
  it('answer 503 and write nothing during a job', async () => {
    lock.running = { jobId: 'job-webui-001', to: 'postgres' };
    for (const [route, body] of WRITES) {
      const res = await call(base, 'POST', `/api/config${route}`, body);
      expect(res.status, route).toBe(503);
      expect(res.body.error, route).toMatch(/data migration is running/);
    }
    await flushAll();
    expect(fs.existsSync(dataPath(G))).toBe(false);
    expect(child.writes).toHaveLength(0);
  });

  it('answer 503 and write nothing on a JSON bot in maintenance', async () => {
    writeMaintenanceFile('maintenance', 'm');
    for (const [route, body] of WRITES) {
      const res = await call(base, 'POST', `/api/config${route}`, body);
      expect(res.status, route).toBe(503);
      expect(res.body.error, route).toMatch(/maintenance/);
    }
    await flushAll();
    expect(fs.existsSync(dataPath(G))).toBe(false);
    expect(child.writes).toHaveLength(0);
  });

  it('write after a web UI restart with an unfinished journal (the lock is not held)', async () => {
    writeJson(JOURNAL, { jobId: 'job-webui-002', to: 'postgres', stage: 'copying', startedAt: 1 });
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    const res = await call(base, 'POST', '/api/config/data/delete-guild', { guildId: G });
    expect(res.status).not.toBe(503);
    expect(child.writes).toHaveLength(1);
  });

  it('a global write passes during a job', async () => {
    lock.running = { jobId: 'job-webui-003', to: 'postgres' };
    const res = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 1 } });
    expect(res.status).not.toBe(503);
  });
});

describe('the facade in the web UI process', () => {
  const gate = () => setGuildWriteGate(() => (lock.running ? 'A data migration is running' : null));

  it('refuses guild saves, appends, deletes and raw writes on a guild path while the lock is held', async () => {
    gate();
    lock.running = { jobId: 'job-webui-004', to: 'postgres' };
    expect(() => saveDataTracked('a.json', { guildId: G, category: 'mod' }, { a: 1 })).toThrow(DataBackendUnavailableError);
    expect(() => appendDataTracked('a.jsonl', { guildId: G, category: 'mod' }, 'line')).toThrow(DataBackendUnavailableError);
    expect(() => deleteDataTracked('a.json', { guildId: G, category: 'mod' })).toThrow(DataBackendUnavailableError);
    expect(() => writeRawAtomic(dataPath(G, 'mod', 'raw.json'), '{}')).toThrow(DataBackendUnavailableError);
    expect(() => deleteRawAtomic(dataPath(G, 'mod', 'raw.json'))).toThrow(DataBackendUnavailableError);
    expect(() => writeRawAtomic(dataPath('_graveyard', `${G}-1`, 'x.json'), '{}')).toThrow(DataBackendUnavailableError);
    await flushAll();
    expect(fs.existsSync(dataPath(G))).toBe(false);
  });

  it('passes global scope, raw paths outside the guild folders, and a process with no gate installed', async () => {
    gate();
    lock.running = { jobId: 'job-webui-005', to: 'postgres' };
    expect(saveDataTracked('g.json', { scope: 'global', category: 'mod' }, { g: 1 }).outcome).toBe('saved');
    expect(writeRawAtomic(dataPath('sessions', 's.json'), '{}')).toBe(true);
    setGuildWriteGate(null);
    expect(saveDataTracked('a.json', { guildId: G, category: 'mod' }, { a: 1 }).outcome).toBe('saved');
    await flushAll();
    expect(fs.existsSync(dataPath(G, 'mod', 'a.json'))).toBe(true);
  });

  it('a write accepted in the turn before the lock is queued and lands in the drain', async () => {
    gate();
    expect(saveDataTracked('before.json', { guildId: G, category: 'mod' }, { b: 1 }).outcome).toBe('saved');
    lock.running = { jobId: 'job-webui-006', to: 'postgres' };
    expect(await drainGuildWrites(2000)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dataPath(G), 'mod', 'before.json'), 'utf-8'))).toEqual({ b: 1 });
  });
});
