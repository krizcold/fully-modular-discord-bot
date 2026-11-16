import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB35 review finding 1: a Postgres boot whose data layer refused the database never runs bootShared (runBot skips it,
// nb35RefusedBoot.test.ts), so the child's handler for shared:op and data:global-read must answer with the refusal and
// its reason, not with "the bot is starting and is bringing the shared files up to date", for as long as the process
// runs. The op and the read are not run, no SQL reaches the database and the shared file on disk is left as it is. A
// JSON bot whose DATA_BACKEND or marker was refused answers the same way, and the web UI answers code refused with 503.

const ctl = vi.hoisted(() => ({ refusal: null as string | null, mode: 'postgres' as 'postgres' | 'file', reads: 0 }));
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  checkWriterLock: () => ({ kind: 'not-held' }),
}));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', async orig => ({
  ...(await orig<any>()),
  applyOperatorGlobalRead: () => {
    ctl.reads += 1;
    return { ok: true, read: 'fine' };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceIpcRefusal: () => null,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', async orig => ({
  ...(await orig<any>()),
  isMaintenanceBoot: () => false,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getDataBootStatus: () => (ctl.refusal === null
      ? real.getDataBootStatus()
      : { mode: ctl.mode, state: 'refused', refusalReason: ctl.refusal, waitReason: null }),
  };
});

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setupSharedOpsIPC, sharedRefusedText } from '../../src/bot/internalSetup/utils/sharedOps';
import { hopFailure, sharedOpFailure } from '../../src/webui/routes/hopFailure';
import { resetDataBackendCache, resolveDataBackend } from '../../src/utils/envLoader';
import { setBackendKind } from '../helpers/backendKind';
import { mirrorRig } from '../helpers/nb6Mirror';

type Listener = (message: unknown) => Promise<void>;

const m = mirrorRig('nb35refused');
const REASON = "this machine's /data/.backend.json records store store-a, but the configured database smdb holds no store (it has no smdb_data schema), so this bot made no store there";
const REFUSED_OP = `The data layer refused this database (${REASON}), so the bot does not read or change the shared files; nothing was saved. The bot's log says how to fix it; restart the bot once it is fixed.`;
const REFUSED_READ = `The data layer refused this database (${REASON}), so the bot does not read or change the shared files. The bot's log says how to fix it; restart the bot once it is fixed.`;
const FILE_TEXT = '{"kept":true}';

let listener: Listener;
let n = 0;

const realOn = process.on.bind(process);
let captured: Listener | null = null;

beforeEach(async () => {
  await m.setup();
  ctl.refusal = null;
  ctl.mode = 'postgres';
  ctl.reads = 0;
  fs.mkdirSync(path.dirname(m.file('a.json')), { recursive: true });
  fs.writeFileSync(m.file('a.json'), FILE_TEXT);
  if (!captured) {
    const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
      if (event === 'message') {
        captured = fn;
        return process;
      }
      return realOn(event as any, fn);
    }) as any);
    const original = process.send;
    if (!original) (process as any).send = () => true;
    setupSharedOpsIPC();
    (process as any).send = original;
    spy.mockRestore();
  }
  expect(captured).not.toBeNull();
  listener = captured!;
});

afterEach(() => m.teardown());

async function ask(type: 'shared:op' | 'data:global-read', data: unknown): Promise<any> {
  const requestId = `nb35refused-${++n}`;
  const sent: Array<{ requestId: string; data: any }> = [];
  const original = process.send;
  (process as any).send = (msg: any) => {
    if (msg?.requestId === requestId) sent.push(msg);
    return true;
  };
  try {
    await listener({ type, requestId, data });
  } finally {
    (process as any).send = original;
  }
  expect(sent).toHaveLength(1);
  return sent[0].data;
}

const op = { op: 'premium.setGlobalModuleConfig', args: { args: ['nb35', { a: 1 }] } };
const read = { rel: 'nb35refused/a.json' };

