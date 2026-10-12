import { spawn } from 'child_process';
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

// Runs one scenario step in its own process and returns its RESULT line. The
// child's cwd is its data dir, so a `dotenv/config` import in the bot finds no
// .env; its env is childEnv's. It fails on a missing RESULT line, a nonzero
// exit, a timeout, or a bot module loaded from anywhere but this repo's dist.
export function runScenario<T>(script: string, args: string[], dataDir: string, timeoutMs = STEP_MS): Promise<ScenarioRun<T>> {
  const env = childEnv(dataDir);
  const child = spawn(process.execPath, [path.join(SCENARIOS, script), ...args], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
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
      const run = JSON.parse(line.slice('RESULT '.length)) as ScenarioRun<T>;
      const foreign = run.loaded.filter(file => !file.startsWith(DIST));
      if (run.loaded.length === 0 || foreign.length > 0) {
        reject(new Error(`scenario ${script} must load the bot from ${DIST}, but loaded ${run.loaded.length === 0 ? 'nothing' : foreign.join(', ')}`));
        return;
      }
      resolve(run);
    });
  });
}
