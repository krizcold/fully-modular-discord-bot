import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, runMigrate } from '../../src/cli/commands';
import { EXIT_ERR, EXIT_OK, EXIT_TIMEOUT, EXIT_USAGE } from '../../src/cli/output';

type Step = { status: number; body: unknown } | Error;
type Call = { method: string; path: string };

const JOB = 'job-s12-000001';
const STATUS_CMD = 'smdb api GET /api/data/migrate';

function answer(step: Step) {
  if (step instanceof Error) return Promise.reject(step);
  return Promise.resolve({ status: step.status, ok: step.status >= 200 && step.status < 300, body: step.body });
}

function panel(post: Step, gets: Step[], bot: Step = ok({ success: true, status: { running: false } })) {
  const calls: Call[] = [];
  let i = 0;
  const client = {
    calls,
    request: (method: string, p: string) => {
      calls.push({ method, path: p });
      if (method === 'POST' && p === '/api/data/migrate') return answer(post);
      if (method === 'GET' && p === '/api/bot/status') return answer(bot);
      if (method === 'GET' && p === '/api/data/migrate') return answer(gets[Math.min(i++, gets.length - 1)]);
      return answer({ status: 404, body: { success: false, error: 'no route' } });
    },
  };
  return client as typeof client & { request: any };
}
function ok(body: unknown): Step {
  return { status: 200, body };
}
const started = ok({ success: true, jobId: JOB, to: 'postgres', state: 'running' });
const doneFromPost = ok({ success: true, jobId: JOB, to: 'postgres', state: 'done' });
const job = (fields: Record<string, unknown>) => ok({ success: true, job: { jobId: JOB, to: 'postgres', ...fields } });
const doneJob = job({ state: 'done', stage: 'env' });
const runningJob = job({ state: 'running', stage: 'copy' });
const STOPPED = `migration ${JOB} is done; the bot is stopped: start it (smdb start)`;
const fast = { intervalMs: 1, timeoutMs: 5000 };
const migrateGets = (c: { calls: Call[] }) => c.calls.filter(x => x.method === 'GET' && x.path === '/api/data/migrate').length;

let out: string[];
let err: string[];
let exitCodeBefore: typeof process.exitCode;
beforeEach(() => {
  out = [];
  err = [];
  exitCodeBefore = process.exitCode;
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err.push(String(s)); return true; }) as any);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
});

describe('NB3-L5-S12-1: the wait verb', () => {
  it('runs with --get and --until, prints the matched body and exits 0', async () => {
    const body = { ready: true, n: 1 };
    const client = { request: vi.fn(async () => ({ status: 200, ok: true, body })) };
    await expect(dispatch(client as any, ['wait'], { get: '/api/x', until: 'data.ready === true' })).rejects.toThrow('exit 0');
    expect(client.request).toHaveBeenCalledWith('GET', '/api/x');
    expect(out.join('')).toBe(JSON.stringify(body, null, 2) + '\n');
    expect(err.join('')).toBe('');
  });

  it('exits 3 with the last body when the condition never holds in time', async () => {
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock++ === 0 ? 1_000_000 : 9_000_000));
    const client = { request: vi.fn(async () => ({ status: 200, ok: true, body: { ready: false } })) };
    await expect(dispatch(client as any, ['wait'], { get: '/api/x', until: 'data.ready', timeout: '1' })).rejects.toThrow('exit 3');
    expect(out.join('')).toBe(JSON.stringify({ ready: false }, null, 2) + '\n');
  });

  it('names both flags when one is missing and exits with the usage code', async () => {
    const client = { request: vi.fn() };
    await expect(dispatch(client as any, ['wait'], { get: '/api/x' })).rejects.toThrow(`exit ${EXIT_USAGE}`);
    expect(err.join('')).toBe('smdb: wait requires --get <path> and --until <expr>\n');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('polls at the --interval it is given', async () => {
    let n = 0;
    const client = { request: vi.fn(async () => ({ status: 200, ok: true, body: { n: ++n } })) };
    const t0 = performance.now();
    await expect(dispatch(client as any, ['wait'], { get: '/api/x', until: 'data.n >= 3', interval: '5' })).rejects.toThrow('exit 0');
    expect(performance.now() - t0).toBeLessThan(600);
    expect(client.request).toHaveBeenCalledTimes(3);
  });
});