describe('NB35: a Postgres bot whose data layer refused the database (bootShared never ran)', () => {
  it('shared:op answers the refusal with its reason, runs nothing and sends no SQL', async () => {
    ctl.refusal = REASON;
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'refused', status: 503, error: REFUSED_OP });
    expect(m.state.pg.sent).toEqual([]);
    expect(fs.readFileSync(m.file('a.json'), 'utf8')).toBe(FILE_TEXT);
  });

  it('data:global-read answers the refusal with its reason and reads nothing', async () => {
    ctl.refusal = REASON;
    expect(await ask('data:global-read', read)).toEqual({ ok: false, code: 'refused', status: 503, error: REFUSED_READ });
    expect(ctl.reads).toBe(0);
    expect(m.state.pg.sent).toEqual([]);
  });

  it('the answer stays the refusal on every later request', async () => {
    ctl.refusal = REASON;
    for (let i = 0; i < 3; i += 1) {
      expect((await ask('shared:op', op)).error).toBe(REFUSED_OP);
      expect((await ask('data:global-read', read)).error).toBe(REFUSED_READ);
    }
  });
});

describe('guards', () => {
  it('a Postgres bot whose data layer is not refused still answers the starting text before bootShared ends', async () => {
    expect(await ask('shared:op', op)).toEqual({
      ok: false,
      code: 'starting',
      error: 'The bot is starting and is bringing the shared files up to date from the database; nothing was saved. Try again in a moment.',
    });
  });

  it('a JSON bot whose data layer is not refused is not gated', async () => {
    dm.setGuildDataBackend(null);
    setBackendKind('file');
    expect(await ask('data:global-read', read)).toEqual({ ok: true, read: 'fine' });
  });
});

describe('NB35: a JSON bot whose data layer refused to serve', () => {
  const MARKER = "the live data backend is postgres (per /data/.backend.json) but DATA_BACKEND is file";
  const savedBackend = process.env.DATA_BACKEND;
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.DATA_BACKEND;
    else process.env.DATA_BACKEND = savedBackend;
    resetDataBackendCache();
  });

  it('DATA_BACKEND=file refused by the marker: the op and the read answer the refusal and run nothing', async () => {
    dm.setGuildDataBackend(null);
    setBackendKind('file');
    ctl.mode = 'file';
    ctl.refusal = MARKER;
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'refused', status: 503, error: sharedRefusedText('shared:op', MARKER) });
    expect(await ask('data:global-read', read)).toEqual({ ok: false, code: 'refused', status: 503, error: sharedRefusedText('data:global-read', MARKER) });
    expect(ctl.reads).toBe(0);
    expect(fs.readFileSync(m.file('a.json'), 'utf8')).toBe(FILE_TEXT);
  });

  it('an invalid DATA_BACKEND: the refusal text, not the EnvLoader error resolveDataBackend throws', async () => {
    dm.setGuildDataBackend(null);
    setBackendKind(null);
    process.env.DATA_BACKEND = 'sqlite';
    resetDataBackendCache();
    expect(() => resolveDataBackend()).toThrow('Invalid DATA_BACKEND value "sqlite"');
    const invalid = '[EnvLoader] Invalid DATA_BACKEND value "sqlite" (expected "file" or "postgres")';
    ctl.mode = 'file';
    ctl.refusal = invalid;
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'refused', status: 503, error: sharedRefusedText('shared:op', invalid) });
    expect(await ask('data:global-read', read)).toEqual({ ok: false, code: 'refused', status: 503, error: sharedRefusedText('data:global-read', invalid) });
    expect(ctl.reads).toBe(0);
    expect(fs.readFileSync(m.file('a.json'), 'utf8')).toBe(FILE_TEXT);
  });
});

describe('NB35: the web UI side of a refused answer', () => {
  it('sharedOpFailure and hopFailure answer code refused with 503 and the refusal text', async () => {
    ctl.refusal = REASON;
    const reply = await ask('shared:op', op);
    expect(sharedOpFailure(reply)).toEqual({ status: 503, error: REFUSED_OP });
    expect(sharedOpFailure({ ok: false, code: 'refused', error: REFUSED_OP })).toEqual({ status: 503, error: REFUSED_OP });
    expect(hopFailure('refused', REFUSED_READ)).toEqual({ status: 503, error: REFUSED_READ });
  });
});
