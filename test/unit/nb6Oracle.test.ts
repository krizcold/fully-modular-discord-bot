import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { check } from '../oracle/check.mjs';
import { canonical, classifyAnswer, hashOf, main, parseLog } from '../oracle/oracle.mjs';
import { buildSharedHistory, judgeShared, mirrorCopy, rowCopy } from '../oracle/shared.mjs';

// NB6's three oracle cases for a Postgres bot of two machines (sheet section 9): SHARED-LOST, SHARED-OVERWRITE and
// SHARED-FORK, the shared writer and its copies, and the refusal list's texts of decisions 6, 13, 16, 26 and 28.

const RUN = 'r1';
const KEY = 'oracle/s1.json';
const SEED = { seed: 1 };

describe('the refusal list', () => {
  const refused = (error: string) => classifyAnswer(409, { success: false, error });

  it("names decision 26's and T22's changed-elsewhere texts as changes no machine applied", () => {
    const at = new Date('2026-11-08T03:00:00.000Z');
    expect(refused(truthText('changed-elsewhere', false, { machine: 'BRAVO', at })).definite).toBe(true);
    expect(refused(truthText('changed-elsewhere', false, { machine: null, at })).definite).toBe(true);
    expect(refused(truthText('changed-elsewhere', false, 'deleted')).definite).toBe(true);
    expect(refused(truthText('changed-elsewhere', false)).definite).toBe(true);
  });

  it('keeps a refusal that saved part of the change as one that may have applied', () => {
    const at = new Date('2026-11-08T03:00:00.000Z');
    expect(refused(truthText('changed-elsewhere', true, { machine: 'BRAVO', at })).definite).toBe(false);
    expect(refused(truthText('changed-elsewhere', true)).definite).toBe(false);
  });

  it("names the nothing-was-saved texts of decisions 13, 16 and 28 (guard: 'nothing was' holds them)", () => {
    // sharedOps.ts unreachableText, webui/botManager.ts reconcileAfterTake, appStoreManager.ts's 409.
    expect(refused("Can't reach the database to read the current premium settings (timeout); nothing was saved. Try again in a moment.").definite).toBe(true);
    expect(refused("Can't reach the database to read the shared files (timeout); nothing was saved. Try again in a moment.").definite).toBe(true);
    expect(refused('repos.json was changed on BRAVO at 2026-11-08T03:00:00.000Z while this change was being made; nothing was saved. Reload the App Store tab to see the current values.').definite).toBe(true);
  });
});

// A writer log as oracle.mjs writes it: a start line, then for each shared write its read, send and answer.
type W = { lane: string; c: number; prev: object | null; cls: 'ACKED' | 'HELD' | 'REFUSED' | 'UNKNOWN'; definite?: boolean; content?: object };
const contentOf = (w: W) => w.content ?? { run: RUN, lane: w.lane, kind: 's', key: KEY, c: w.c, prev: w.prev === null ? null : hashOf(w.prev), pad: `p${w.lane}${w.c}` };

function logOf(writes: W[], opts: { ended?: boolean; endedAt?: string; lanes?: string[] } = {}): any[] {
  const lanes = opts.lanes ?? [...new Set(writes.map(w => w.lane))];
  const events: any[] = [{ t: 'start', v: 1, run: RUN, guild: '123456789012345678', sink: 'file', lanes: lanes.map(name => ({ name })), settings: {} }];
  const counts = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0, reads: 0, readErrors: 0 };
  let id = 0;
  let at = 1;
  for (const w of writes) {
    const content = contentOf(w);
    events.push({ t: 'shared-read', id: ++id, lane: w.lane, key: KEY, at0: at++, at1: at++, s: w.prev === null ? 'absent' : 'present', ...(w.prev === null ? {} : { h: hashOf(w.prev) }) });
    counts.reads += 1;
    const sid = ++id;
    events.push({ t: 'shared-send', id: sid, lane: w.lane, key: KEY, c: w.c, h: hashOf(content), prev: (content as any).prev, base: 'sha', content, at: at++ });
    if (w.cls !== 'UNKNOWN') events.push({ t: 'shared-ans', id: sid, at: at++, status: w.cls === 'ACKED' ? 200 : w.cls === 'HELD' ? 202 : 409, cls: w.cls, definite: w.definite ?? w.cls !== 'REFUSED' });
    counts[w.cls] += 1;
  }
  if (opts.ended !== false) {
    events.push({ t: 'end', at: at++, endedAt: opts.endedAt ?? '2026-11-08T03:00:00.000Z', counts: { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0, reads: 0, readErrors: 0, shared: counts } });
  }
  return events;
}