describe('NB3-L5-S12-2: the next step reads only a 200 bot status', () => {
  it('a GET of /api/bot/status that says stopped tells the operator to start it', async () => {
    const c = panel(doneFromPost, [], ok({ success: true, status: { running: false } }));
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_OK, message: STOPPED });
    expect(c.calls).toContainEqual({ method: 'GET', path: '/api/bot/status' });
  });

  it('a 500 status with a readable body still cannot confirm whether the bot runs', async () => {
    for (const running of [false, true]) {
      const c = panel(doneFromPost, [], { status: 500, body: { success: false, status: { running } } });
      const result = await runMigrate(c, 'postgres', fast);
      expect(result).toMatchObject({
        code: EXIT_OK,
        message: `migration ${JOB} is done; can't confirm whether the bot runs: start the bot if it is stopped (smdb start)`,
      });
    }
  });
});

describe('NB3-L5-S12-3: the start request', () => {
  const cantStart = `can't confirm whether the migration started; check with: ${STATUS_CMD}`;

  it('a 500 without a success:false body cannot confirm the start', async () => {
    for (const body of [{}, { success: true }, null, 'Internal Server Error']) {
      const c = panel({ status: 500, body }, [doneJob]);
      const result = await runMigrate(c, 'postgres', fast);
      expect(result).toEqual({ code: EXIT_ERR, message: `${cantStart} (HTTP 500)`, body });
      expect(migrateGets(c)).toBe(0);
    }
  });

  it('a 500 with a success:false body is a refusal with its error', async () => {
    const c = panel({ status: 500, body: { success: false, error: 'disk full' } }, [doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_ERR, message: 'migration refused: disk full' });
  });

  it('a job id that is not a string is no job', async () => {
    const c = panel(ok({ success: true, jobId: 42, to: 'postgres', state: 'done' }), [doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_ERR, message: 'migration refused: HTTP 200' });
  });

  it('a refusal without a job id is not reported as a migration in the other direction', async () => {
    const c = panel({ status: 409, body: { success: false, to: 'file', error: 'busy' } }, [doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_ERR, message: 'migration refused: busy' });
  });

  it('an answer that names no direction is followed', async () => {
    const c = panel(ok({ success: true, jobId: JOB, state: 'done' }), []);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_OK, message: STOPPED });
  });

  it('a job in the other direction is not followed, with its error when there is one', async () => {
    const withError = await runMigrate(panel({ status: 409, body: { success: false, jobId: JOB, to: 'file', error: 'another migration runs' } }, [doneJob]), 'postgres', fast);
    expect(withError).toMatchObject({ code: EXIT_ERR, message: `migration ${JOB} (--to file) is not a migration to postgres; not following it: another migration runs` });
    const without = await runMigrate(panel({ status: 409, body: { success: false, jobId: JOB, to: 'file' } }, [doneJob]), 'postgres', fast);
    expect(without).toMatchObject({ code: EXIT_ERR, message: `migration ${JOB} (--to file) is not a migration to postgres; not following it` });
  });

  it('success false with a job id is a refusal, even when the answer says done', async () => {
    const c = panel({ status: 409, body: { success: false, jobId: JOB, to: 'postgres', state: 'done', error: 'locked' } }, [doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_ERR, message: 'migration refused: locked' });
  });

  it('a refusal without an error names the HTTP status', async () => {
    const c = panel({ status: 409, body: { success: false } }, [doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toEqual({ code: EXIT_ERR, message: 'migration refused: HTTP 409', body: { success: false } });
  });
});

