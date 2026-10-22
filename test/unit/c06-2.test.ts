import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repo = path.resolve(__dirname, '..', '..');
const startSh = fs.readFileSync(path.join(repo, 'start.sh'), 'utf8');

describe('start.sh rebuild completion', () => {
  it('drops the applied stamp before the rebuild touches dist', () => {
    const branch = startSh.indexOf('rebuilding /app/build and /app/dist');
    const drop = startSh.indexOf('rm -f /data/applied-version.json', branch);
    const stage = startSh.indexOf('stage_sources', branch);
    expect(branch).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(branch);
    expect(drop).toBeLessThan(stage);
  });

  it('syncs dist, writes the stamp through a temp file, and writes the marker in dist last', () => {
    const info = startSh.indexOf('build-info.js\',\'window.BOT_BUILD');
    const sync = startSh.indexOf('\n    sync\n', info);
    const tmp = startSh.indexOf('/data/applied-version.json.tmp', info);
    const mv = startSh.indexOf('mv /data/applied-version.json.tmp /data/applied-version.json', info);
    const marker = startSh.indexOf('/app/dist/.build-complete', mv);
    expect(info).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(info);
    expect(tmp).toBeGreaterThan(sync);
    expect(mv).toBeGreaterThan(tmp);
    expect(marker).toBeGreaterThan(mv);
  });

  it('reuses dist only with the marker for this buildId and a non-empty index.js', () => {
    const cond = startSh.split('\n').find(l => l.startsWith('if [ "$IMAGE_BUILD_ID" != "$APPLIED_BUILD_ID" ]')) ?? '';
    expect(cond).toContain('[ ! -s /app/dist/index.js ]');
    expect(cond).toContain('$BUILD_COMPLETE_ID');
    expect(startSh).toContain('the previous build is not on disk whole; rebuilding');
  });
});

describe('the compose overlay description', () => {
  it('says when /app/custom is applied', () => {
    const compose = fs.readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('Applied when the container is rebuilt: a new image or a recreate; a plain restart keeps the previous build');
  });
});

describe('sync engine on a pristine-source fallback build', () => {
  it('reports degraded with the reason, never in sync', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-c062-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'build-safe-mode.json'), JSON.stringify({ reason: 'TypeScript compilation failed' }));
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = root;
    onTestFinished(() => { if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev; });
    vi.resetModules();
    const { SyncEngine } = await import('../../src/bot/internalSetup/fleet/syncEngine');
    const reports: any[] = [];
    const engine = new SyncEngine({ request: async () => null, getTerm: () => 1, sendReport: r => reports.push(r) });
    (engine as any).finishOk({ revision: 1, modules: [] }, 1);
    const state = engine.getSyncState();
    expect(state.status).toBe('degraded');
    expect(state.lastError).toBe('this node runs pristine sources: TypeScript compilation failed');
    expect(reports.at(-1).ok).toBe(false);
  });
});

describe('modules missing from dist', () => {
  async function rig(split: boolean, safeMode: boolean) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-c062b-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const dist = path.join(root, 'dist');
    const build = split ? path.join(root, 'build') : dist;
    for (const d of [source, dist, build]) fs.mkdirSync(d, { recursive: true });
    if (safeMode) fs.writeFileSync(path.join(root, 'build-safe-mode.json'), JSON.stringify({ reason: 'TypeScript compilation failed' }));
    const mod = (name: string, withManifest: boolean) => {
      fs.mkdirSync(path.join(source, name), { recursive: true });
      if (withManifest) fs.writeFileSync(path.join(source, name, 'module.json'), '{}');
    };
    vi.resetModules();
    vi.doMock('../../src/utils/dataRoot', () => ({ DATA_ROOT: root, dataPath: (...s: string[]) => path.join(root, ...s) }));
    vi.doMock('../../src/bot/internalSetup/utils/pathHelpers', async (orig) => ({
      ...(await orig() as object),
      getModulesDir: () => dist,
      getBuildModulesDir: () => build,
      getSourceModulesDir: () => source,
    }));
    onTestFinished(() => { vi.doUnmock('../../src/utils/dataRoot'); vi.doUnmock('../../src/bot/internalSetup/utils/pathHelpers'); });
    const { SyncEngine } = await import('../../src/bot/internalSetup/fleet/syncEngine');
    const reports: any[] = [];
    const engine = new SyncEngine({ request: async () => null, getTerm: () => 1, sendReport: r => reports.push(r) });
    return { engine, mod, reports, degraded: () => [...(engine as any).degradedModules] };
  }

  it('marks an enabled module whose source has module.json and dist does not; skips disabled and non-modules', async () => {
    const r = await rig(true, false);
    r.mod('alpha', true);
    r.mod('beta', true);
    r.mod('notes', false);
    (r.engine as any).finishOk({ revision: 1, modules: [{ name: 'alpha' }, { name: 'beta', enabled: false }, { name: 'notes' }] }, 1);
    expect(r.degraded()).toEqual(['alpha']);
  });

  it('marks nothing on the dev layout', async () => {
    const r = await rig(false, false);
    r.mod('alpha', true);
    (r.engine as any).finishOk({ revision: 1, modules: [{ name: 'alpha' }] }, 1);
    expect(r.degraded()).toEqual([]);
  });

  it('leaves the degraded set alone on a pristine build and reports the pristine reason', async () => {
    const r = await rig(true, true);
    r.mod('alpha', true);
    (r.engine as any).finishOk({ revision: 1, modules: [{ name: 'alpha' }] }, 1);
    expect(r.degraded()).toEqual([]);
    expect(r.engine.getSyncState().lastError).toBe('this node runs pristine sources: TypeScript compilation failed');
    expect(r.reports.at(-1).ok).toBe(false);
  });
});
