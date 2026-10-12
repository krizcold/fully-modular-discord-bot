// The run with no mutant after the reruns alone (mutation/README.md): the
// reruns' tests once more, in the checkout itself, the way the reruns ran them.
// What the reruns counted holds only if this passes.
import { spawn, spawnSync } from 'child_process';
import path from 'path';

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
    child.on('error', error => { clearTimeout(timer); resolve({ passed: false, why: error.message }); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve({ passed: false, why: `it ran past its bound of ${Math.round(timeoutMs / 1000)} s, and was ended with every process it started` });
      else resolve(code === 0 ? { passed: true, why: '' } : { passed: false, why: `exit ${code ?? signal}` });
    });
  });
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
