import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { onTestFinished } from 'vitest';
import { DEAD_ENDS, scrubEnv } from './env';
import { STEP_MS } from './time.mjs';

// The repo this suite sits in, found from this file's own place, so a copy of
// the repo (a Stryker sandbox) runs its own dist and never another checkout's.
export const botRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(botRoot, 'dist') + path.sep;
const SCENARIOS = path.join(botRoot, 'test', 'child', 'scenarios');
// Preloaded in every scenario step: a fork that would lose DATA_DIR throws.
export const FORK_GUARD = path.join(botRoot, 'test', 'helpers', 'forkGuard.cjs');

// A throwaway data dir for one test, removed when the test ends.
export function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-child-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface ScenarioRun<T> {
  result: T;
  loaded: string[];
}

// The env a scenario step runs with: only what helpers/env.ts lets through, pg
// and git pointed at nothing, NODE_ENV 'test' and its own DATA_DIR.
export function childEnv(dataDir: string): NodeJS.ProcessEnv {
  return { ...scrubEnv({ ...process.env }), ...DEAD_ENDS, NODE_ENV: 'test', DATA_DIR: dataDir };
}

// Ends a process and every process it started that still descends from it,
// found by their parents while the tree stands: a process a step started would
// outlive the step's end. One whose parent already exited is not found, and
// where ps is missing, only the step is ended.
function endTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
    const tree = [pid];
    for (let i = 0; i < tree.length; i++) for (const [child, parent] of rows) if (parent === tree[i]) tree.push(child);
    for (const each of tree) {
      try { process.kill(each, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* the caller ends the step itself */ }
}

// Runs one scenario step in its own process and returns its RESULT line. The
// child's cwd is its data dir, so a `dotenv/config` import in the bot finds no
// .env; its env is childEnv's. It fails on a missing RESULT line, a nonzero
// exit, a timeout (and ends the step's processes, endTree), or a bot module
// loaded from anywhere but this repo's dist.
export function runScenario<T>(script: string, args: string[], dataDir: string, timeoutMs = STEP_MS): Promise<ScenarioRun<T>> {
  const env = childEnv(dataDir);
  const child = spawn(process.execPath, ['--require', FORK_GUARD, path.join(SCENARIOS, script), ...args], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.pid !== undefined) endTree(child.pid);
      child.kill('SIGKILL');
      reject(new Error(`scenario ${script} ${args.join(' ')} did not finish in ${timeoutMs} ms\n${stderr}`));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
      if (code !== 0 || !line) {
        reject(new Error(`scenario ${script} ${args.join(' ')} exited ${code ?? signal} with ${line ? 'a' : 'no'} RESULT line\n${stderr}`));
        return;
      }
      const parsed = JSON.parse(line.slice('RESULT '.length)) as ScenarioRun<T>;
      const guard = new Set([FORK_GUARD, fs.realpathSync(FORK_GUARD)]);
      if (!parsed.loaded.some(file => guard.has(file))) {
        reject(new Error(`scenario ${script} ran without ${FORK_GUARD} preloaded`));
        return;
      }
      const run = { ...parsed, loaded: parsed.loaded.filter(file => !guard.has(file)) };
      const foreign = run.loaded.filter(file => !file.startsWith(DIST));
      if (run.loaded.length === 0 || foreign.length > 0) {
        reject(new Error(`scenario ${script} must load the bot from ${DIST}, but loaded ${run.loaded.length === 0 ? 'nothing' : foreign.join(', ')}`));
        return;
      }
      resolve(run);
    });
  });
}
