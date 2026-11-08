import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { botRoot, childEnv, FORK_GUARD, freshDataDir } from '../helpers/child';
import { freshDatabaseUrl, startPostgres } from '../helpers/postgres';

// NB6 test 57 [kill] (wip-redesign/sheets/NB6.md decisions 66, 78 to 80, 89, 90, 99, 100; rows 209, 249, 250, 253,
// 259, 260, 293, 330, 331; 206 and 207 as 66 replaced them; C15; part 18): a child process runs runBot's boot steps
// with the real guardUncaught installed; a fixture module's code throws uncaught (in its onReady, in its initializer's
// window, or from a timer of its own file after its 60 s turn) and the process exits 1 through guardUncaught, as
// BotManager sees a crash. The harness starts the child again as BotManager does. After two counted crashes of one sha
// the third start keeps the previous version (an apply) or holds the version in place. Row 330 starts from a live
// apply through the bot's module:apply IPC handler (scenario mode live). Run on the built dist with real Postgres,
// started here.

const SCENARIO = path.join(botRoot, 'test', 'child', 'scenarios', 'nb6ApplyCrash.cjs');

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
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${args[0]} did not finish\n${stderr}`)); }, 240_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

function resultOf(run: Step): any {
  const line = run.stdout.split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT line (code ${run.code})\n${run.stderr}`);
  return JSON.parse(line.slice('RESULT '.length)).result;
}

