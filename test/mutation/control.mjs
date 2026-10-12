// The run with no mutant after the reruns alone (mutation/README.md): the
// reruns' tests once more, in the checkout itself, the way the reruns ran them.
// What the reruns counted holds only if this passes.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** @type {NodeJS.Signals[]} */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * @param {{ root: string, out: string, tier: 'a' | 'b', files: string[], only: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number }} run
 *   only: the test files the reruns ran (pass B's), or none for pass A's
 * @returns {Promise<{ passed: boolean, why: string }>}
 */
export function runControl({ root, out, tier, files, only, env = process.env, timeoutMs = 60 * 60_000 }) {
  const { __STRYKER_ACTIVE_MUTANT__: _active, ...rest } = env;
  return new Promise(resolve => {
    // On POSIX the run gets its own process group, so the bound ends vitest and
    // every process it started with it, as Stryker ends a mutant's run.
    const child = spawn(process.execPath, [path.join(root, 'test', 'mutation', 'runner.mjs')], {
      cwd: root,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      env: {
        ...rest, SMDB_MUTATION_PASS: tier, SMDB_MUTATION_CONFIRM: '1', SMDB_MUTATION_FILES: JSON.stringify(files),
        SMDB_MUTATION_ONLY: JSON.stringify(only), SMDB_MUTATION_OUT: out,
      },
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    // Outside the gate's process group on POSIX, the run would outlive a
    // Ctrl-C or a hangup of the gate: end it first, then the gate as the
    // signal would have.
    /** @param {NodeJS.Signals} signal */
    const interrupted = signal => {
      settle();
      killTree(child.pid);
      process.kill(process.pid, signal);
    };
    const settle = () => {
      clearTimeout(timer);
      for (const signal of SIGNALS) process.off(signal, interrupted);
    };
    for (const signal of SIGNALS) process.once(signal, interrupted);
    child.on('error', error => { settle(); resolve({ passed: false, why: error.message }); });
    child.on('exit', (code, signal) => {
      settle();
      if (timedOut) resolve({ passed: false, why: `it ran past its bound of ${Math.round(timeoutMs / 1000)} s, and was ended with every process it started` });
      else resolve(code === 0 ? { passed: true, why: '' } : { passed: false, why: `exit ${code ?? signal}` });
    });
  });
}

/**
 * Why a run with no mutant that passed still clears no timeout of the reruns:
 * it did not fit in the budget Stryker gave each rerun (`timeoutFactor` times
 * the reruns' own run with no mutant, plus `timeoutMS`), so the machine was as
 * slow as the mutants seemed; or a time could not be read. '' when it fits.
 * runner.mjs leaves the time of each run with no mutant in its dir's dry-ms.txt.
 * @param {string} reruns the reruns' report dir
 * @param {string} out this run's report dir
 * @param {{ timeoutFactor: number, timeoutMS: number }} budget
 */
export function pastBudget(reruns, out, { timeoutFactor, timeoutMS }) {
  /** @param {string} dir */
  const msOf = dir => { try { return Number(fs.readFileSync(path.join(dir, 'dry-ms.txt'), 'utf8')); } catch { return NaN; } };
  const took = msOf(out);
  const budget = timeoutFactor * msOf(reruns) + timeoutMS;
  if (took <= budget) return '';
  if (!Number.isFinite(took) || !Number.isFinite(budget)) return "its time, or the time of the reruns' own run with no mutant, could not be read";
  return `it took ${Math.round(took / 1000)} s, past the ${Math.round(budget / 1000)} s Stryker gave each rerun, so the machine was too slow then to tell a slow mutant from a slow run`;
}

/**
 * Ends a process and every process it started.
 * @param {number | undefined} pid
 */
function killTree(pid) {
  if (pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
