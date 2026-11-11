import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { botRoot, freshDataDir, REACH_RECORDER, runScenario } from '../helpers/child';
import { readRecordDir } from '../mutation/reach.mjs';

// What helpers/child.ts lets a scenario step load (mutation/README.md, "Child scenarios"): the bot from this root's
// dist, the fork guard, which it must preload, and the reach recorder a gate's run with no mutant preloads through
// NODE_OPTIONS; nothing else.

// Read before the describe below loads the recorder: under a gate's own run with no mutant (helpers/mutationCoverage.ts)
// this file's process already records, so the record this file opens is its process's second.
const outer = Symbol.for('smdb.reachRecorder') in globalThis;
const DIST_FILE = path.join(botRoot, 'dist', 'bot', 'x.js');
const echo = (extra: string[], ...flags: string[]) => runScenario<{ pid: number; reach: string | null; token: string | null }>('loadedEcho.cjs', [JSON.stringify(extra), ...flags], freshDataDir());

describe('a scenario step checked by helpers/child.ts', () => {
  it('passes one that loaded the bot from dist, and gives back only those modules', async () => {
    expect((await echo([DIST_FILE])).loaded).toEqual([DIST_FILE]);
  });

  it("passes one that loaded this root's reach recorder, and leaves it out of what it gives back", async () => {
    expect((await echo([DIST_FILE, REACH_RECORDER])).loaded).toEqual([DIST_FILE]);
    expect((await echo([REACH_RECORDER, DIST_FILE, fs.realpathSync(REACH_RECORDER)])).loaded).toEqual([DIST_FILE]);
  });

  it('fails one that loaded any other module outside dist, the recorder there or not', async () => {
    const others = [
      path.join(botRoot, 'test', 'helpers', 'time.mjs'),
      path.join(botRoot, 'test', 'helpers', 'mutationCoverage.ts'),
      path.join(botRoot, 'src', 'bot', 'x.js'),
      path.join(path.dirname(botRoot), 'another-checkout', 'test', 'helpers', 'reachRecorder.cjs'),
      path.join(path.dirname(botRoot), 'another-checkout', 'dist', 'bot', 'x.js'),
      `${REACH_RECORDER}.js`,
    ];
    for (const other of others) {
      await expect(echo([DIST_FILE, REACH_RECORDER, other]), other).rejects.toThrow(`but loaded ${other}`);
      await expect(echo([DIST_FILE, other]), other).rejects.toThrow(`but loaded ${other}`);
    }
  });

  it('fails one that loaded nothing of the bot beside the recorder', async () => {
    await expect(echo([REACH_RECORDER])).rejects.toThrow('but loaded nothing');
  });

  it('fails one that lacks the fork guard, the recorder there or not', async () => {
    await expect(echo([DIST_FILE, REACH_RECORDER], 'no-guard')).rejects.toThrow('ran without');
    await expect(echo([DIST_FILE], 'no-guard')).rejects.toThrow('ran without');
  });
});

// Last in the file: from its beforeAll on, the recorder hooks every process this one starts.
describe('a scenario step under the reach recorder, as a gate run with no mutant starts it', () => {
  const recorder = createRequire(__filename)(REACH_RECORDER) as { openTestFile(coverage: string, file: string): void };
  let coverage = '';
  let recordDir = '';
  const lines = () => fs.readdirSync(recordDir).map(name => fs.readFileSync(path.join(recordDir, name), 'utf8').trim().split('\n').map(text => JSON.parse(text) as Record<string, unknown>));
  // The records of the start that gave `token` and of the process it started.
  const startOf = (token: string) => ({
    starts: lines().flat().filter(entry => entry.start === token).map(({ start, kind }) => ({ start, kind })),
    children: lines().filter(record => record[0].role === 'child' && record[0].token === token).length,
  });
  const ownStarts = () => lines().filter(record => record[0].role === 'file').flat().filter(entry => typeof entry.start === 'string').map(entry => entry.start);
  const SECOND = 'its process ran another test file first';

  beforeAll(() => {
    coverage = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-childreach-'));
    recorder.openTestFile(coverage, path.join(coverage, 'probe.test.ts'));
    [recordDir] = fs.readdirSync(coverage).map(name => path.join(coverage, name));
  });
  afterAll(() => fs.rmSync(coverage, { recursive: true, force: true }));

  it('passes with the recorder preloaded for real, and the step left a record that carries its start', async () => {
    const run = await echo([DIST_FILE]);
    expect(run.loaded).toEqual([DIST_FILE]);
    expect(run.result.reach).toBe(recordDir);
    expect(run.result.token).toMatch(/^[0-9a-f]{16}$/);
    expect(startOf(run.result.token!)).toEqual({ starts: [{ start: run.result.token, kind: 'node' }], children: 1 });
    const file = path.join(coverage, 'probe.test.ts');
    expect(readRecordDir(recordDir)).toEqual(outer ? { file, ids: expect.any(Array), unsure: SECOND } : { file, ids: [] });
    // Preloaded and nothing of the bot beside it: still nothing loaded.
    await expect(echo([])).rejects.toThrow('but loaded nothing');
  });

  it.runIf(fs.existsSync(path.join(botRoot, 'dist', 'bot', 'internalSetup', 'fleet', 'nodeIdentity.js')))(
    "runs nodeIdentity.cjs on this root's dist under the recorder, and every process it started left a record", async () => {
      const before = ownStarts().length;
      const run = await runScenario<string>('nodeIdentity.cjs', [], freshDataDir());
      expect(run.result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(run.loaded.length).toBeGreaterThan(0);
      expect(run.loaded.every(file => file.startsWith(path.join(botRoot, 'dist') + path.sep))).toBe(true);
      const starts = ownStarts();
      expect(starts.length).toBe(before + 1);
      expect(startOf(String(starts.at(-1)))).toEqual({ starts: [{ start: starts.at(-1), kind: 'node' }], children: 1 });
      const record = readRecordDir(recordDir);
      expect(record.file).toBe(path.join(coverage, 'probe.test.ts'));
      expect(record.unsure).toBe(outer ? SECOND : undefined);
    },
  );
});
