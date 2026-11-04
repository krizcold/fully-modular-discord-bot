import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateRecognitionGuard } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { setBackendKind } from '../helpers/backendKind';
import { ENV, FakeHost, JOURNAL, MARKER, PG_URL, STORES, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB3's state x exit table, the cells a fake database can stand in for: each exit is injected at its stage, then the
// disk, the journal, the store list, the next boot's guard and the status read are checked. E2 is a failed step; E3 is
// the web UI process dying (nothing more is written, the database ends the job's sessions).

const G = '161616161616161616';
type Exit = 'E2' | 'E3';
interface Cell {
  to: 'postgres' | 'file';
  point: string;
  exit: Exit;
  stage: string;
  result: 'failed' | 'interrupted' | undefined;
  state: 'failed' | 'interrupted' | 'done';
  db: 'none' | 'source' | 'copy' | 'retired';
  guard: RegExp | 'boot';
  marker: 'file' | 'postgres';
}

const toPg = (point: string, exit: Exit, stage: string, db: Cell['db'], marker: Cell['marker'] = 'file', guard: Cell['guard'] = 'boot'): Cell => ({
  to: 'postgres', point, exit, stage, db, marker, guard,
  result: exit === 'E2' ? (['switching', 'env'].includes(stage) ? 'interrupted' : 'failed') : undefined,
  state: stage === 'checking' && exit === 'E3' ? 'failed' : exit === 'E2' && !['switching', 'env'].includes(stage) ? 'failed' : 'interrupted',
});
const toFile = (point: string, exit: Exit, stage: string, db: Cell['db'], guard: Cell['guard'] = 'boot', marker: Cell['marker'] = 'postgres'): Cell => ({
  to: 'file', point, exit, stage, db, marker, guard,
  result: exit === 'E2' ? (['switching', 'env'].includes(stage) ? 'interrupted' : 'failed') : undefined,
  state: stage === 'checking' && exit === 'E3' ? 'failed' : exit === 'E2' && !['switching', 'env'].includes(stage) ? 'failed' : 'interrupted',
});

const CELLS: Cell[] = [];
for (const exit of ['E2', 'E3'] as Exit[]) {
  CELLS.push(
    toPg('S2', exit, 'checking', 'none'),
    toPg('S3', exit, 'draining', 'none'),
    toPg('S4', exit, 'reading', 'none'),
    toPg('S5', exit, 'copying', 'none'),
    toPg('S6', exit, 'verifying', 'none'),
    toPg('S7', exit, 'rereading', 'none'),
    toPg('before-commit', exit, 'rereading', 'none'),
    toPg('S10', exit, 'switching', 'copy'),
    toPg('S11', exit, 'env', 'copy', 'postgres', /A migration is unfinished; run it again with --to postgres to finish it/),
    toFile('S2', exit, 'checking', 'source'),
    toFile('S3', exit, 'draining', 'source'),
    toFile('S4', exit, 'reading', 'source'),
    toFile('S5', exit, 'copying', 'source'),
    toFile('S6', exit, 'verifying', 'source'),
    toFile('S7', exit, 'rereading', 'source'),
    toFile('S8', exit, 'placing', 'source'),
    toFile('S9', exit, 'placing', 'source'),
    toFile('S10', exit, 'switching', 'retired', /A migration is unfinished; run it again with --to file to finish it/),
    toFile('S11', exit, 'env', 'retired', /A migration is unfinished; run it again with --to file to finish it/, 'file'),
  );
}
CELLS.push(
  { ...toFile('before-retire-commit', 'E2', 'placing', 'source'), result: 'failed', state: 'failed' },
  { ...toFile('before-retire-commit', 'E3', 'retire-source', 'source', /can't confirm whether migration job-cell-0001 retired the old store/), result: undefined, state: 'interrupted' },
);

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

const SEEDED_ROW = { guild_id: G, module: 'mod', filename: 'a.json', doc: '{"a":1}' };
const sourceFile = () => path.join(root, G, 'mod', 'a.json');

function seed(to: 'postgres' | 'file'): FakeDb {
  const db = new FakeDb();
  if (to === 'postgres') {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{"a":1}');
  } else {
    writeJson(MARKER, { live: 'postgres', storeId: 'src-cell', flippedAt: 1 });
    db.schemas.set('smdb_data', { ...emptyStore('src-cell'), data: [{ guild_id: G, module: 'mod', filename: 'a.json', doc: '{"a":1}' }] });
  }
  return db;
}

describe.each(CELLS)('$to: $exit at $point', cell => {
  it('leaves the disk, the journal, the store list, the guard and the status as the table says', async () => {
    const db = seed(cell.to);
    const fault = (point: string) => {
      if (point !== cell.point) return;
      throw cell.exit === 'E3' ? Object.assign(new Error('the process died'), { simulateDeath: true }) : new Error('injected failure');
    };
    const service = serviceFor(db, new FakeHost(), { fault });
    expect((await service.post({ jobId: 'job-cell-0001', to: cell.to })).body.state).toBe('started');
    await service.idle();

    const j = readJson(JOURNAL);
    expect(j.stage).toBe(cell.stage);
    expect(j.result).toBe(cell.result);
    expect(serviceFor(new FakeDb(), new FakeHost()).status().body.job.state).toBe(cell.state);
    expect(readJson(MARKER).live).toBe(cell.marker);

    const schemas = [...db.schemas.keys()];
    if (cell.db === 'none') expect(schemas).toEqual([]);
    if (cell.db === 'source') expect(db.schemas.get('smdb_data')?.storeId).toBe('src-cell');
    if (cell.db === 'source') expect(db.schemas.get('smdb_data')?.data).toEqual([SEEDED_ROW]);
    if (cell.db === 'copy') expect(db.schemas.get('smdb_data')?.data).toEqual([SEEDED_ROW]);
    if (cell.db === 'retired') {
      expect(db.schemas.has('smdb_data')).toBe(false);
      const retired = schemas.filter(s => s.startsWith('smdb_superseded_'));
      expect(retired).toHaveLength(1);
      expect(db.schemas.get(retired[0])?.storeId).toBe('src-cell');
      expect(db.schemas.get(retired[0])?.data).toEqual([SEEDED_ROW]);
    }
    if (cell.to === 'postgres') expect(fs.readFileSync(sourceFile(), 'utf-8')).toBe('{"a":1}');
    if (cell.to === 'file' && ['S9', 'before-retire-commit', 'S10', 'S11'].includes(cell.point)) expect(fs.readFileSync(sourceFile(), 'utf-8')).toBe('{"a":1}');
    if (cell.to === 'postgres' && cell.point === 'before-commit') {
      expect(j.storeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(readJson(STORES).storeIds).toContain(j.storeId);
    }
    if (cell.to === 'file' && cell.stage !== 'checking') expect(readJson(STORES).storeIds).toContain('src-cell');
    if (cell.to === 'postgres' && ['checking', 'draining', 'reading', 'copying', 'verifying'].includes(cell.stage)) expect(fs.existsSync(STORES)).toBe(false);
    if (cell.to === 'file' && cell.exit === 'E2' && (['copying', 'verifying', 'rereading'].includes(cell.stage) || cell.point === 'S8')) {
      expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
      expect(fs.existsSync(path.join(root, G))).toBe(false);
    }
    if (cell.to === 'file' && cell.exit === 'E3' && cell.point === 'S8') {
      expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toHaveLength(1);
      expect(fs.existsSync(path.join(root, G))).toBe(false);
    }

    setBackendKind(cell.to === 'postgres' ? 'file' : 'postgres');
    const verdict = evaluateRecognitionGuard();
    if (cell.guard === 'boot') expect(verdict.state).toBe('boot');
    else {
      expect(verdict.state).toBe('refused');
      expect((verdict as any).reason).toMatch(cell.guard);
    }
  });
});

describe('the cells of rows S1 and S12, and E9 on a JSON side', () => {
  function failRename(match: (to: string, from: string) => boolean, error = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })): void {
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (match(path.resolve(String(to)), String(from))) throw error;
      real(from, to);
    }) as any);
    syncBuiltinESMExports();
  }

  it('S1 E2: a failed journal write answers failed at checking and leaves no journal', async () => {
    const db = seed('postgres');
    failRename(to => to === path.resolve(JOURNAL));
    const service = serviceFor(db, new FakeHost());
    const answer = await service.post({ jobId: 'job-cell-0101', to: 'postgres' });
    expect(answer.body).toMatchObject({ success: true, jobId: 'job-cell-0101', state: 'failed', stage: 'checking' });
    expect(answer.body.error).toMatch(/ENOSPC/);
    expect(fs.existsSync(JOURNAL)).toBe(false);
    expect(service.running()).toBeNull();
    expect([...db.schemas.keys()]).toEqual([]);
    expect(readJson(MARKER).live).toBe('file');
  });

  it('S12 E2: a failed done write leaves the switch made; the status says done and the next POST writes done under the old jobId', async () => {
    const db = seed('postgres');
    let refusedTmp: string | null = null;
    failRename((to, from) => {
      if (refusedTmp !== null) return from === refusedTmp;
      if (to !== path.resolve(JOURNAL) || JSON.parse(fs.readFileSync(from, 'utf-8')).result !== 'done') return false;
      refusedTmp = from;
      return true;
    });
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-cell-0102', to: 'postgres' });
    await service.idle();
    expect(refusedTmp).not.toBeNull();
    expect(readJson(JOURNAL).result).toBeUndefined();
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', migration: 'job-cell-0102' });
    expect(fs.readFileSync(ENV, 'utf-8')).toMatch(/^DATA_BACKEND=postgres$/m);
    expect(service.status().body.job).toMatchObject({ jobId: 'job-cell-0102', state: 'done' });
    const again = await service.post({ jobId: 'job-cell-0103', to: 'postgres' });
    expect(again.body).toMatchObject({ success: true, jobId: 'job-cell-0102', state: 'done' });
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-cell-0102', result: 'done' });
  });

  it('E9 at S2 to file: a failed store list write ends failed at checking with the source serving', async () => {
    const db = seed('file');
    failRename(to => to === path.resolve(STORES));
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-cell-0104', to: 'file' });
    await service.idle();
    expect(readJson(JOURNAL)).toMatchObject({ stage: 'checking', result: 'failed' });
    expect(readJson(JOURNAL).error).toMatch(/ENOSPC/);
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(db.schemas.get('smdb_data')?.data).toEqual([SEEDED_ROW]);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', storeId: 'src-cell' });
  });

  it('E9 at S5 to file: ENOSPC while staging ends failed at copying with no staging folder left', async () => {
    const db = seed('file');
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags?: any, ...rest: any[]) => {
      if (String(p).includes(`${path.sep}.migrate-`) && flags === 'w') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return (realOpen as any)(p, flags, ...rest);
    }) as any);
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-cell-0105', to: 'file' });
    await service.idle();
    expect(readJson(JOURNAL)).toMatchObject({ stage: 'copying', result: 'failed' });
    expect(readJson(JOURNAL).error).toMatch(/ENOSPC/);
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
    expect(fs.existsSync(path.join(root, G))).toBe(false);
    expect(db.schemas.get('smdb_data')?.data).toEqual([SEEDED_ROW]);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', storeId: 'src-cell' });
  });
});
