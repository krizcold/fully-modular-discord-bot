import { spawn } from 'child_process';
import path from 'path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { botRoot, childEnv, FORK_GUARD, freshDataDir } from '../helpers/child';
import { freshDatabaseUrl, startPostgres } from '../helpers/postgres';

// NB6 test 45 [kill] (wip-redesign/sheets/NB6.md rows 64, 124 to 126 and 200; decisions 43, 45, 58, 66 and 68, C15;
// part 18): a bot process running `applyModuleChange` is killed with SIGKILL at each step of the apply; the next
// boot's recovery and its boot apply leave the row's version in place and loaded, and the build and dist folders hold
// that version's files only. A SIGKILL never reaches guardUncaught, so nothing is counted. Run on the built dist with
// real Postgres, started here.

const SCENARIO = path.join(botRoot, 'test', 'child', 'scenarios', 'nb6ApplyCrash.cjs');
const U_FILES = ['module.json', 'only-2.0.0.js'];

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await startPostgres();
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

/** One row's data dir and its own database, so its boots see only the modules it placed. */
interface Row { dataDir: string; url: string }
const freshRow = async (): Promise<Row> => ({ dataDir: freshDataDir(), url: await freshDatabaseUrl(container, 'nb6row') });

interface Step { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function step(args: string[], row: Row, extra: NodeJS.ProcessEnv = {}): Promise<Step> {
  const env = { ...childEnv(row.dataDir), DATA_BACKEND: 'postgres', NB6_URL: row.url, ...extra };
  const child = spawn(process.execPath, ['--require', FORK_GUARD, SCENARIO, ...args], { cwd: row.dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${args[0]} did not finish\n${stderr}`)); }, 180_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

function resultOf(run: Step): any {
  const line = run.stdout.split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT line (code ${run.code})\n${run.stderr}`);
  return JSON.parse(line.slice('RESULT '.length)).result;
}

describe('rows 64, 124 to 126 and 200: killed at each step of an apply', () => {
  it.each([
    ['intent', '124: after the intent, before any rename'],
    ['backup', '125 and 64: after the move to the backup, before the rename into place'],
    ['copy', "200: during step 3's copy into build"],
    ['compile', '126: during the compile'],
    ['load', '126: during the load'],
  ])('%s (%s): the next boot recovers, applies the row again and loads it; build and dist hold its files only', async point => {
    const row = await freshRow();
    const name = `crash-${point}`;
    const setup = resultOf(await step(['setup', name], row));
    const killed = await step(['kill', name, point, setup.u, setup.staged], row);
    expect(killed.stdout).not.toContain('RESULT ');
    expect(killed.signal ?? killed.code).not.toBe(0);

    const booted = await step(['boot', name], row);
    expect(booted.code).toBe(0);
    const out = resultOf(booted);
    const m = out.modules[name];
    expect(m.live).toBe(setup.u);
    expect(m.build).toEqual(U_FILES);
    expect(m.dist).toEqual(U_FILES);
    expect(out.loaded).toContain(name);
    expect(m.entry).toMatchObject({ sha: setup.u, applying: null, failedSha: null });
    expect(out.lines[name]).toBeUndefined();
    expect(booted.stdout + booted.stderr).toContain(`[Shared] ${name}: applying 2.0.0 was cut off when the bot process ended;`);
  }, 600_000);
});
