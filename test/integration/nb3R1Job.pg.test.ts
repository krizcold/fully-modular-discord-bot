import fs from 'fs';
import net from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { insertDoc, listStore, otherSession, provisionedStore, realService, resetDatabase, schemas, sessionsGone, startRig, stopRig, jsonBot, type PgRig } from '../helpers/pgMigrationRig';
import { ENV, FakeHost, JOURNAL, MARKER, readJson, seedFile, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

// NB3 code review round 1 against a real Postgres: DL-1 (a session count in a transaction sees sessions that connected
// after its first count) and RS-1 (a COMMIT or ROLLBACK with no answer is bounded and releases the lock).

/** A TCP hop in front of the container that can drop the traffic of every connection. */
class Hop {
  private readonly sockets = new Set<net.Socket>();
  private stalled = false;
  private muted = false;
  private readonly server = net.createServer(client => this.accept(client));

  constructor(private readonly target: { host: string; port: number }) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  stall(): void {
    this.stalled = true;
  }

  /** Drops only the server's answers: what the client sends still reaches the server. */
  mute(): void {
    this.muted = true;
  }

  restore(): void {
    this.stalled = false;
    this.muted = false;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise(resolve => { this.server.close(() => resolve()); });
  }

  private accept(client: net.Socket): void {
    const upstream = net.connect(this.target.port, this.target.host);
    for (const [from, to] of [[client, upstream], [upstream, client]] as const) {
      this.sockets.add(from);
      const answers = from === upstream;
      from.on('data', chunk => { if (!this.stalled && !(answers && this.muted)) to.write(chunk); });
      from.on('close', () => {
        this.sockets.delete(from);
        to.destroy();
      });
      from.on('error', () => { /* the close that follows ends the other side */ });
    }
  }
}

let rig: PgRig;
let hop: Hop;
let hopUrl: string;
const G = '181818181818181818';

beforeAll(async () => {
  rig = await startRig();
  const target = new URL(rig.url);
  hop = new Hop({ host: target.hostname, port: Number(target.port) });
  const port = await hop.listen();
  target.hostname = '127.0.0.1';
  target.port = String(port);
  hopUrl = target.toString();
}, 180_000);
afterAll(async () => {
  await hop?.close();
  await stopRig(rig);
});
beforeEach(async () => {
  hop.restore();
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('NB3-DL-1: the session recheck inside a transaction', () => {
  it('to JSON: a session that connects after the read transaction\'s first count is refused at S8, named', async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{"a":1}');
    let late: Client | null = null;
    const service = realService(new FakeHost(), { fault: async p => { if (p === 'S5') late = await otherSession(rig, 'late-bot'); } });
    try {
      await service.post({ jobId: 'job-r1pg-dl1-1', to: 'file' });
      await service.idle();
    } finally { await (late as Client | null)?.end(); }
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(job.error).toMatch(/1 other session\(s\) .*\(late-bot: 1\)/);
    expect(readJson(MARKER).live).toBe('postgres');
    expect(await schemas(rig)).toEqual(['smdb_data']);
  });

  it('to Postgres over a served store: a session that connects after the copy transaction\'s first count is refused before committing', async () => {
    const storeId = await provisionedStore(rig);
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    listStore(storeId);
    seedFile(`${G}/m/a.json`, '{"a":1}');
    let late: Client | null = null;
    const service = realService(new FakeHost(), { fault: async p => { if (p === 'S6') late = await otherSession(rig); } });
    try {
      await service.post({ jobId: 'job-r1pg-dl1-2', to: 'postgres' });
      await service.idle();
    } finally { await (late as Client | null)?.end(); }
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toMatch(/1 other session\(s\) .*\(unnamed: 1\)/);
    expect(await schemas(rig)).toEqual(['smdb_data']);
    const { rows } = await rig.admin.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`);
    expect(JSON.parse(rows[0].value)).toBe(storeId);
    expect(readJson(MARKER).live).toBe('file');
  });
});

describe('NB3-RS-1: a silent database', () => {
  it('a COMMIT with no answer ends interrupted at committing within the bound and releases the lock; a POST then finishes', async () => {
    useDatabaseUrl(hopUrl);
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    const host = new FakeHost();
    const service = realService(host, { commitBoundMs: 2000, closeBoundMs: 1000, fault: p => { if (p === 'commit-send') hop.stall(); } });
    const started = Date.now();
    await service.post({ jobId: 'job-r1pg-rs1-1', to: 'postgres' });
    await service.idle();
    expect(Date.now() - started).toBeLessThan(20_000);
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL).error).toMatch(/^The COMMIT got no answer/);
    expect(host.lock).toBeNull();
    await sessionsGone(rig);
    expect(await schemas(rig)).toEqual([]);
    hop.restore();
    const again = realService(host);
    const answer = await again.post({ jobId: 'job-r1pg-rs1-2', to: 'postgres' });
    expect(answer.body, why(answer.body)).toMatchObject({ jobId: 'job-r1pg-rs1-2', state: 'started' });
    await again.idle();
    expect(again.status().body.job, why(again.status().body.job)).toMatchObject({ jobId: 'job-r1pg-rs1-2', state: 'done' });
    const { rows } = await rig.admin.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1`, [G]);
    expect(rows.map(r => r.doc)).toEqual(['{"a":1}']);
  }, 90_000);

  it('a ROLLBACK with no answer destroys the socket after the bound, so the job ends and the lock is released', async () => {
    useDatabaseUrl(hopUrl);
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    const host = new FakeHost();
    const service = realService(host, {
      closeBoundMs: 1000,
      fault: p => {
        if (p !== 'S6') return;
        hop.stall();
        throw new Error('injected failure');
      },
    });
    const started = Date.now();
    await service.post({ jobId: 'job-r1pg-rs1-3', to: 'postgres' });
    await service.idle();
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(host.lock).toBeNull();
    await sessionsGone(rig);
    expect(await schemas(rig)).toEqual([]);
  });
});

describe('T9: between the committing write and the COMMIT, and a COMMIT whose answer is lost', () => {
  const storeIdOf = async (schema: string) => JSON.parse((await rig.admin.query(`SELECT value FROM "${schema}".meta WHERE key = 'store_id'`)).rows[0].value);
  const die = () => Object.assign(new Error('the process died'), { simulateDeath: true });

  it('to Postgres: a death after the committing write leaves no smdb_data; a POST with a new jobId starts over and ends done', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    const first = realService(new FakeHost(), { fault: p => { if (p === 'commit-send') throw die(); } });
    await first.post({ jobId: 'job-r1pg-t9-01', to: 'postgres' });
    await first.idle();
    expect(first.status().body.job, why(first.status().body.job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-r1pg-t9-01', stage: 'committing' });
    await sessionsGone(rig);
    expect(await schemas(rig)).toEqual([]);
    const again = realService(new FakeHost());
    const answer = await again.post({ jobId: 'job-r1pg-t9-02', to: 'postgres' });
    expect(answer.body, why(answer.body)).toMatchObject({ jobId: 'job-r1pg-t9-02', state: 'started' });
    await again.idle();
    expect(again.status().body.job, why(again.status().body.job)).toMatchObject({ jobId: 'job-r1pg-t9-02', state: 'done' });
    expect(await schemas(rig)).toEqual(['smdb_data']);
  }, 90_000);

  it('S8: the COMMIT lands but its answer is lost; the job ends interrupted at committing and a POST finds case 3, the copy renamed aside', async () => {
    useDatabaseUrl(hopUrl);
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    const first = realService(new FakeHost(), { commitBoundMs: 2000, closeBoundMs: 1000, fault: p => { if (p === 'commit-send') hop.mute(); } });
    await first.post({ jobId: 'job-r1pg-t9-03', to: 'postgres' });
    await first.idle();
    expect(first.status().body.job, why(first.status().body.job)).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL)).toMatchObject({ stage: 'committing', result: 'interrupted' });
    const copyId = readJson(JOURNAL).storeId as string;
    hop.restore();
    await sessionsGone(rig);
    expect(await schemas(rig)).toEqual(['smdb_data']);
    expect(await storeIdOf('smdb_data')).toBe(copyId);
    expect(readJson(MARKER).live).toBe('file');
    const again = realService(new FakeHost());
    const answer = await again.post({ jobId: 'job-r1pg-t9-04', to: 'postgres' });
    expect(answer.body, why(answer.body)).toMatchObject({ jobId: 'job-r1pg-t9-04', state: 'started' });
    await again.idle();
    expect(again.status().body.job, why(again.status().body.job)).toMatchObject({ jobId: 'job-r1pg-t9-04', state: 'done' });
    const names = await schemas(rig);
    const aside = names.filter(n => n.startsWith('smdb_superseded_'));
    expect(aside).toHaveLength(1);
    expect(await storeIdOf(aside[0])).toBe(copyId);
    expect(await storeIdOf('smdb_data')).not.toBe(copyId);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', migration: 'job-r1pg-t9-04' });
  }, 90_000);

  it('S9: the retirement COMMIT lands but its answer is lost; the job ends interrupted at retire-source and a POST finds case 2', async () => {
    useDatabaseUrl(hopUrl);
    const sourceId = await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{"a":1}');
    const first = realService(new FakeHost(), { commitBoundMs: 2000, closeBoundMs: 1000, fault: p => { if (p === 'retire-commit-send') hop.mute(); } });
    await first.post({ jobId: 'job-r1pg-t9-05', to: 'file' });
    await first.idle();
    expect(first.status().body.job, why(first.status().body.job)).toMatchObject({ state: 'interrupted', stage: 'retire-source' });
    expect(readJson(JOURNAL)).toMatchObject({ stage: 'retire-source', result: 'interrupted' });
    hop.restore();
    await sessionsGone(rig);
    const names = await schemas(rig);
    expect(names).not.toContain('smdb_data');
    const aside = names.filter(n => n.startsWith('smdb_superseded_'));
    expect(aside).toHaveLength(1);
    expect(await storeIdOf(aside[0])).toBe(sourceId);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres', storeId: sourceId });
    const again = realService(new FakeHost());
    const answer = await again.post({ jobId: 'job-r1pg-t9-06', to: 'file' });
    expect(answer.body, why(answer.body)).toMatchObject({ success: true, jobId: 'job-r1pg-t9-05', state: 'done' });
    expect(readJson(MARKER)).toMatchObject({ live: 'file', migration: 'job-r1pg-t9-05' });
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-r1pg-t9-05', result: 'done' });
    expect(fs.readFileSync(ENV, 'utf-8')).toMatch(/^DATA_BACKEND=file$/m);
  }, 90_000);
});
