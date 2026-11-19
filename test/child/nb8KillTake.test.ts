import { spawn } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { childEnv, FORK_GUARD, botRoot, freshDataDir, runScenario } from '../helpers/child';
import { TIME_SCALE } from '../helpers/time.mjs';

// NB8 test 20 (cells T2.x, T3.x, T4.x, T6.x): a bot process taking a snapshot of a busy data folder is killed with
// SIGKILL during pass 1, during a catch-up round, right after the turn and between the manifest and the rename; a web
// UI process running the local take is killed inside its final op. Live files stay whole, no complete snapshot holds
// partial content, and the next take removes the leftover work folder.

const SCRIPT = path.join(botRoot, 'test', 'child', 'scenarios', 'nb8KillTake.cjs');
const STEP_MS = 60_000 * TIME_SCALE;

type Check = { unparsed: string[]; mismatched: string[]; before: string[]; after: string[]; taken: string; answer: { ok: boolean } };

function killAt(dataDir: string, point: string): Promise<void> {
  const child = spawn(process.execPath, ['--require', FORK_GUARD, SCRIPT, 'take', point], { cwd: dataDir, env: childEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
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
      else reject(new Error(`the take exited ${code ?? signal} before AT ${point}\n${out}\n${err}`));
    });
  });
}

describe('NB8 test 20: a take killed part way', () => {
  it.each(['pass1', 'round', 'after-turn', 'before-rename', 'final-op'])('killed at %s: live files whole, no partial snapshot, the leftover removed by the next take', async point => {
    const dataDir = freshDataDir();
    await killAt(dataDir, point);
    const { result } = await runScenario<Check>('nb8KillTake.cjs', ['check'], dataDir, STEP_MS);
    expect(result.unparsed).toEqual([]);
    expect(result.mismatched).toEqual([]);
    expect(result.before).toHaveLength(1);
    expect(result.taken).toBe('taken');
    expect(result.answer).toMatchObject({ ok: true });
    expect(result.after).toEqual([]);
  });
});
