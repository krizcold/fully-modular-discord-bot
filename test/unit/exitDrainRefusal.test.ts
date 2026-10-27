import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import session from 'express-session';
import { describe, expect, it } from 'vitest';
import {
  appendData,
  appendDataTracked,
  DataBackendUnavailableError,
  deleteData,
  deleteDataOutcome,
  deleteDataTracked,
  deleteRawAtomic,
  drainForExit,
  saveData,
  saveDataOutcome,
  saveDataTracked,
  writeRawAtomic,
} from '@internal/utils/dataManager';
import { dataUnavailableMessage } from '@internal/utils/dataBackends/boot';
import { openLedger, runInLedger } from '@internal/utils/dataBackends/writeLedger';
import { getConfigProperty } from '@internal/utils/configManager';
import { FileSessionStore } from '@webui/auth/fileSessionStore';

const refusedForExit = (error: unknown) => error instanceof DataBackendUnavailableError && error.causeKey === 'node-stopping';

// Its own file: the drain closes writes for good in this process.
describe('writes once the exit drain has closed', () => {
  it('refuse with node-stopping on every facade save, append and delete path', async () => {
    const guildId = '123456789012345678';
    await drainForExit(200);
    const guild = { guildId, category: 'm' };
    const global = { scope: 'global' as const, category: 'm' };
    const writes: Array<[string, () => unknown]> = [];
    for (const [where, options] of [['guild', guild], ['global', global]] as const) {
      writes.push(
        [`saveDataTracked ${where}`, () => saveDataTracked('a.json', options, { v: 1 })],
        [`saveDataOutcome ${where}`, () => saveDataOutcome('a.json', options, { v: 1 })],
        [`saveData ${where}`, () => saveData('a.json', options, { v: 1 })],
        [`appendDataTracked ${where}`, () => appendDataTracked('a.jsonl', options, 'x\n')],
        [`appendData ${where}`, () => appendData('a.jsonl', options, 'x\n')],
        [`deleteDataTracked ${where}`, () => deleteDataTracked('a.json', options)],
        [`deleteDataOutcome ${where}`, () => deleteDataOutcome('a.json', options)],
        [`deleteData ${where}`, () => deleteData('a.json', options)],
      );
    }
    for (const [name, write] of writes) {
      let thrown: unknown;
      try { write(); } catch (error) { thrown = error; }
      expect(thrown, name).toBeInstanceOf(DataBackendUnavailableError);
      expect((thrown as DataBackendUnavailableError).causeKey, name).toBe('node-stopping');
    }
  });

  it('tells the user the bot is restarting', () => {
    expect(dataUnavailableMessage('node-stopping')).toBe('The bot is restarting, so your change was not saved. Please try again in a moment.');
  });

  it('refuses the raw paths too, and records each refusal in an open ledger before the throw', async () => {
    await drainForExit(200);
    const raw = path.join(process.env.DATA_DIR!, '_bt2_after_drain', 'r.json');
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    fs.writeFileSync(raw, '{}');
    const writes: Array<[string, () => unknown]> = [
      ['writeRawAtomic', () => writeRawAtomic(raw, '{"v":1}')],
      ['deleteRawAtomic', () => deleteRawAtomic(raw)],
      ['saveData', () => saveData('a.json', { scope: 'global', category: 'm' }, { v: 1 })],
    ];
    for (const [name, write] of writes) {
      const ledger = openLedger('panel');
      let thrown: unknown;
      try { runInLedger(ledger, 'modA', write); } catch (error) { thrown = error; }
      expect(refusedForExit(thrown), name).toBe(true);
      expect(ledger.refusals(), name).toEqual([{ cause: 'node-stopping', modules: ['modA'] }]);
      expect(ledger.tickets(), name).toEqual([]);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.readFileSync(raw, 'utf8')).toBe('{}');
  });
});

describe('config reads once the exit drain has closed', () => {
  it('answer the defaults when config.json is missing, without creating it', async () => {
    await drainForExit(200);
    const configFile = path.join(process.env.DATA_DIR!, 'dist', 'bot', 'config.json');
    fs.rmSync(configFile, { force: true });
    // A read makes no write, so the ledger it runs in records no refusal either.
    const ledger = openLedger('interaction');
    process.env.DEVS = '333';
    try {
      expect(runInLedger(ledger, 'modA', () => getConfigProperty('DEVS'))).toEqual(['333']);
    } finally {
      delete process.env.DEVS;
    }
    expect(runInLedger(ledger, 'modA', () => getConfigProperty('DEVS'))).toEqual([]);
    expect(ledger.refusals()).toEqual([]);
    expect(ledger.tickets()).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.existsSync(configFile)).toBe(false);
  });
});

describe('the web UI session store once the exit drain has closed', () => {
  it('characterization: express-session delivers the response, then reports a refused store save to next(err)', async () => {
    await drainForExit(200);
    const dir = path.join(process.env.DATA_DIR!, '_bt2_express');
    fs.mkdirSync(dir, { recursive: true });
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000 });
    store.stop();
    const app = express();
    app.use(session({ store, secret: 'test-only-secret', resave: false, saveUninitialized: false }));
    app.get('/mark', (req, res) => {
      (req.session as unknown as { mark: number }).mark = 1;
      res.json({ ok: true });
    });
    let reported: unknown;
    const reachedNext = new Promise<void>(resolve => {
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        reported = error;
        resolve();
        if (!res.headersSent) res.status(500).end();
      });
    });
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/mark`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      await reachedNext;
      expect(refusedForExit(reported)).toBe(true);
      expect(fs.readdirSync(dir).filter(name => name.endsWith('.json'))).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('passes the refusal to every callback and reports no success; get still answers an expired session absent; the sweep stops quietly', async () => {
    await drainForExit(200);
    const dir = path.join(process.env.DATA_DIR!, '_bt2_sessions');
    fs.mkdirSync(dir, { recursive: true });
    const later = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const put = (sid: string, expiresAt: number) => fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ v: 1, sid, expiresAt, updatedAt: 0, session: { cookie: {} } }));
    put('live', later);
    put('expired', 1);
    put('other', later);
    // A corrupt file old enough for the sweep to delete.
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(corrupt, old, old);
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000 });
    store.stop();
    const answer = (call: (callback: (error?: unknown) => void) => void) => new Promise<unknown>(resolve => call(error => resolve(error ?? 'success')));
    const session = (expires: number) => ({ cookie: { expires: new Date(expires) } }) as never;

    expect(refusedForExit(await answer(callback => store.set('fresh', session(later), callback)))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fresh.json'))).toBe(false);
    expect(refusedForExit(await answer(callback => store.destroy('live', callback)))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'live.json'))).toBe(true);
    // A refused destroy did not destroy it, so a later save is refused too, never skipped as already destroyed.
    expect(refusedForExit(await answer(callback => store.set('live', session(later), callback)))).toBe(true);
    expect(refusedForExit(await answer(callback => store.touch('other', session(later + 2 * 60 * 60 * 1000), callback)))).toBe(true);
    expect(refusedForExit(await answer(callback => store.clear(callback)))).toBe(true);
    const got = await new Promise(resolve => store.get('expired', (error, found) => resolve([error, found])));
    expect(got).toEqual([null, null]);
    expect(() => (store as unknown as { sweep(): void }).sweep()).not.toThrow();
    for (const sid of ['live', 'expired', 'other', 'corrupt']) expect(fs.existsSync(path.join(dir, `${sid}.json`)), sid).toBe(true);
  });
});