describe('NB3-L5-S12-4: a start answer that already ended is not followed', () => {
  it('failed reports the stage and error without polling', async () => {
    const c = panel(ok({ success: true, jobId: JOB, to: 'postgres', state: 'failed', stage: 'copy', error: 'checksum mismatch' }), [doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result.code).toBe(EXIT_ERR);
    expect(result.message).toBe(`migration ${JOB} failed at copy: checksum mismatch`);
    expect(migrateGets(c)).toBe(0);
  });

  it('interrupted without a stage or error says an unknown stage and no error text', async () => {
    const c = panel(ok({ success: true, jobId: JOB, to: 'postgres', state: 'interrupted' }), [doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result.code).toBe(EXIT_ERR);
    expect(result.message).toBe(`migration ${JOB} interrupted at an unknown stage: `);
    expect(migrateGets(c)).toBe(0);
  });
});

describe('NB3-L5-S12-5: following a job by polling', () => {
  it('polls GET /api/data/migrate until the job is done', async () => {
    const c = panel(started, [runningJob, doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_OK, message: STOPPED });
    expect(migrateGets(c)).toBe(2);
  });

  it('a failed status request at the deadline is a timeout that says it cannot confirm', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const c = panel(started, [new Error('socket hang up'), doneJob]);
    const result = await runMigrate(c, 'postgres', { intervalMs: 1, timeoutMs: 0 });
    expect(result).toEqual({
      code: EXIT_TIMEOUT,
      message: `can't confirm the outcome of migration ${JOB}; the last status request failed (socket hang up); check with: ${STATUS_CMD}`,
    });
    expect(migrateGets(c)).toBe(1);
  });

  it('a 500 status at the deadline is a timeout, not a refusal', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const c = panel(started, [{ status: 500, body: { success: false, error: 'busy' } }, doneJob]);
    const result = await runMigrate(c, 'postgres', { intervalMs: 1, timeoutMs: 0 });
    expect(result).toMatchObject({
      code: EXIT_TIMEOUT,
      message: `can't confirm the outcome of migration ${JOB}; the last status request failed (HTTP 500); check with: ${STATUS_CMD}`,
    });
  });

  it('a 503 status at the deadline is a timeout', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const c = panel(started, [{ status: 503, body: 'down' }, doneJob]);
    const result = await runMigrate(c, 'postgres', { intervalMs: 1, timeoutMs: 0 });
    expect(result).toMatchObject({
      code: EXIT_TIMEOUT,
      message: `can't confirm the outcome of migration ${JOB}; the last status request failed (HTTP 503); check with: ${STATUS_CMD}`,
    });
    expect(migrateGets(c)).toBe(1);
  });

  it('a 500 before the deadline is retried', async () => {
    const c = panel(started, [{ status: 500, body: {} }, doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_OK, message: STOPPED });
  });

  it('a status that is not a success names its error, or the HTTP status', async () => {
    const named = await runMigrate(panel(started, [ok({ success: false, error: 'no such job' })]), 'postgres', fast);
    expect(named).toMatchObject({ code: EXIT_ERR, message: `can't confirm the outcome of migration ${JOB}: no such job` });
    const bare = await runMigrate(panel(started, [{ status: 404, body: { success: false } }]), 'postgres', fast);
    expect(bare).toMatchObject({ code: EXIT_ERR, message: `can't confirm the outcome of migration ${JOB}: HTTP 404` });
  });

  it('no job in the status at the deadline is a timeout that says so', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const c = panel(started, [ok({ success: true, job: null }), doneJob]);
    const result = await runMigrate(c, 'postgres', { intervalMs: 1, timeoutMs: 0 });
    expect(result).toEqual({
      code: EXIT_TIMEOUT,
      message: `can't confirm the outcome of migration ${JOB}; no status of it came back in time`,
      body: { success: true, job: null },
    });
  });

  it('a job in the other direction stops the follow', async () => {
    const c = panel(started, [job({ to: 'file', state: 'running' }), doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_ERR, message: `migration ${JOB} is a migration to file, not postgres` });
  });

  it('an interrupted job ends the follow with its stage and error', async () => {
    const c = panel(started, [job({ state: 'interrupted', stage: 'copy', error: 'restart' }), doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_ERR, message: `migration ${JOB} interrupted at copy: restart` });
    expect(migrateGets(c)).toBe(1);
  });

  it('a failed job without an error ends with no error text', async () => {
    const c = panel(started, [job({ state: 'failed', stage: 'verify' }), doneJob]);
    const result = await runMigrate(c, 'postgres', fast);
    expect(result).toMatchObject({ code: EXIT_ERR, message: `migration ${JOB} failed at verify: ` });
  });

  it('a job still running at the deadline is a timeout that says how to follow it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const c = panel(started, [runningJob, doneJob]);
    const result = await runMigrate(c, 'postgres', { intervalMs: 1, timeoutMs: 0 });
    expect(result).toMatchObject({
      code: EXIT_TIMEOUT,
      message: `migration ${JOB} still runs; follow it with: smdb api GET /api/data/migrate`,
    });
    expect(migrateGets(c)).toBe(1);
  });
});

