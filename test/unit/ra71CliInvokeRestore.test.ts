import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyInvokeAnswer, dispatch } from '../../src/cli/commands';
import { EXIT_ERR } from '../../src/cli/output';

class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

type Step = { status: number; body: unknown } | Error;

async function run(positionals: string[], flags: Record<string, string | boolean>, steps: Step[]) {
  let out = '';
  let err = '';
  const client: any = {
    request: async () => {
      const step = steps.shift();
      if (!step) throw new Error('no more steps');
      if (step instanceof Error) throw step;
      return { ...step, ok: step.status >= 200 && step.status < 300 };
    },
  };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as any);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => { out += String(s); return true; }) as any);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: any) => { err += String(s); return true; }) as any);
  let code: number | undefined | 'none' = 'none';
  try {
    await dispatch(client, positionals, flags);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    exitSpy.mockRestore();
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, out, err };
}

afterEach(() => vi.restoreAllMocks());

describe('cmd invoke --repeat exit code', () => {
  it('only failed answers exit with an error', async () => {
    const steps: Step[] = [0, 1].map(() => ({ status: 400, body: { success: false, ran: false } }));
    const { code, out } = await run(['cmd', 'invoke', 'probe'], { repeat: '2' }, steps);
    expect(JSON.parse(out)).toMatchObject({ ok: 0, failed: 2, unconfirmed: 0 });
    expect(code).toBe(EXIT_ERR);
  });

  it('only unconfirmed answers exit with an error', async () => {
    const steps: Step[] = [0, 1].map(() => ({ status: 503, body: { success: false, code: 'no-answer' } }));
    const { code, out } = await run(['cmd', 'invoke', 'probe'], { repeat: '2' }, steps);
    expect(JSON.parse(out)).toMatchObject({ ok: 0, failed: 0, unconfirmed: 2 });
    expect(code).toBe(EXIT_ERR);
  });
});

describe('classifyInvokeAnswer', () => {
  it.each(['no-holder', 'backend-unavailable', 'invalid', 'not-allowed', 'member-panel-off', 'not-ready', 'insecure-transport', 'not-held'])(
    'a 500 with code %s is failed',
    (codeName) => {
      expect(classifyInvokeAnswer(500, { success: false, code: codeName })).toBe('failed');
    },
  );

  it.each(['pending', 'held'])('a ran answer with truth %s is unconfirmed', (truth) => {
    expect(classifyInvokeAnswer(500, { success: false, ran: true, truth })).toBe('unconfirmed');
  });

  it('a status outside 2xx without success false is not ok', () => {
    expect(classifyInvokeAnswer(500, {})).toBe('unconfirmed');
    expect(classifyInvokeAnswer(199, {})).toBe('unconfirmed');
    expect(classifyInvokeAnswer(300, null)).toBe('unconfirmed');
    expect(classifyInvokeAnswer(200, {})).toBe('ok');
    expect(classifyInvokeAnswer(299, { success: true })).toBe('ok');
  });
});

describe('graveyard restore', () => {
  it('a failed list without an error text names its HTTP status and restores nothing', async () => {
    const { code, err } = await run(['graveyard', 'restore', '4194304'], {}, [{ status: 500, body: null }]);
    expect(code).toBe(EXIT_ERR);
    expect(err).toContain('the graveyard list could not be read (HTTP 500); nothing was restored');
  });

  it('the no-answer text of a replace names the newest entry of this server', async () => {
    const list = {
      status: 200,
      body: {
        success: true,
        entries: [
          { guildId: '4194304', retiredAt: 5 },
          { guildId: '4194304', retiredAt: 9 },
          { guildId: '4194304', retiredAt: 7 },
          { guildId: '8388608', retiredAt: 20 },
        ],
      },
    };
    const { code, err } = await run(['graveyard', 'restore', '4194304'], { replace: true }, [list, new Error('socket hang up')]);
    expect(code).toBe(EXIT_ERR);
    expect(err).toContain("can't confirm whether server 4194304 was restored");
    expect(err).toContain('newer than 9 whose reason is replaced-by-restore-9 or empty');
  });
});