const output = (run: Step) => run.stdout + run.stderr;
const crashLines = (dataDir: string) => {
  const file = path.join(dataDir, 'global', 'appstore', 'cache', 'module-crashes.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
};

/** The child's start as BotManager makes it after a crash: the boot with guardUncaught installed. */
const boot = (row: Row, names: string[], env: NodeJS.ProcessEnv = {}) => step(['guard', ...names], row, env);

describe('a version applied at boot that stops the bot while it starts (209, 249, 250, 253, 293)', () => {
  it.each([
    ['initializer', '209, 249, 250 and 253: its initializer throws uncaught in its turn window'],
    ['onReady', '293: its onReady throws uncaught after a clean load window'],
  ])('%s (%s): n 1, the once-more tail, n 2; the third start keeps the previous version with failedSha and a failed status', async thrown => {
    const row = await freshRow();
    const name = `loop-${thrown.toLowerCase()}`;
    const s = resultOf(await step(['place', name, '1.0.0'], row)).sha;
    const u = resultOf(await step(['publish', name, '2.0.0'], row, { NB6_THROW: thrown })).sha;

    const first = await boot(row, [name]);
    expect(first.code).toBe(1);
    expect(output(first)).toContain('[Error] Uncaught exception; the bot process exits:');
    expect(crashLines(row.dataDir)[name]).toMatchObject({ sha: u, n: 1 });

    const second = await boot(row, [name]);
    expect(second.code).toBe(1);
    expect(output(second)).toContain(`[Shared] ${name}: applying 2.0.0 was cut off when the bot stopped while it was starting 2.0.0; put back the previous version from`);
    expect(output(second)).toContain(`if the bot stops again while starting 2.0.0, this machine keeps the previous version.`);
    expect(crashLines(row.dataDir)[name]).toMatchObject({ sha: u, n: 2 });

    const third = await boot(row, [name]);
    expect(third.code).toBe(0);
    const out = resultOf(third);
    // Decision 83 (sheet, the status paragraph): the upsert's answer clears the entry's status; the row holds 'failed'.
    expect(out.modules[name].entry).toMatchObject({ sha: s, failedSha: u, applying: null, status: null });
    expect(out.modules[name].statusRows).toEqual([expect.objectContaining({ sha: u, state: 'failed', error: expect.stringContaining('the bot stopped twice while it was starting it (') })]);
    expect(out.modules[name].live).toBe(s);
    expect(out.loaded).toContain(name);
    expect(output(third)).toContain(`[Shared] The bot stopped twice while it was starting ${name} 2.0.0 on this machine (the error at the second stop: the module stopped the bot); this machine keeps the previous version and does not try 2.0.0 again until ${name} is updated, or uninstalled and installed again`);
  }, 900_000);
});

describe('259: a new install that stops the bot twice', () => {
  it("keeps the entry { sha: 'absent', failedSha: to } and no copy; T5 and T1's crash form with \"no copy of\"", async () => {
    const row = await freshRow();
    const name = 'loop-new';
    const u = resultOf(await step(['publish', name, '1.0.0'], row, { NB6_THROW: 'initializer', NB6_THROW_VERSION: '1.0.0' })).sha;
    expect((await boot(row, [name])).code).toBe(1);
    expect((await boot(row, [name])).code).toBe(1);
    const third = await boot(row, [name]);
    expect(third.code).toBe(0);
    const out = resultOf(third);
    expect(out.modules[name].entry).toMatchObject({ sha: 'absent', failedSha: u });
    expect(out.modules[name].live).toBe('absent');
    expect(out.loaded).not.toContain(name);
    expect(output(third)).toContain(`this machine keeps no copy of ${name} and does not try 1.0.0 again`);
  }, 900_000);
});

describe('260: two modules applied in one boot, one stops the bot twice', () => {
  it('only that module is held back; the other is applied', async () => {
    const row = await freshRow();
    const a1 = resultOf(await step(['place', 'loop-a', '1.0.0'], row)).sha;
    resultOf(await step(['place', 'loop-b', '1.0.0'], row));
    const a2 = resultOf(await step(['publish', 'loop-a', '2.0.0'], row, { NB6_THROW: 'initializer', NB6_THROW_MODULE: 'loop-a' })).sha;
    const b2 = resultOf(await step(['publish', 'loop-b', '2.0.0'], row)).sha;
    expect((await boot(row, ['loop-a', 'loop-b'])).code).toBe(1);
    expect((await boot(row, ['loop-a', 'loop-b'])).code).toBe(1);
    const third = await boot(row, ['loop-a', 'loop-b']);
    expect(third.code).toBe(0);
    const out = resultOf(third);
    expect(out.modules['loop-a'].entry).toMatchObject({ sha: a1, failedSha: a2 });
    expect(out.modules['loop-b'].entry).toMatchObject({ sha: b2, failedSha: null, applying: null });
    expect(out.loaded).toEqual(expect.arrayContaining(['loop-a', 'loop-b']));
  }, 900_000);
});

describe("330: a version applied live whose initializer throws uncaught after its 60 s turn, then again in the boot apply's late start", () => {
  it("n 1 for to at the live apply's late start; the next boot puts back the backup (T4's once-more tail) and applies again; n 2; then the previous version kept", async () => {
    const row = await freshRow();
    const name = 'loop-live';
    const s = resultOf(await step(['place', name, '1.0.0'], row)).sha;
    const live = await step(['live', name, '2.0.0'], row, { NB6_THROW: 'late' });
    expect(live.code).toBe(1);
    const liveLine = live.stdout.split('\n').find(l => l.startsWith('LIVE '));
    if (!liveLine) throw new Error(`no LIVE line (code ${live.code})\n${live.stderr}`);
    const u = JSON.parse(liveLine.slice('LIVE '.length)).sha;
    expect(output(live)).toContain(`[Reloader] ${name}'s initializers did not finish within 60 s;`);
    expect(output(live)).toContain('[Error] Uncaught exception; the bot process exits:');
    expect(crashLines(row.dataDir)[name]).toMatchObject({ sha: u, n: 1 });

    const second = await boot(row, [name], { NB6_THROW: 'late' });
    expect(second.code).toBe(1);
    expect(output(second)).toContain(`[Shared] ${name}: applying 2.0.0 was cut off when the bot stopped while it was starting 2.0.0; put back the previous version from`);
    expect(output(second)).toContain('if the bot stops again while starting 2.0.0, this machine keeps the previous version.');
    expect(output(second)).toContain(`[Initializer] ${name}'s initializers did not finish within 60 s;`);
    expect(crashLines(row.dataDir)[name]).toMatchObject({ sha: u, n: 2 });

    const third = await boot(row, [name]);
    expect(third.code).toBe(0);
    const out = resultOf(third);
    expect(out.modules[name].entry).toMatchObject({ sha: s, failedSha: u, applying: null });
    expect(out.modules[name].live).toBe(s);
    expect(out.loaded).toContain(name);
    expect(output(third)).toContain(`[Shared] The bot stopped twice while it was starting ${name} 2.0.0 on this machine (the error at the second stop: the module stopped the bot); this machine keeps the previous version and does not try 2.0.0 again until ${name} is updated, or uninstalled and installed again`);
  }, 900_000);
});

describe('331: a version in place whose initializer throws uncaught after its 60 s turn, at two boots', () => {
  it('n 1 then n 2 against the only late start; heldSha set and not loaded at the third boot; T1 in-place form and T24', async () => {
    const row = await freshRow();
    const name = 'loop-late';
    const s = resultOf(await step(['place', name, '1.0.0'], row, { NB6_THROW: 'late', NB6_THROW_VERSION: '1.0.0' })).sha;
    const first = await boot(row, [name], { NB6_THROW: 'late' });
    expect(first.code).toBe(1);
    expect(output(first)).toContain(`[Initializer] ${name}'s initializers did not finish within 60 s;`);
    expect(crashLines(row.dataDir)[name]).toMatchObject({ sha: s, n: 1 });
    expect((await boot(row, [name], { NB6_THROW: 'late' })).code).toBe(1);
    expect(crashLines(row.dataDir)[name]).toMatchObject({ sha: s, n: 2 });
    const third = await boot(row, [name]);
    expect(third.code).toBe(0);
    const out = resultOf(third);
    expect(out.modules[name].entry).toMatchObject({ sha: s, heldSha: s });
    expect(out.loaded).not.toContain(name);
    expect(output(third)).toContain(`[Shared] The bot stopped twice while it was starting ${name} 1.0.0 on this machine (the error at the second stop: the module stopped the bot); this machine does not load ${name} until it is updated, or uninstalled and installed again`);
    expect(output(third)).toContain(`[ModuleLoader] ${name} 1.0.0 was not loaded: this machine holds it back after the bot stopped twice while it was starting it (see the App Store tab)`);
  }, 900_000);
});
