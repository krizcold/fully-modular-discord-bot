import { spawn } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { childEnv, FORK_GUARD, botRoot, freshDataDir, runScenario } from '../helpers/child';
import { TIME_SCALE } from '../helpers/time.mjs';

// NB8 test 21 (cells R2.x to R9.x, decision 72): a process running a whole-bot restore is killed with SIGKILL at each
// stage boundary and inside phases A and B; a new process's recovery and step 8 end the restore. A kill before any data
// moved ends failed with the live data unchanged and staging removed; a kill once phase A moved a unit ends done with
// the live data equal to the snapshot and the pre-restore backup equal to the data it replaced.

const SCRIPT = path.join(botRoot, 'test', 'child', 'scenarios', 'nb8KillRestore.cjs');
const STEP_MS = 60_000 * TIME_SCALE;

type Check = { end: string | null; step8: string; stage: string | null; live: Record<string, string>; old: Record<string, string>; new: Record<string, string>; pre: Record<string, string> | null; staging: boolean | null };

function killAt(dataDir: string, point: string): Promise<void> {
  const child = spawn(process.execPath, ['--require', FORK_GUARD, SCRIPT, 'restore', point], { cwd: dataDir, env: childEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no AT ${point} in ${STEP_MS} ms\n${out}\n${err}`)); }, STEP_MS);
    child.stderr!.on('data', chunk => { err += chunk; });
    child.stdout!.on('data', chunk => {
      out += chunk;
      if (out.includes(`AT ${point}`)) child.kill('SIGKILL');
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL' && out.includes(`AT ${point}`)) resolve();
      else reject(new Error(`the restore exited ${code ?? signal} before AT ${point}\n${out}\n${err}`));
    });
  });
}

describe('NB8 test 21: a restore killed part way', () => {
  it.each(['after-staging', 'after-staged', 'after-swapping'])('killed %s: the next process ends it failed with the data unchanged', async point => {
    const dataDir = freshDataDir();
    await killAt(dataDir, point);
    const { result } = await runScenario<Check>('nb8KillRestore.cjs', ['check'], dataDir, STEP_MS);
    expect(result.stage).toBe('failed');
    expect(result.live).toEqual(result.new);
    expect(result.staging).toBe(false);
    expect(result.pre).toBeNull();
  });

  it.each(['in-phase-a', 'after-placing', 'in-phase-b', 'after-placed'])('killed %s: the next process ends it done, live equal to the snapshot', async point => {
    const dataDir = freshDataDir();
    await killAt(dataDir, point);
    const { result } = await runScenario<Check>('nb8KillRestore.cjs', ['check'], dataDir, STEP_MS);
    expect(result.stage).toBe('done');
    expect(result.live).toEqual(result.old);
    expect(result.pre).toEqual(result.new);
    // A kill right after `placed` leaves the emptied staging folder, which the prune removes after an hour (decision 69).
    if (point !== 'after-placed') expect(result.staging).toBe(false);
  });
});