const rowsOf = (name: string, docs: Record<string, object | null>) => rowCopy(name, Object.entries(docs)
  .filter(([, d]) => d !== null)
  .map(([k, d]) => JSON.stringify({ k, b: Buffer.from(JSON.stringify(d, null, 2), 'utf8').toString('base64') }))
  .join('\n'));

const mirrorOf = (name: string, docs: Record<string, object | null>, at = '2026-11-08T03:05:00.000Z', run = RUN) => mirrorCopy([
  JSON.stringify({ t: 'copy', v: 1, kind: 'mirror', name, run, at, keys: Object.keys(docs).length }),
  ...Object.entries(docs).map(([k, d]) => JSON.stringify(d === null ? { k, s: 'absent' } : { k, s: 'present', h: hashOf(d) })),
].join('\n'));

// Lane a stores w1 over the seed, lane b stores w2 over w1.
const w1: W = { lane: 'a', c: 1, prev: SEED, cls: 'ACKED' };
const w2: W = { lane: 'b', c: 1, prev: contentOf(w1), cls: 'ACKED' };

function judgeOf(logs: any[][], rows: Record<string, object | null>[] = [], mirrors: [string, Record<string, object | null>, string?][] = [], boundS = 90) {
  return judgeShared({
    history: buildSharedHistory(logs),
    rows: rows.map((r, i) => rowsOf(`db${i + 1}`, r)),
    mirrors: mirrors.map(([name, docs, at]) => mirrorOf(name, docs, at)),
    boundS,
  });
}

const verdictsOf = (r: ReturnType<typeof judgeOf>) => r.verdicts.map(v => `${v.v} ${v.copy ?? ''}`.trim()).sort();

