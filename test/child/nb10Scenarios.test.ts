import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { childEnv, FORK_GUARD, botRoot, freshDataDir, runScenario } from '../helpers/child';

// NB10 child scenarios with real processes: 16 (two writers), 17 (a lock holder killed or exiting mid-rename),
// 22 (a stop early in the boot, normal and maintenance) and 43 (a deposed exit seen by BotManager). Each runs on the
// compiled dist; the bot process is dist/bot/index.js with a stand-in clientInitializer (scenarios/nb10Child.cjs).

const SCENARIOS = path.join(botRoot, 'test', 'child', 'scenarios');
const target = (dataDir: string) => path.join(dataDir, 'global', 'nb10kill', 'x.json');

function startHolder(dataDir: string, role: 'hold' | 'exit', body: string): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(process.execPath, ['--require', FORK_GUARD, path.join(SCENARIOS, 'nb10LockHolder.cjs'), role, body], { cwd: dataDir, env: childEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
  const word = role === 'hold' ? 'HELD' : 'EXITING';
  const ready = new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', chunk => { out += chunk; if (out.includes(word)) resolve(); });
    child.on('exit', code => { if (!out.includes(word)) reject(new Error(`the holder exited ${code} before ${word}`)); });
  });
  return { child, ready };
}

const exited = (child: ChildProcess) => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.on('exit', () => resolve()); });

describe('NB10 test 16: two writers', () => {
  it('the two sides interleave; every accepted increment from the bot and the operator is in the final count, and every refusal answered changed', async () => {
    const run = await runScenario<{ final: number; log: string; parentAccepted: number; childAccepted: number; refusals: Record<string, number> }>('nb10Parent.cjs', ['two-writers'], freshDataDir());
    const { final, log, parentAccepted, childAccepted, refusals } = run.result;
    expect(childAccepted).toBe(200);
    expect(parentAccepted).toBeGreaterThan(0);
    expect(final).toBe(parentAccepted + childAccepted);
    expect(log).toHaveLength(final);
    expect(log.split('').filter(c => c === 'p')).toHaveLength(parentAccepted);
    expect(log).toMatch(/c+p+c/);
    expect(Object.keys(refusals).filter(code => code !== 'changed')).toEqual([]);
  });
});

describe('NB10 test 17: a lock holder that dies', () => {
  it('killed with SIGKILL: the waiting writer takes the lock within 1 s, and no write of the dead holder lands after it', async () => {
    const dataDir = freshDataDir();
    const a = startHolder(dataDir, 'hold', '{"by":"A"}');
    await a.ready;
    const b = runScenario<{ tookAt: number }>('nb10LockHolder.cjs', ['take', '{"by":"B"}'], dataDir);
    await new Promise(resolve => setTimeout(resolve, 300));
    const killedAt = Date.now();
    a.child.kill('SIGKILL');
    await exited(a.child);
    const { result } = await b;
    expect(result.tookAt - killedAt).toBeLessThan(1_000);
    expect(fs.readFileSync(target(dataDir), 'utf8')).toBe('{"by":"B"}');
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(fs.readFileSync(target(dataDir), 'utf8')).toBe('{"by":"B"}');
  });

  it('exiting by process.exit while its rename is on the wire: the lock stays until it is gone, and the next writer\'s write is the last', async () => {
    const dataDir = freshDataDir();
    const a = startHolder(dataDir, 'exit', '{"by":"A"}');
    await a.ready;
    await exited(a.child);
    const lock = path.join(dataDir, '.writer.lock');
    expect(fs.existsSync(lock)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(a.child.pid);
    await runScenario('nb10LockHolder.cjs', ['take', '{"by":"B"}'], dataDir);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(fs.readFileSync(target(dataDir), 'utf8')).toBe('{"by":"B"}');
  });
});

describe('NB10 test 22: a stop early in the boot', () => {
  it('a global.write accepted at shared, with its flush slowed, lands before the exit, and the exit code is 0', async () => {
    const run = await runScenario<{ reply: any; exitCode: number | null; onDisk: string | null }>('nb10Parent.cjs', ['stop-early'], freshDataDir());
    expect(run.result.exitCode).toBe(0);
    expect(run.result.onDisk).toBe('{"landed":true}');
  });

  it('in a maintenance boot whose shard count keeps failing: global.write is refused, a premium change lands before the exit, and the exit code is 0', async () => {
    const run = await runScenario<any>('nb10Parent.cjs', ['maintenance'], freshDataDir());
    const r = run.result;
    expect(r.retrying).toBe(true);
    expect(r.refused).toMatchObject({ ok: false, code: 'maintenance', error: 'nb10 maintenance' });
    expect(r.globalWritten).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.premium?.messages?.moduleBlocked).toBe('nb10 maintenance stop');
  });
});