describe('NB3-L5-S12-6: the data migrate verb', () => {
  it('refuses a direction other than postgres or file without a request', async () => {
    const c = panel(doneFromPost, [doneJob]);
    await expect(dispatch(c as any, ['data', 'migrate'], { to: 'mysql' })).rejects.toThrow(`exit ${EXIT_USAGE}`);
    expect(err.join('')).toBe('smdb: data migrate needs --to postgres or --to file\n');
    expect(c.calls).toEqual([]);
  });

  it('--to file runs, prints the answer and the message, and exits 0', async () => {
    const body = { success: true, jobId: JOB, to: 'file', state: 'done' };
    const c = panel(ok(body), []);
    await expect(dispatch(c as any, ['data', 'migrate'], { to: 'file' })).rejects.toThrow(`exit ${EXIT_OK}`);
    expect(c.calls[0]).toEqual({ method: 'POST', path: '/api/data/migrate' });
    expect(out.join('')).toBe(JSON.stringify(body, null, 2) + '\n');
    expect(err.join('')).toBe(`smdb: ${STOPPED}\n`);
  });

  it('a start that cannot be confirmed prints {} and exits 1', async () => {
    const c = panel(new Error('connect ECONNREFUSED'), []);
    await expect(dispatch(c as any, ['data', 'migrate'], { to: 'postgres' })).rejects.toThrow(`exit ${EXIT_ERR}`);
    expect(out.join('')).toBe('{}\n');
    expect(err.join('')).toBe(`smdb: can't confirm whether the migration started; check with: ${STATUS_CMD} (connect ECONNREFUSED)\n`);
  });

  it('without --timeout it follows a job for hours, polling every 2 seconds', async () => {
    vi.useFakeTimers();
    const c = panel(started, [runningJob, runningJob, runningJob, runningJob, runningJob, doneJob]);
    let settled: string | null = null;
    const run = dispatch(c as any, ['data', 'migrate'], { to: 'postgres' }).then(() => { settled = 'resolved'; }, (e: Error) => { settled = e.message; });
    for (let i = 0; i < 10 && settled === null; i++) await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(settled).toBe(`exit ${EXIT_OK}`);
    expect(migrateGets(c)).toBe(6);
    expect(err.join('')).toBe(`smdb: ${STOPPED}\n`);
  });
});

describe('NB3-L5-S12-7: hand-applied mutants of the start check fail these inputs', () => {
  const real = (status: number, body: any) => status >= 500 && !(body && typeof body === 'object' && body.success === false);
  const m3652 = (status: number, body: any) => status >= 500 && !((body || typeof body === 'object') && body.success === false);
  const m3656 = (status: number, body: any) => status >= 500 && !(body && typeof body === 'object' && true);
  it('a null or empty 500 body tells the real check from the mutants', () => {
    expect(real(500, null)).toBe(true);
    expect(() => m3652(500, null)).toThrow(TypeError);
    expect(real(500, {})).toBe(true);
    expect(m3656(500, {})).toBe(false);
  });
});
