// The run with no mutant after the reruns alone (mutation/README.md): a pass's
// tests once more, in the checkout itself, the way the reruns ran them. What
// the reruns counted holds only if this passes.
import { spawnSync } from 'child_process';
import path from 'path';

/**
 * @param {{ root: string, out: string, tier: 'a' | 'b', files: string[], env?: NodeJS.ProcessEnv }} run
 * @returns {{ passed: boolean, why: string }}
 */
export function runControl({ root, out, tier, files, env = process.env }) {
  const { __STRYKER_ACTIVE_MUTANT__: _active, ...rest } = env;
  const run = spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'runner.mjs')], {
    cwd: root,
    stdio: 'ignore',
    timeout: 60 * 60_000,
    env: { ...rest, SMDB_MUTATION_PASS: tier, SMDB_MUTATION_CONFIRM: '1', SMDB_MUTATION_FILES: JSON.stringify(files), SMDB_MUTATION_OUT: out },
  });
  if (run.status === 0) return { passed: true, why: '' };
  return { passed: false, why: run.error ? run.error.message : `exit ${run.status ?? run.signal}` };
}