describe('NB10 test 43: a deposed exit seen by BotManager', () => {
  const noCrash = (r: any) => {
    expect(r.exitCode).toBe(75);
    expect(r.crashed).toBe(false);
    expect(r.crashLogs).toBe(0);
    expect(r.crashRestartsAfter).toBe(r.crashRestartsBefore);
    expect(r.crashCountAfter).toBe(r.crashCountBefore);
  };
  const count = (text: string, part: string) => text.split(part).length - 1;

  it('deposed by its own check while a large metrics:snapshot is on the channel: exit 75, no crash, the holder named', async () => {
    const run = await runScenario<any>('nb10Parent.cjs', ['deposed', 'snapshot'], freshDataDir());
    const r = run.result;
    noCrash(r);
    expect(r.deposedLines).toEqual([`[BotManager] The bot process stopped: a data bundle import (pid ${r.parentPid}) took the data files' lock`]);
    expect(r.lockAfter).toBe(r.lockWritten);
  });

  const realDeposed = (r: any) => {
    noCrash(r);
    const log: string = r.childLog;
    expect(r.exitAfterMs).toBeGreaterThanOrEqual(3000);
    expect(count(log, '[nb10Child] gateway close step started')).toBe(1);
    expect(count(log, '[nb10Child] gateway close step ended')).toBe(1);
    expect(log.indexOf('gateway close step ended')).toBeGreaterThan(log.indexOf("took the data files' lock; this process writes no data file from now on"));
    expect(log.indexOf('gateway close step ended')).toBeLessThan(r.childLogAtExit);
    expect(count(log, `Another process (a data bundle import, pid ${r.parentPid}) took the data files' lock`)).toBe(1);
    expect(count(log, 'Not saved:')).toBeGreaterThanOrEqual(1);
    expect(log.split('\n').filter(l => l.includes('Not saved:') && l.includes('nb10dep'))).toHaveLength(1);
    expect(log.split('\n').filter(l => l.includes('subscription.expired event from discord (subscription d1, guild g1)') && l.includes('lost: another process took the data files'))).toHaveLength(1);
    expect(log.split('\n').filter(l => l.includes('subscription.created event from discord (subscription ent9, guild g9)') && l.includes('was not applied: another process took the data files; it is lost'))).toHaveLength(1);
    expect(log).not.toContain('lost with this stop');
    expect(log).not.toContain('the bot is stopping');
    expect(r.deposedLines).toEqual([`[BotManager] The bot process stopped: a data bundle import (pid ${r.parentPid}) took the data files' lock`]);
    expect(r.lockAfter).toBe(r.lockWritten);
  };

  it("deposed by its 5 s check with a held write, a journaled event and a held gateway close: each loss is logged once, and it exits 75 after its stop steps", async () => {
    const run = await runScenario<any>('nb10Parent.cjs', ['deposed', 'real'], freshDataDir(), 50_000);
    realDeposed(run.result);
  }, 60_000);

  it('a SIGTERM sent while the deposed bot runs its held gateway close changes nothing: one stop sequence, exit 75 after the drain', async () => {
    const run = await runScenario<any>('nb10Parent.cjs', ['deposed', 'real-sigterm'], freshDataDir(), 50_000);
    expect(run.result.sigtermSent).toBe(true);
    realDeposed(run.result);
  }, 60_000);

  it('a child that exits 75 with no message is no crash, and the holder is read from the lock file', async () => {
    const run = await runScenario<any>('nb10Parent.cjs', ['deposed', 'no-message'], freshDataDir());
    noCrash(run.result);
    expect(run.result.deposedLines).toEqual(["[BotManager] The bot process stopped: a data bundle import (pid 31) took the data files' lock"]);
  });

  it('a child that sends deposed and then exits 1 is a crash', async () => {
    const run = await runScenario<any>('nb10Parent.cjs', ['deposed', 'exit-1'], freshDataDir());
    expect(run.result.exitCode).toBe(1);
    expect(run.result.crashed).toBe(true);
    expect(run.result.crashCountAfter).toBe(run.result.crashCountBefore + 1);
  });
});
