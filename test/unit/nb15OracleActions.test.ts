import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { check, render } from '../oracle/check.mjs';
import { actionListing, buildActions, judgeActions } from '../oracle/actions.mjs';
import { ACTION_DOC, actionNonce, actionsSql, main, parseLog } from '../oracle/oracle.mjs';

const GUILD = '123456789012345678';
const PANEL = 'oracle-panel';
const BUTTON = 'press';
const COMMAND = 'oracle-act';

// What one action does on the stand-in holder, by the lane and the number its nonce carries.
type Effect = 'ok' | 'module-words' | 'no-answer' | 'not-held' | 'twice' | 'false-ok' | 'false-refusal';
type Store = Map<string, string>;
type Seen = { path: string; body: any };

// A web UI whose holder runs the oracle's action module: each run of an action saves one `<nonce>.<tag>.json`.
async function standIn(store: Store, seen: Seen[], effectOf: (nonce: string) => Effect) {
  let tag = 0;
  const save = (nonce: string) => store.set(`${nonce}.t${++tag}.json`, JSON.stringify({ nonce }, null, 2));
  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const url = new URL(req.url ?? '/', 'http://stand-in');
    seen.push({ path: url.pathname, body });
    let nonce = '';
    if (req.method === 'POST' && url.pathname === '/api/panels/button') nonce = String(body.buttonId).split(':').pop() ?? '';
    else if (req.method === 'POST' && url.pathname === '/api/commands/invoke') nonce = String(body.options?.nonce ?? '');
    else return send(404, { success: false, error: 'no route' });
    switch (effectOf(nonce)) {
      case 'ok':
        save(nonce);
        return send(200, { success: true, servedBy: 'B' });
      case 'module-words':
        // A module's own words after the prefix: a data route would count this text as a refusal before anything ran.
        save(nonce);
        return send(500, { success: false, servedBy: 'B', error: 'On B: Data file not found: settings.json' });
      case 'no-answer':
        save(nonce);
        return send(503, { success: false, code: 'no-answer', noAnswer: 'timeout', error: "B did not answer in time; can't confirm whether the action ran." });
      case 'not-held':
        return send(400, { success: false, code: 'not-held', ran: false, error: 'B no longer runs this server; nothing was run.' });
      case 'twice':
        save(nonce);
        save(nonce);
        return send(200, { success: true, servedBy: 'B' });
      case 'false-ok':
        return send(200, { success: true, servedBy: 'B' });
      case 'false-refusal':
        save(nonce);
        return send(400, { success: false, code: 'not-held', ran: false, error: 'B no longer runs this server; nothing was run.' });
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const numberOf = (nonce: string) => Number(nonce.split('_').pop());

describe('the act writer, its listing and the checker (NB15 test 12)', () => {
  let root: string;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-nb15-oracle-')); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name: string) => path.join(root, name);

  async function run(id: string, effectOf: (nonce: string) => Effect) {
    const store: Store = new Map();
    const seen: Seen[] = [];
    const a = await standIn(store, seen, effectOf);
    const c = await standIn(store, seen, effectOf);
    const log = file(`${id}.jsonl`);
    try {
      await main(['act', '--run', id, '--guild', GUILD, '--lane', `a=${a.url}`, '--lane', `c=${c.url}`, '--panel', PANEL, '--button', BUTTON,
        '--command', COMMAND, '--limiter', 'off', '--rate', '40', '--duration', '1', '--seed', '7', '--log', log]);
    } finally {
      await a.close();
      await c.close();
    }
    const listing = file(`${id}.actions.jsonl`);
    fs.writeFileSync(listing, [...store].map(([k, d]) => JSON.stringify({ k, d })).join('\n'));
    return { log, listing, seen, events: parseLog(fs.readFileSync(log, 'utf8')) };
  }

  const answersOf = (events: any[]) => new Map(events.filter(e => e.t === 'act-ans').map(e => [e.id, e]));

  it('sends each action with its nonce, classes each answer by the panel rule and passes a clean run', async () => {
    const effects: Effect[] = ['ok', 'module-words', 'no-answer', 'not-held'];
    const { log, listing, seen, events } = await run('aa', nonce => effects[numberOf(nonce) % effects.length]);
    const sends = events.filter(e => e.t === 'act-send');
    expect(sends.length).toBeGreaterThan(8);
    expect(new Set(sends.map(s => s.kind))).toEqual(new Set(['button', 'invoke']));
    expect(events[0]).toMatchObject({ t: 'start', mode: 'act', run: 'aa', guild: GUILD, sink: 'file' });
    for (const s of seen) {
      if (s.path === '/api/panels/button') {
        expect(s.body).toMatchObject({ panelId: PANEL, userId: 'web-ui-owner', guildId: GUILD });
        expect(s.body.buttonId).toMatch(new RegExp(`^${BUTTON}:act_aa_[ac]_\\d+$`));
      } else {
        expect(s.body).toMatchObject({ command: COMMAND, guildId: GUILD });
        expect(s.body.options.nonce).toMatch(/^act_aa_[ac]_\d+$/);
      }
    }
    const answers = answersOf(events);
    for (const s of sends) {
      const ans = answers.get(s.id);
      const effect = effects[numberOf(s.nonce) % effects.length];
      if (effect === 'ok') expect(ans).toMatchObject({ cls: 'ACKED', definite: true, status: 200 });
      if (effect === 'module-words') expect(ans).toMatchObject({ cls: 'REFUSED', definite: false, status: 500 });
      if (effect === 'no-answer') expect(ans).toMatchObject({ cls: 'UNKNOWN', definite: false, code: 'no-answer' });
      if (effect === 'not-held') expect(ans).toMatchObject({ cls: 'REFUSED', definite: true, code: 'not-held', ran: false });
    }
    const end = events.find(e => e.t === 'end');
    expect(end.counts).toMatchObject({ ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0 });
    expect(end.counts.act.ACKED + end.counts.act.REFUSED + end.counts.act.UNKNOWN).toBe(sends.length);

    const r = check(['--log', log, '--actions', `primary=${listing}`, '--no-fleet', '--k', '1']);
    expect(r.result.verdicts).toEqual([]);
    expect(r.result.inconclusive).toEqual([]);
    expect(r.result.result).toBe('PASS');
    expect(render(r)).toContain('RESULT PASS (panel and invoke routes');

    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await main(['sql', 'actions', '--log', log]);
      expect(out).toHaveBeenCalledWith(`${actionsSql(GUILD, 'aa')}\n`);
    } finally {
      out.mockRestore();
    }
  });

  it('names an action run twice, a false "ran and saved" and a false "nothing was run", and nothing else', async () => {
    const bites: Record<number, Effect> = { 2: 'twice', 3: 'false-ok', 4: 'false-refusal' };
    const { log, listing, events } = await run('ab', nonce => (nonce.includes('_a_') ? bites[numberOf(nonce)] : undefined) ?? 'ok');
    const nonces = events.filter(e => e.t === 'act-send').map(e => e.nonce);
    expect(nonces).toEqual(expect.arrayContaining([actionNonce('ab', 'a', 2), actionNonce('ab', 'a', 3), actionNonce('ab', 'a', 4)]));
    const r = check(['--log', log, '--actions', `primary=${listing}`, '--no-fleet', '--k', '0']);
    expect(r.result.verdicts.map((v: any) => `${v.v} ${v.key}`).sort()).toEqual([
      `FALSE-ANSWER ${actionNonce('ab', 'a', 3)}`, `FALSE-ANSWER ${actionNonce('ab', 'a', 4)}`, `TWICE ${actionNonce('ab', 'a', 2)}`,
    ].sort());
    expect(r.result.result).toBe('FAIL');
  });
});

describe('the act rules on hand-built logs', () => {
  const start = { t: 'start', v: 1, mode: 'act', run: 'h1', guild: GUILD, sink: 'file', lanes: [{ name: 'a', route: 'act', base: 'http://x' }], settings: { marksEvery: 50 } };
  const n = (i: number) => actionNonce('h1', 'a', i);
  const pair = (id: number, kind: 'button' | 'invoke', ans: Record<string, unknown> | null) => [
    { t: 'act-send', id, lane: 'a', kind, nonce: n(id), at: id },
    ...(ans ? [{ t: 'act-ans', id, at: id + 0.5, status: 200, ...ans }] : []),
  ];
  const acked = { cls: 'ACKED', definite: true };
  const listingOf = (runs: Record<number, number>, extra: string[] = []) => actionListing('db', [
    ...Object.entries(runs).flatMap(([i, count]) => Array.from({ length: count }, (_, k) => JSON.stringify({ k: `${n(Number(i))}.r${k}.json`, d: '{}' }))),
    ...extra.map(k => JSON.stringify({ k, d: '{}' })),
  ].join('\n'));

  it('lets an answer that may have run stand with no run or one, and names a run no writer sent', () => {
    const events = [start, ...pair(1, 'button', acked), ...pair(2, 'invoke', acked), ...pair(3, 'button', { cls: 'REFUSED', definite: false, status: 500 }),
      ...pair(4, 'invoke', { cls: 'UNKNOWN', definite: false, status: 503 }), ...pair(5, 'button', null), ...pair(6, 'invoke', { cls: 'REFUSED', definite: true, status: 400 })];
    const history = buildActions([events]);
    expect(history.actions.find(a => a.id === 5)?.cls).toBe('UNKNOWN');
    const r = judgeActions(history, [listingOf({ 1: 1, 2: 1, 3: 1, 4: 0, 5: 1, 7: 1 }, ['act_h1_other.json'])]);
    expect(r.verdicts.map(v => `${v.v} ${v.key}`)).toEqual([`PHANTOM ${n(7)}`]);
    expect(r.inconclusive).toEqual([]);
    expect(r.notes.join(' ')).toContain('act_h1_other.json');
  });

  it('is inconclusive with no listing, with a route never answered as ran and saved, or with lines missing', () => {
    const events = [start, ...pair(1, 'button', acked), ...pair(2, 'invoke', { cls: 'REFUSED', definite: true, status: 400 }),
      { t: 'end', at: 9, counts: { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0, reads: 0, readErrors: 0, act: { ACKED: 2, HELD: 0, REFUSED: 1, UNKNOWN: 0 } } }];
    const r = judgeActions(buildActions([events]), []);
    expect(r.inconclusive.join(' | ')).toContain('no action listing was given');
    expect(r.inconclusive.join(' | ')).toContain('no command invoke was answered as ran and saved');
    expect(r.inconclusive.join(' | ')).toContain('lines are missing');
  });

  it('reads only docs named as one run of an action', () => {
    expect(ACTION_DOC.exec(`${n(3)}.t1.json`)?.[1]).toBe(n(3));
    expect(ACTION_DOC.test(`${n(3)}.json`)).toBe(false);
    expect(ACTION_DOC.test(`h1-a-u3.json`)).toBe(false);
    expect(n(3).startsWith('h1-')).toBe(false);
  });

  it('judges act logs on their own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-nb15-act-'));
    try {
      const act = path.join(dir, 'act.jsonl');
      fs.writeFileSync(act, [start, ...pair(1, 'button', acked)].map(e => JSON.stringify(e)).join('\n'));
      const write = path.join(dir, 'write.jsonl');
      fs.writeFileSync(write, JSON.stringify({ ...start, mode: undefined, lanes: [{ name: 'w', route: 'operator', base: 'http://x' }] }));
      const listing = path.join(dir, 'db.jsonl');
      fs.writeFileSync(listing, '');
      expect(() => check(['--log', act, '--log', write, '--actions', `db=${listing}`, '--no-fleet'])).toThrow(/on their own/);
      expect(() => check(['--log', act, '--db', `db=${listing}`, '--no-fleet'])).toThrow(/--db judges write runs/);
      expect(() => check(['--log', write, '--actions', `db=${listing}`, '--no-fleet'])).toThrow(/--actions judges act logs/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
