import { afterEach, describe, expect, it, vi } from 'vitest';

// NB15 test 15 (decision 19): `cmd invoke --repeat` counts ok, failed only for an answer that proves the outcome, and
// unconfirmed for the rest; `panels list --guild` sends the guild. The oracle's panel rule is the same (ruling 10).
import { classifyInvokeAnswer, dispatch } from '../../src/cli/commands';
import { EXIT_ERR, EXIT_OK } from '../../src/cli/output';
import { classifyAnswer } from '../oracle/oracle.mjs';

class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

type Step = { status: number; body: unknown } | Error;

async function run(positionals: string[], flags: Record<string, string | boolean>, steps: Step[]) {
  const paths: string[] = [];
  let out = '';
  const client: any = {
    request: async (_method: string, path: string) => {
      paths.push(path);
      const step = steps.shift()!;
      if (step instanceof Error) throw step;
      return { ...step, ok: step.status >= 200 && step.status < 300 };
    },
  };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as any);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => { out += String(s); return true; }) as any);
  let code: number | undefined | 'none' = 'none';
  try {
    await dispatch(client, positionals, flags);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    exitSpy.mockRestore();
    outSpy.mockRestore();
  }
  return { code, out, paths };
}

afterEach(() => vi.restoreAllMocks());

describe('cmd invoke --repeat', () => {
  it('9 answers: ok 2, failed 3, unconfirmed 4, and an error exit', async () => {
    const steps: Step[] = [
      { status: 200, body: { success: true } },
      { status: 400, body: { success: false, ran: false, error: 'no such command: x' } },
      { status: 503, body: { success: false, code: 'no-answer', error: "can't confirm" } },
      { status: 200, body: { success: true } },
      { status: 503, body: { success: false, noAnswer: 'timeout', error: "can't confirm" } },
      new Error('the answer was cut off'),
      { status: 500, body: { success: false, ran: true, truth: 'pending', pending: true } },
      { status: 500, body: { success: false, ran: true, truth: 'deposed' } },
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED' }),
    ];
    const { code, out } = await run(['cmd', 'invoke', 'probe'], { repeat: '9', guild: '4194304' }, steps);
    expect(JSON.parse(out)).toEqual({ command: 'probe', repeated: 9, ok: 2, failed: 3, unconfirmed: 4 });
    expect(code).toBe(EXIT_ERR);
  });

  it('all ok exits 0', async () => {
    const { code, out } = await run(['cmd', 'invoke', 'probe'], { repeat: '3' }, [0, 1, 2].map(() => ({ status: 200, body: { success: true } })));
    expect(JSON.parse(out)).toMatchObject({ ok: 3, failed: 0, unconfirmed: 0 });
    expect(code).toBe(EXIT_OK);
  });

  it('a code that proves nothing ran is failed; an answer it cannot place is unconfirmed', () => {
    expect(classifyInvokeAnswer(503, { success: false, code: 'not-taken' })).toBe('failed');
    expect(classifyInvokeAnswer(500, { success: false, error: 'On BRAVO: something' })).toBe('unconfirmed');
    expect(classifyInvokeAnswer(500, { success: false, ran: true, truth: 'unavailable' })).toBe('unconfirmed');
  });
});

describe('panels list --guild', () => {
  it('sends guildId', async () => {
    const { paths } = await run(['panels', 'list'], { guild: '4194304' }, [{ status: 200, body: { success: true, panels: [] } }]);
    expect(paths).toEqual(['/api/panels/list?guildId=4194304']);
  });
});

describe("the oracle's classification by route (ruling 10, test 12's unit row)", () => {
  it('reads code and ran on the panel and invoke routes, the substring list on the data routes', () => {
    expect(classifyAnswer(503, { success: false, code: 'not-taken', error: 'Data file not found in the module' }, 'panel')).toEqual({ cls: 'REFUSED', definite: true });
    expect(classifyAnswer(500, { success: false, ran: true, error: 'boom' }, 'panel')).toEqual({ cls: 'REFUSED', definite: false });
    expect(classifyAnswer(503, { success: false, code: 'no-answer' }, 'panel')).toEqual({ cls: 'UNKNOWN', definite: false });
    expect(classifyAnswer(500, { success: false, servedBy: 'B', error: 'On B: Data file not found: settings.json' }, 'panel')).toEqual({ cls: 'REFUSED', definite: false });
    expect(classifyAnswer(500, { success: false, servedBy: 'B', error: 'On B: Data file not found: settings.json' })).toEqual({ cls: 'REFUSED', definite: true });
  });
});