describe('the shared judge', () => {
  it('passes a chain of acknowledged writes that the row and both mirrors end on', () => {
    const r = judgeOf([logOf([w1, w2])], [{ [KEY]: contentOf(w2) }], [['a', { [KEY]: contentOf(w2) }], ['b', { [KEY]: contentOf(w2) }]]);
    expect(r.verdicts).toEqual([]);
    expect(r.inconclusive).toEqual([]);
  });

  it('passes a copy that ends on a write with no answer built on the last acknowledged one', () => {
    const w3: W = { lane: 'a', c: 2, prev: contentOf(w2), cls: 'UNKNOWN' };
    const r = judgeOf([logOf([w1, w2, w3])], [{ [KEY]: contentOf(w3) }], [['a', { [KEY]: contentOf(w3) }], ['b', { [KEY]: contentOf(w3) }]]);
    expect(r.verdicts).toEqual([]);
  });

  it('names SHARED-OVERWRITE for two acknowledged writes built on one version', () => {
    const w2b: W = { lane: 'b', c: 1, prev: SEED, cls: 'ACKED' };
    const r = judgeOf([logOf([w1, w2b])], [{ [KEY]: contentOf(w2b) }], [['a', { [KEY]: contentOf(w2b) }], ['b', { [KEY]: contentOf(w2b) }]]);
    expect(verdictsOf(r)).toEqual(['SHARED-LOST db1', 'SHARED-LOST a', 'SHARED-LOST b', 'SHARED-OVERWRITE'].sort());
    const over = r.verdicts.find(v => v.v === 'SHARED-OVERWRITE')!;
    expect(over.key).toBe(KEY);
    expect(over.detail).toContain('a c=1');
    expect(over.detail).toContain('b c=1');
  });

  it('judges a held write built on the same version as one that may not have landed (guard)', () => {
    const w2b: W = { lane: 'b', c: 1, prev: SEED, cls: 'HELD' };
    const r = judgeOf([logOf([w1, w2b])], [{ [KEY]: contentOf(w1) }], [['a', { [KEY]: contentOf(w1) }], ['b', { [KEY]: contentOf(w1) }]]);
    expect(r.verdicts).toEqual([]);
  });

  it('names SHARED-LOST in the row when an acknowledged write is not in the history of its version', () => {
    const r = judgeOf([logOf([w1, w2])], [{ [KEY]: contentOf(w1) }], [['a', { [KEY]: contentOf(w2) }], ['b', { [KEY]: contentOf(w2) }]]);
    expect(verdictsOf(r)).toEqual(['SHARED-LOST db1']);
    expect(r.verdicts[0].detail).toContain('b c=1');
  });

  it('names SHARED-LOST for a row that is gone', () => {
    const r = judgeOf([logOf([w1, w2])], [{ [KEY]: null }], [['a', { [KEY]: contentOf(w2) }], ['b', { [KEY]: contentOf(w2) }]]);
    expect(verdictsOf(r)).toEqual(['SHARED-LOST db1']);
  });

  it('names SHARED-LOST and SHARED-FORK for a mirror left on an older version after the bound', () => {
    const r = judgeOf([logOf([w1, w2])], [{ [KEY]: contentOf(w2) }], [['a', { [KEY]: contentOf(w2) }], ['b', { [KEY]: contentOf(w1) }]]);
    expect(verdictsOf(r)).toEqual(['SHARED-FORK a,b', 'SHARED-LOST b']);
  });

  it('names SHARED-FORK for two mirrors that differ, even on versions no acknowledged write needs', () => {
    const w3: W = { lane: 'a', c: 2, prev: contentOf(w2), cls: 'UNKNOWN' };
    const r = judgeOf([logOf([w1, w2, w3])], [{ [KEY]: contentOf(w3) }], [['a', { [KEY]: contentOf(w3) }], ['b', { [KEY]: contentOf(w2) }]]);
    expect(verdictsOf(r)).toEqual(['SHARED-FORK a,b']);
  });

  it('names PHANTOM for a copy whose version comes from a write refused before applying', () => {
    const w2r: W = { lane: 'b', c: 1, prev: contentOf(w1), cls: 'REFUSED', definite: true };
    const r = judgeOf([logOf([w1, w2r])], [{ [KEY]: contentOf(w2r) }], [['a', { [KEY]: contentOf(w1) }], ['b', { [KEY]: contentOf(w1) }]]);
    expect(verdictsOf(r)).toEqual(['PHANTOM db1']);
  });

  it('judges a refusal that may have applied as one that may have landed (guard)', () => {
    const w2r: W = { lane: 'b', c: 1, prev: contentOf(w1), cls: 'REFUSED', definite: false };
    const r = judgeOf([logOf([w1, w2r])], [{ [KEY]: contentOf(w2r) }], [['a', { [KEY]: contentOf(w2r) }], ['b', { [KEY]: contentOf(w2r) }]]);
    expect(r.verdicts).toEqual([]);
  });

  it('cannot pass without a row listing or without a mirror copy from each of two machines', () => {
    expect(judgeOf([logOf([w1])], [], [['a', { [KEY]: contentOf(w1) }], ['b', { [KEY]: contentOf(w1) }]]).inconclusive.join(' ')).toContain('--shared-db');
    expect(judgeOf([logOf([w1])], [{ [KEY]: contentOf(w1) }], [['a', { [KEY]: contentOf(w1) }]]).inconclusive.join(' ')).toContain('--mirror');
  });

  it('does not judge a mirror copied before the bound, and cannot pass then', () => {
    const r = judgeOf([logOf([w1, w2])], [{ [KEY]: contentOf(w2) }], [['a', { [KEY]: contentOf(w2) }], ['b', { [KEY]: contentOf(w1) }, '2026-11-08T03:00:30.000Z']]);
    expect(r.verdicts).toEqual([]);
    expect(r.inconclusive.join(' ')).toContain('30 s after');
  });

  it('cannot judge the mirrors of a log with no end time', () => {
    const r = judgeOf([logOf([w1], { ended: false })], [{ [KEY]: contentOf(w1) }], [['a', { [KEY]: contentOf(w1) }], ['b', { [KEY]: {} }]]);
    expect(r.verdicts).toEqual([]);
    expect(r.inconclusive.length).toBeGreaterThan(0);
  });

  it('cannot pass a run in which no shared write was acknowledged', () => {
    const r = judgeOf([logOf([{ ...w1, cls: 'UNKNOWN' }])], [{ [KEY]: SEED }], [['a', { [KEY]: SEED }], ['b', { [KEY]: SEED }]]);
    expect(r.inconclusive.join(' ')).toContain('no shared write was acknowledged');
  });

  it("names the lines a log's end counts lack", () => {
    const events = logOf([w1, w2]).filter(e => !(e.t === 'shared-ans' && e.id === 4));
    const history = buildSharedHistory([events]);
    expect(history.problems.join(' ')).toContain('lines are missing');
  });

  it('reads a row listing whose body is not JSON as a version no writer made', () => {
    const copy = rowCopy('db', JSON.stringify({ k: KEY, b: Buffer.from('not json', 'utf8').toString('base64') }));
    const state = copy.docs.get(KEY);
    expect(state?.s).toBe('present');
    const r = judgeShared({ history: buildSharedHistory([logOf([w1])]), rows: [copy], mirrors: [mirrorOf('a', { [KEY]: contentOf(w1) }), mirrorOf('b', { [KEY]: contentOf(w1) })], boundS: 90 });
    expect(verdictsOf(r)).toEqual(['SHARED-LOST db']);
  });

  it('refuses a mirror copy of another run', () => {
    expect(() => judgeShared({ history: buildSharedHistory([logOf([w1])]), rows: [], mirrors: [mirrorOf('a', {}, undefined, 'r2')], boundS: 90 })).toThrow(/run r2/);
  });
});

// Two stand-in machines over one row store, as the bot's shared route answers (routes/config.ts data/get and
// data/update, global.write's compare of loadedSha, the flush's compare of the stored sha and T22).
type Machine = { name: string; url: string; mirror: string; close: () => Promise<void> };
type Store = Map<string, string>;
const shaOf = (text: string | null) => (text === null ? 'absent' : createHash('sha256').update(text, 'utf8').digest('hex'));
const mirrorPath = (mirror: string, key: string) => path.join(mirror, 'global', ...key.split('/'));
const readMirror = (mirror: string, key: string) => (fs.existsSync(mirrorPath(mirror, key)) ? fs.readFileSync(mirrorPath(mirror, key), 'utf8') : null);
const writeMirror = (mirror: string, key: string, text: string) => {
  fs.mkdirSync(path.dirname(mirrorPath(mirror, key)), { recursive: true });
  fs.writeFileSync(mirrorPath(mirror, key), text);
};

async function machine(name: string, store: Store, root: string, compare: boolean): Promise<Machine> {
  const mirror = path.join(root, name);
  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url ?? '/', 'http://stand-in');
    const key = url.pathname === '/api/config/data/get' ? url.searchParams.get('file') ?? '' : '';
    if (req.method === 'GET' && url.pathname === '/api/config/data/get') {
      if (url.searchParams.has('guildId')) return send(400, { success: false, error: 'guild reads are not served here' });
      const text = readMirror(mirror, key);
      if (text === null) return send(404, { success: false, error: 'Data file not found' });
      return send(200, { success: true, data: JSON.parse(text), exists: true, sha: shaOf(text) });
    }
    if (req.method === 'POST' && url.pathname === '/api/config/data/update') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (b.guildId !== undefined) return send(400, { success: false, error: 'guild writes are not served here' });
      if (typeof b.loadedSha !== 'string') return send(400, { success: false, error: 'This page is out of date; nothing was saved. Reload the page and open the file again.' });
      if (shaOf(readMirror(mirror, b.file)) !== b.loadedSha) return send(409, { success: false, error: 'This file changed since you opened it; nothing was saved. Reload it to see the current values.' });
      const text = JSON.stringify(b.data, null, 2);
      if (compare && shaOf(store.get(b.file) ?? null) !== b.loadedSha) {
        return send(409, { success: false, error: truthText('changed-elsewhere', false, { machine: 'OTHER', at: new Date() }) });
      }
      store.set(b.file, text);
      writeMirror(mirror, b.file, text);
      return send(200, { success: true });
    }
    send(404, { success: false, error: 'no route' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    name, mirror, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

describe('the shared writer, its copies and the checker', () => {
  let root: string;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-nb6-oracle-')); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const file = (name: string) => path.join(root, name);

  async function run(id: string, compare: boolean, syncDuring: boolean) {
    const store: Store = new Map();
    const a = await machine(`${id}a`, store, root, compare);
    const b = await machine(`${id}b`, store, root, compare);
    const seed = JSON.stringify(SEED, null, 2);
    store.set(KEY, seed);
    for (const m of [a, b]) writeMirror(m.mirror, KEY, seed);
    // The pass of each machine: a mirror takes the row's version (a live bot within the bound).
    const sync = () => { for (const m of [a, b]) writeMirror(m.mirror, KEY, store.get(KEY)!); };
    const timer = syncDuring ? setInterval(sync, 20) : undefined;
    const log = file(`${id}.jsonl`);
    try {
      await main(['write', '--run', id, '--guild', '123456789012345678', '--lane', `a=${a.url}`, '--lane', `b=${b.url}`,
        '--shared', KEY, '--shared-ratio', '1', '--hot-ratio', '0', '--delete-ratio', '0', '--read-every', '0',
        '--limiter', 'off', '--rate', '40', '--duration', '1.5', '--log', log]);
    } finally {
      if (timer) clearInterval(timer);
      await a.close();
      await b.close();
    }
    sync();
    for (const m of [a, b]) await main(['mirror', '--log', log, '--data', m.mirror, '--name', m.name, '--out', file(`${m.name}.mirror.jsonl`)]);
    fs.writeFileSync(file(`${id}.rows.jsonl`), [...store].map(([k, text]) => JSON.stringify({ k, b: Buffer.from(text, 'utf8').toString('base64') })).join('\n'));
    fs.writeFileSync(file(`${id}.guild.jsonl`), '');
    return { log, a, b, store };
  }

  const checkRun = (id: string, extra: string[] = []) => check(['--log', file(`${id}.jsonl`), '--db', `guild=${file(`${id}.guild.jsonl`)}`,
    '--shared-db', `primary=${file(`${id}.rows.jsonl`)}`, '--mirror', file(`${id}a.mirror.jsonl`), '--mirror', file(`${id}b.mirror.jsonl`),
    '--shared-bound', '0', '--no-fleet', '--k', '0', ...extra]);

  it('logs each shared write with the version it read and passes a run whose saves each machine compared', async () => {
    const { log } = await run('sa', true, true);
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    const sends = events.filter(e => e.t === 'shared-send');
    const answers = new Map(events.filter(e => e.t === 'shared-ans').map(e => [e.id, e]));
    expect(sends.length).toBeGreaterThan(4);
    expect(sends.some(s => answers.get(s.id)?.cls === 'ACKED')).toBe(true);
    for (const s of sends) {
      expect(s.key).toBe(KEY);
      expect(s.h).toBe(hashOf(s.content));
      expect(s.content.prev).toBe(s.prev);
      expect(typeof s.base).toBe('string');
    }
    // The first write of the run was built on the seed it read.
    expect(sends[0].prev).toBe(hashOf(SEED));
    // A refusal by the compare is a change no machine applied.
    for (const s of sends) if (answers.get(s.id)?.cls === 'REFUSED') expect(answers.get(s.id)!.definite).toBe(true);
    expect(events.filter(e => e.t === 'send')).toEqual([]);
    const end = events.find(e => e.t === 'end');
    expect(end.counts.shared.ACKED + end.counts.shared.REFUSED + end.counts.shared.HELD + end.counts.shared.UNKNOWN).toBe(sends.length);
    const { result } = checkRun('sa');
    expect(result.verdicts).toEqual([]);
    expect(result.inconclusive).toEqual([]);
    expect(result.result).toBe('PASS');
  }, 20_000);

  it('names SHARED-OVERWRITE when machines store a save over a version it was not built on', async () => {
    await run('sb', false, false);
    const { result } = checkRun('sb');
    expect(result.result).toBe('FAIL');
    expect(result.verdicts.map((v: any) => v.v)).toContain('SHARED-OVERWRITE');
  }, 20_000);

  it('names SHARED-FORK and SHARED-LOST for a mirror put back to an older acknowledged version', async () => {
    const { log, b, store } = await run('sc', true, true);
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    const answers = new Map(events.filter(e => e.t === 'shared-ans').map(e => [e.id, e]));
    const acked = events.filter(e => e.t === 'shared-send' && answers.get(e.id)?.cls === 'ACKED');
    const last = store.get(KEY)!;
    const older = acked.find(s => canonical(s.content) !== canonical(JSON.parse(last)));
    expect(older).toBeDefined();
    writeMirror(b.mirror, KEY, JSON.stringify(older.content, null, 2));
    fs.rmSync(file(`${b.name}.mirror.jsonl`));
    await main(['mirror', '--log', log, '--data', b.mirror, '--name', b.name, '--out', file(`${b.name}.mirror.jsonl`)]);
    const { result } = checkRun('sc');
    expect(result.result).toBe('FAIL');
    expect(result.verdicts.map((v: any) => `${v.v} ${v.copy}`).sort()).toEqual([`SHARED-FORK sca,scb`, 'SHARED-LOST scb']);
  }, 20_000);

  it('prints the database listing of the run\'s shared files', async () => {
    await run('sd', true, true);
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });
    try {
      await main(['sql', 'shared', '--log', file('sd.jsonl')]);
    } finally {
      spy.mockRestore();
    }
    const query = out.join('');
    expect(query).toContain('smdb_data.shared_docs');
    expect(query).toContain(`'global/${KEY}'`);
  }, 20_000);

  it('refuses a shared file id that leaves /data/global or is not a .json file', async () => {
    for (const bad of ['../x.json', 'a/../b.json', 'a/b/c.json', 'x.txt', "o'x.json"]) {
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.exitCode = 0;
      await main(['write', '--run', 'bad', '--guild', '123456789012345678', '--lane', 'a=http://127.0.0.1:1', '--shared', bad, '--log', file(`bad-${Math.random().toString(36).slice(2)}.jsonl`)]);
      expect(process.exitCode).toBe(64);
      expect(err.mock.calls.map(c => String(c[0])).join(' ')).toContain('--shared');
      err.mockRestore();
    }
    process.exitCode = 0;
  });
});
