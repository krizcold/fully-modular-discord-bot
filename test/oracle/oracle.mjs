#!/usr/bin/env node
// @ts-check
/**
 * The data-loss oracle's host-facing half (Documentation/process/VERIFY.md
 * section 5). Subcommands:
 *   write    numbered saves through each lane's operator data route, every
 *            answer logged as ACKED, HELD, REFUSED or UNKNOWN
 *   act      panel button presses and command invokes, each answer classed
 *            by the panel and invoke routes' rule (NB15 test 12)
 *   read     the run's docs through one node's app read path (a copy)
 *   fleet    the control facts the checker needs, from one node
 *   mirror   one machine's mirror files of the run's shared files (a copy)
 *   cleanup  deletes the run's docs once the checker has judged them
 * Node 18+, node: imports only, so it runs from a checkout or piped into any
 * node image on a host. check.mjs judges the logs and copies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const MODULE = 'oracle';
export const RUN_ID = /^[a-z0-9]{1,24}$/;
export const LANE_NAME = /^[a-z0-9]{1,12}$/;
export const LOG_VERSION = 1;
/** A mark line in the marks file: exactly `begin NAME` or `end NAME` (the other allowed line is `stop`). */
export const MARK = /^(begin|end) (\S+)$/;
// The web UI's limiter as one client sees it (webui/server.ts): 10 requests at
// once, then one per 500 ms per client address. 9 and 520 ms leave a margin
// for the two clocks drifting.
const LIMITER = '9/520';
// After a stop, in-flight requests get this long before they are cut and
// logged as unknown, inside docker stop's 10 s.
const STOP_GRACE_MS = 5000;
// SIGHUP too: closing the terminal of a writer run by hand stops it cleanly.
const STOP_SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);

/** @typedef {'ACKED' | 'HELD' | 'REFUSED' | 'UNKNOWN'} AnswerClass */
/** @typedef {{ cls: AnswerClass, definite: boolean }} Answer */
/** @typedef {{ s: 'present', h: string, lane?: string, c?: number } | { s: 'absent' } | { s: 'error', err: string }} DocState */
/** @typedef {{ take: (signal?: AbortSignal) => Promise<void>, empty: () => void }} Bucket */

export const uniqueKey = (/** @type {string} */ run, /** @type {string} */ lane, /** @type {number} */ n) => `${run}-${lane}-u${n}.json`;
export const hotKey = (/** @type {string} */ run, /** @type {number} */ k) => `${run}-h${k}.json`;
export const fileId = (/** @type {string} */ key) => `${MODULE}/${key}`;
// Hot docs test ordering, not payload size; unique docs carry the large payloads.
const HOT_MAX_SIZE = 256;

/**
 * A shared file the writer may name (NB6): a .json file under /data/global as the operator route names it, a module
 * folder and a file name, so the id goes into a path and a SQL literal unchanged.
 */
export const SHARED_ID = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/;
/** The shared_docs key of a shared file id. @param {string} id */
export const sharedKey = id => `global/${id}`;

/**
 * The run's shared file ids: those the start lines name and those the logs sent.
 * @param {any[][]} logs
 */
export function sharedIdsOf(logs) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const events of logs) {
    for (const e of events) {
      if (e.t === 'start' && Array.isArray(e.settings?.shared)) for (const id of e.settings.shared) ids.add(String(id));
      if (e.t === 'shared-send') ids.add(String(e.key));
    }
  }
  for (const id of ids) if (!SHARED_ID.test(id)) throw new Error(`the logs name a shared file id that is not one: ${id}`);
  return [...ids].sort();
}

/**
 * The database listing of the run's shared files, one {"k": id, "b": body in base64} line per shared_docs row under
 * `psql -At`: the input check.mjs takes as --shared-db. The body goes as base64, so a pipe that decodes text chunk by
 * chunk cannot split a character.
 * @param {string[]} ids
 */
export function sharedDumpSql(ids) {
  if (ids.length === 0) throw new Error('the logs name no shared file');
  for (const id of ids) if (!SHARED_ID.test(id)) throw new Error(`${id} is not a shared file id`);
  const keys = ids.map(id => `'${sharedKey(id)}'`).join(', ');
  return `SELECT json_build_object('k', substr(key, 8), 'b', encode(body, 'base64')) FROM smdb_data.shared_docs WHERE key IN (${keys}) ORDER BY key`;
}

/**
 * The state of one machine's mirror file of a shared file: absent, present with its content's hash (a body that is not
 * JSON is a version no writer made), or an error.
 * @param {string} file
 * @returns {DocState}
 */
export function mirrorState(file) {
  /** @type {Buffer} */
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === 'ENOENT') return { s: 'absent' };
    return { s: 'error', err: errText(error) };
  }
  try {
    return presentState(JSON.parse(bytes.toString('utf8')));
  } catch {
    return { s: 'present', h: `unparseable:${createHash('sha256').update(bytes).digest('hex')}` };
  }
}

/**
 * The database listing of one run, one {"k": filename, "d": doc} line per
 * row under `psql -At`: the input check.mjs takes as --db or --lag.
 * @param {string} guild
 * @param {string} run
 */
export function dumpSql(guild, run) {
  if (!/^\d{5,20}$/.test(guild) || !RUN_ID.test(run)) throw new Error('dumpSql needs a guild id and a run id');
  const prefix = `${run}-`;
  return `SELECT json_build_object('k', filename, 'd', doc) FROM smdb_data.guild_data WHERE guild_id = '${guild}' AND module = '${MODULE}' AND left(filename, ${prefix.length}) = '${prefix}' ORDER BY filename`;
}

/**
 * JSON with object keys sorted at every depth: the stored text is re-indented
 * and a jsonb path would reorder keys, so equality is judged on this form.
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** @param {unknown} value */
export function hashOf(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * The state of a present doc: its hash, which the checker judges by, plus the
 * lane and counter it names, for a person reading a copy.
 * @param {unknown} data
 * @returns {DocState}
 */
export function presentState(data) {
  const d = /** @type {any} */ (data);
  const facts = d !== null && typeof d === 'object' && typeof d.lane === 'string' && typeof d.c === 'number' ? { lane: d.lane, c: d.c } : {};
  return { s: 'present', h: hashOf(data), ...facts };
}

/**
 * mulberry32: a small seeded generator, so a run's traffic is reproducible
 * from the seed in its start line.
 * @param {number} seed
 */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Escapes, multi-byte text and a surrogate pair beside plain ASCII: content
// that reads back whole only if every layer keeps it whole.
const RARE = ['"', '\\', '\n', '\t', '/', 'é', 'ß', '漢', '🙂', ' '];
const PLAIN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

/**
 * A payload whose length is log-uniform between 16 and maxSize characters:
 * mostly small, sometimes large.
 * @param {() => number} rand
 * @param {number} maxSize
 */
export function padding(rand, maxSize) {
  const min = 16;
  const size = Math.floor(Math.exp(Math.log(min) + rand() * (Math.log(Math.max(min, maxSize)) - Math.log(min))));
  const parts = new Array(size);
  for (let i = 0; i < size; i++) {
    parts[i] = rand() < 0.05 ? RARE[Math.floor(rand() * RARE.length)] : PLAIN[Math.floor(rand() * PLAIN.length)];
  }
  return parts.join('');
}

// Refusals the bot gives before anything is applied. Any other refusal may
// have landed, so it is judged as possibly applied; a reworded message only
// weakens the PHANTOM check, never raises a false verdict.
const DEFINITE_REFUSALS = [
  'Guild data is frozen',
  'the bot process is not running',
  'write not accepted',
  'delete not accepted',
  'guild data is not ready',
  'Data file not found',
  // NB7 invariant 2: a request-route answer holding it is a change no process applied. It also holds NB6's
  // "nothing was saved" answers of decisions 13, 16 and 28, given before anything was stored.
  'nothing was',
  // NB6 decisions 6 and 26 with T22: a shared save the flush refused because another machine stored the file after this one
  // read it. The period leaves out the "not saved in full" form, which another write of the answer may have applied.
  'while your change was being saved, so your change was not saved.',
  'after your change read it, so your change was not saved.',
];

/**
 * The operator route's answer (routes/config.ts sendHopReply): 200 is
 * committed, 202 is accepted but not yet durable, anything else refused, and
 * no answer at all is unknown.
 * The panel and invoke routes (NB15 ruling 10, route 'panel') are judged by the answer's code and ran: a holder's text
 * after "On <name>: " can be a module's own words, so no substring makes their failure definite.
 * @param {number} status
 * @param {any} body
 * @param {'data' | 'panel'} [route]
 * @returns {Answer}
 */
export function classifyAnswer(status, body, route = 'data') {
  if (status === 0) return { cls: 'UNKNOWN', definite: false };
  const ok = body !== null && typeof body === 'object' && body.success === true;
  if (status === 200 && ok && body.pending !== true) return { cls: 'ACKED', definite: true };
  if (status === 202 && ok) return { cls: 'HELD', definite: true };
  const error = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  // 400 is validation, 413 a body limit in front of the app and 429 the rate limiter: all before the route runs.
  const early = status === 400 || status === 413 || status === 429;
  if (route === 'panel') {
    const b = body !== null && typeof body === 'object' ? body : {};
    if (b.code === 'no-answer' || b.noAnswer !== undefined) return { cls: 'UNKNOWN', definite: false };
    if (b.ran === false || (typeof b.code === 'string' && DEFINITE_CODES.includes(b.code))) return { cls: 'REFUSED', definite: true };
    return { cls: 'REFUSED', definite: early && b.ran !== true };
  }
  return { cls: 'REFUSED', definite: early || DEFINITE_REFUSALS.some(text => error.includes(text)) };
}

// NB15: the codes of a panel or invoke answer that prove nothing ran.
const DEFINITE_CODES = ['not-taken', 'no-holder', 'backend-unavailable', 'invalid', 'not-allowed', 'member-panel-off', 'not-ready', 'insecure-transport', 'not-held'];

/**
 * A token bucket mirroring the web UI's limiter: taking a token before every
 * request keeps the limiter from refusing this tool.
 * @param {string} spec 'CAPACITY/MS', or 'off'
 * @returns {Bucket}
 */
export function bucket(spec) {
  if (spec === 'off') return { take: async () => {}, empty: () => {} };
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new Error('--limiter must be CAPACITY/MS (both above 0) or off');
  const capacity = Number(m[1]);
  const refillMs = Number(m[2]);
  let tokens = capacity;
  let last = performance.now();
  const refill = () => {
    const now = performance.now();
    const add = Math.floor((now - last) / refillMs);
    if (add > 0) {
      tokens = Math.min(capacity, tokens + add);
      last += add * refillMs;
    }
    return now;
  };
  return {
    take: async signal => {
      for (;;) {
        const now = refill();
        if (tokens > 0) {
          tokens -= 1;
          return;
        }
        await delay(Math.max(1, last + refillMs - now), undefined, signal ? { signal } : undefined);
      }
    },
    // A 429 came anyway: someone else shares the bucket, so start from empty.
    empty: () => {
      refill();
      tokens = 0;
    },
  };
}

/** @param {unknown} error */
function errText(error) {
  if (error instanceof Error) {
    const cause = /** @type {{ code?: string } | undefined} */ (error.cause);
    return cause && cause.code ? `${error.message} (${cause.code})` : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * @param {'GET' | 'POST'} method
 * @param {string} url
 * @param {unknown} body
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal] cuts the request short (the writer stopping)
 * @returns {Promise<{ status: number, body: any, date?: string, retryAfter?: number, err?: string }>}
 */
export async function call(method, url, body, timeoutMs, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
  const onStop = () => ctl.abort(new Error('cut short by the stop'));
  if (signal?.aborted) onStop();
  else signal?.addEventListener('abort', onStop, { once: true });
  try {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (error) {
      return { status: 0, body: null, err: errText(error) };
    }
    const date = res.headers.get('date') ?? undefined;
    const retryAfter = Number(res.headers.get('retry-after')) || undefined;
    let text;
    try {
      text = await res.text();
    } catch (error) {
      return { status: res.status, body: null, date, retryAfter, err: `body unread: ${errText(error)}` };
    }
    try {
      return { status: res.status, body: JSON.parse(text), date, retryAfter };
    } catch {
      return { status: res.status, body: null, date, retryAfter, err: `body not JSON: ${text.slice(0, 120)}` };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onStop);
  }
}

/**
 * One request at the limiter's pace. A 429 (another client spent the shared
 * bucket) is retried after its Retry-After, up to five times.
 * @param {Bucket} limit
 * @param {() => ReturnType<typeof call>} request
 */
async function paced(limit, request) {
  for (let attempt = 0; ; attempt++) {
    await limit.take();
    const r = await request();
    if (r.status !== 429 || attempt >= 5) return r;
    limit.empty();
    await delay((r.retryAfter ?? 1) * 1000);
  }
}

/**
 * One doc through a node's app read path (GET /api/config/data/get).
 * @param {{ status: number, body: any, err?: string }} r
 * @returns {DocState}
 */
export function docStateOf(r) {
  if (r.status === 404) return { s: 'absent' };
  if (r.status === 200 && r.body && r.body.success === true) {
    return r.body.exists === false ? { s: 'absent' } : presentState(r.body.data);
  }
  return { s: 'error', err: r.err ?? `${r.status} ${r.body && r.body.error ? r.body.error : ''}`.trim() };
}

/** @param {string} base @param {string} guild @param {string} key */
const readUrl = (base, guild, key) => `${base}/api/config/data/get?file=${encodeURIComponent(fileId(key))}&guildId=${guild}`;

/** @param {string} target */
export function openOut(target) {
  if (target === '-') {
    return (/** @type {object} */ event) => { process.stdout.write(`${JSON.stringify(event)}\n`); };
  }
  // Never appended to: a second run into one file would merge two clocks.
  const fd = fs.openSync(target, 'wx');
  // The whole line or an error: a short write on a full disk must stop the
  // request the line names from going out.
  return (/** @type {object} */ event) => { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); };
}

/**
 * Every line of each writer log, parsed; a bad last line is dropped (a log
 * can end mid-line), any other bad line is an error.
 * @param {string} text
 * @returns {any[]}
 */
export function parseLog(text) {
  const lines = text.split('\n');
  /** @type {any[]} */
  const events = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      events.push(JSON.parse(line));
    } catch {
      const last = lines.slice(i + 1).every(rest => rest.trim() === '');
      if (!last) throw new Error(`log line ${i + 1} is not JSON`);
    }
  });
  return events;
}

/**
 * @param {string[]} argv
 * @param {Record<string, 'one' | 'many' | 'flag'>} spec
 */
export function parseArgs(argv, spec) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, kind] of Object.entries(spec)) if (kind === 'many') out[name] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    const kind = spec[name];
    if (!kind) throw new Error(`unknown option --${name}`);
    if (kind === 'flag') {
      out[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (kind === 'many') out[name].push(value);
    else out[name] = value;
  }
  return out;
}

/** @param {string | undefined} value @param {string} name @param {number} fallback */
function num(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number >= 0`);
  return n;
}

/** @param {string} guild */
function checkGuild(guild) {
  if (!/^\d{5,20}$/.test(guild ?? '')) throw new Error('--guild must be a guild id');
}

/** @param {string} base */
function checkBase(base) {
  const url = new URL(base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${base} is not an http URL`);
  return base.replace(/\/+$/, '');
}

const WRITE_USAGE = `oracle.mjs write --run ID --guild ID --lane NAME=URL [--lane NAME=URL ...]
  [--duration S (1800, 0 = until stopped)] [--rate REQUESTS_PER_S (1.5, per lane, reads included)]
  [--hot N (3)] [--hot-ratio R (0.3)] [--delete-ratio R (0.1)] [--read-every N (5 writes, 0 = never)]
  [--max-size CHARS (8000)] [--max-body BYTES (10000)] [--seed N] [--marks FILE] [--marks-every MS (50)] [--burst X (4)]
  [--limiter CAPACITY/MS (${LIMITER}) | off] [--timeout MS (20000)] [--log FILE (- = stdout, the default; may repeat)]
  [--shared ID (a global file such as module/file.json; may repeat)] [--shared-ratio R (0.2 with --shared)]`;

/** @param {string[]} argv */
async function write(argv) {
  const a = parseArgs(argv, {
    run: 'one', guild: 'one', lane: 'many', duration: 'one', rate: 'one', hot: 'one', 'hot-ratio': 'one',
    'delete-ratio': 'one', 'read-every': 'one', 'max-size': 'one', 'max-body': 'one', seed: 'one', marks: 'one',
    'marks-every': 'one', burst: 'one', limiter: 'one', timeout: 'one', log: 'many', shared: 'many', 'shared-ratio': 'one',
  });
  for (const id of a.shared) if (!SHARED_ID.test(id)) throw new Error(`--shared ${id}: name a .json file under /data/global as module/file.json or file.json`);
  /** @type {string[]} */
  const sharedIds = [...new Set(/** @type {string[]} */ (a.shared))];
  if (!RUN_ID.test(a.run ?? '')) throw new Error('--run must be 1 to 24 of a-z and 0-9');
  checkGuild(a.guild);
  if (a.lane.length === 0) throw new Error('at least one --lane NAME=URL is needed');
  const lanes = a.lane.map((/** @type {string} */ spec, /** @type {number} */ index) => {
    const eq = spec.indexOf('=');
    const name = spec.slice(0, eq);
    if (eq < 0 || !LANE_NAME.test(name)) throw new Error(`--lane ${spec}: NAME must be 1 to 12 of a-z and 0-9`);
    return { name, base: checkBase(spec.slice(eq + 1)), index };
  });
  if (new Set(lanes.map((/** @type {{ name: string }} */ l) => l.name)).size !== lanes.length) throw new Error('lane names must differ');
  const run = /** @type {string} */ (a.run);
  const guild = /** @type {string} */ (a.guild);
  const duration = num(a.duration, 'duration', 1800);
  const rate = num(a.rate, 'rate', 1.5);
  const hotCount = Math.floor(num(a.hot, 'hot', 3));
  const hotRatio = num(a['hot-ratio'], 'hot-ratio', 0.3);
  const deleteRatio = num(a['delete-ratio'], 'delete-ratio', 0.1);
  const readEvery = Math.floor(num(a['read-every'], 'read-every', 5));
  const maxSize = Math.floor(num(a['max-size'], 'max-size', 8000));
  const maxBody = Math.floor(num(a['max-body'], 'max-body', 10000));
  const burst = Math.max(1, num(a.burst, 'burst', 4));
  const limiterSpec = a.limiter ?? LIMITER;
  const timeoutMs = num(a.timeout, 'timeout', 20000);
  const marksEvery = Math.max(1, num(a['marks-every'], 'marks-every', 50));
  const seed = a.seed !== undefined ? Math.floor(num(a.seed, 'seed', 0)) : Math.floor(Math.random() * 2 ** 31);
  const sharedRatio = sharedIds.length > 0 ? num(a['shared-ratio'], 'shared-ratio', 0.2) : 0;
  if (rate <= 0) throw new Error('--rate must be above 0');
  if (hotRatio + deleteRatio + sharedRatio > 1) throw new Error('--hot-ratio, --delete-ratio and --shared-ratio together must stay at or under 1');
  // One bucket per node: lanes that target the same node share its limit.
  /** @type {Map<string, Bucket>} */
  const buckets = new Map();
  for (const l of lanes) if (!buckets.has(l.base)) buckets.set(l.base, bucket(limiterSpec));

  const frame = writerFrame('write', a.log);
  const { writeAll, emit, clock, stop, cut, openWindows, sleep } = frame;
  let seq = 0;
  /** @type {Record<string, any>} */
  const counts = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0, reads: 0, readErrors: 0 };
  // The shared writes' own counts: the guild checks count only the guild lines.
  /** @type {Record<string, number>} */
  const sharedCounts = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0, reads: 0, readErrors: 0 };
  if (sharedIds.length > 0) counts.shared = sharedCounts;

  const startLine = {
    t: 'start', v: LOG_VERSION, run, guild, module: MODULE, seed, startedAt: new Date().toISOString(),
    lanes: lanes.map((/** @type {{ name: string, base: string }} */ l) => ({ name: l.name, route: 'operator', base: l.base })),
    settings: {
      duration, rate, hotCount, hotRatio, deleteRatio, readEvery, maxSize, maxBody, burst, limiter: limiterSpec, timeoutMs, marksEvery,
      ...(sharedIds.length > 0 ? { shared: sharedIds, sharedRatio } : {}),
    },
  };
  writeAll(sink => ({ ...startLine, sink }));

  /**
   * Shortens the payload until the request fits the body limit.
   * @template {{ pad: string }} T
   * @param {string} key
   * @param {T} content
   * @returns {T}
   */
  const fit = (key, content) => {
    const bytes = () => Buffer.byteLength(JSON.stringify({ file: fileId(key), guildId: guild, data: content }));
    while (bytes() > maxBody && content.pad.length > 0) {
      const chars = Array.from(content.pad);
      content.pad = chars.slice(0, Math.floor(chars.length * 0.9)).join('');
    }
    return content;
  };

  /** A token for this lane's node, or false once the writer is stopping. @param {{ base: string }} lane */
  const ready = lane => frame.ready(/** @type {Bucket} */ (buckets.get(lane.base)));

  /**
   * The loadedSha a guild write sends, as the editor gets it: the sha of the node's read, 'absent' when the read
   * finds no file. A failed read gives none, and the route refuses that write with a 400 (definite, nothing applied).
   * @param {{ name: string, base: string }} lane @param {string} key @returns {Promise<string | undefined>}
   */
  const baseSha = async (lane, key) => {
    const r = await call('GET', readUrl(lane.base, guild, key), undefined, timeoutMs, cut.signal);
    if (r.status === 429) buckets.get(lane.base)?.empty();
    if (r.status === 404) return 'absent';
    return r.status === 200 && r.body && typeof r.body.sha === 'string' ? r.body.sha : undefined;
  };

  /**
   * @param {{ name: string, base: string }} lane
   * @param {{ op: 'write' | 'delete', kind: 'u' | 'h', key: string, c: number, content?: object }} op
   * @returns {Promise<Answer | null>} null when stopped before sending
   */
  const send = async (lane, op) => {
    if (!(await ready(lane))) return null;
    const reads = op.op === 'write' && op.kind === 'h';
    if (reads && !(await ready(lane))) return null;
    const id = ++seq;
    const h = op.content ? hashOf(op.content) : null;
    const size = op.content ? canonical(op.content).length : 0;
    // Hot docs are small and logged whole, so an older version can be put back to prove ROLLBACK bites.
    const logged = op.kind === 'h' ? { content: op.content } : {};
    emit({ t: 'send', id, lane: lane.name, op: op.op, kind: op.kind, key: op.key, c: op.c, h, size, ...logged, at: clock() });
    const loadedSha = reads ? await baseSha(lane, op.key) : op.op === 'write' ? 'absent' : undefined;
    const r = op.op === 'write'
      ? await call('POST', `${lane.base}/api/config/data/update`, { file: fileId(op.key), guildId: guild, data: op.content, loadedSha }, timeoutMs, cut.signal)
      : await call('POST', `${lane.base}/api/config/data/delete`, { file: fileId(op.key), guildId: guild }, timeoutMs, cut.signal);
    if (r.status === 429) buckets.get(lane.base)?.empty();
    const answer = classifyAnswer(r.status, r.body, 'data');
    counts[answer.cls] += 1;
    const err = r.err ?? (r.body && typeof r.body.error === 'string' ? r.body.error.slice(0, 200) : undefined);
    const remote = r.body !== null && typeof r.body === 'object' && typeof r.body.servedBy === 'string' ? { remote: true } : {};
    emit({ t: 'ans', id, at: clock(), status: r.status, cls: answer.cls, definite: answer.definite, err, date: r.date, ...remote });
    return answer;
  };

  /**
   * @param {{ name: string, base: string }} lane @param {string} key @param {'u' | 'h'} kind
   * @returns {Promise<DocState | null>} null when stopped before reading
   */
  const readBack = async (lane, key, kind) => {
    if (!(await ready(lane))) return null;
    const id = ++seq;
    const at0 = clock();
    const r = await call('GET', readUrl(lane.base, guild, key), undefined, timeoutMs, cut.signal);
    if (r.status === 429) buckets.get(lane.base)?.empty();
    const state = docStateOf(r);
    counts.reads += 1;
    if (state.s === 'error') counts.readErrors += 1;
    // The lane the served content names goes under `by`, so it cannot replace the reading lane.
    const served = state.s === 'present' ? { s: state.s, h: state.h, by: state.lane, c: state.c } : state;
    emit({ t: 'read', id, lane: lane.name, key, kind, at0, at1: clock(), ...served });
    return state;
  };

  /**
   * One shared write (NB6): the file is read through the lane's node, and the new content names the hash of what was
   * read (`prev`) and goes with the read's sha as loadedSha, the base the bot compares before it stores. The checker
   * follows the chain of `prev` links.
   * @param {{ name: string, base: string }} lane @param {string} key @param {number} c @param {() => number} rand
   * @returns {Promise<Answer | 'skipped' | null>} null when stopped, 'skipped' when the read gave no base to build on
   */
  const sharedWrite = async (lane, key, c, rand) => {
    if (!(await ready(lane))) return null;
    const readId = ++seq;
    const at0 = clock();
    const r = await call('GET', `${lane.base}/api/config/data/get?file=${encodeURIComponent(key)}`, undefined, timeoutMs, cut.signal);
    if (r.status === 429) buckets.get(lane.base)?.empty();
    const ok = r.status === 200 && r.body && r.body.success === true && typeof r.body.sha === 'string';
    sharedCounts.reads += 1;
    if (!ok) {
      sharedCounts.readErrors += 1;
      emit({ t: 'shared-read', id: readId, lane: lane.name, key, at0, at1: clock(), s: 'error', err: r.err ?? `${r.status} ${r.body && r.body.error ? String(r.body.error).slice(0, 200) : ''}`.trim() });
      return 'skipped';
    }
    const exists = r.body.exists !== false;
    const prev = exists ? hashOf(r.body.data) : null;
    emit({ t: 'shared-read', id: readId, lane: lane.name, key, at0, at1: clock(), s: exists ? 'present' : 'absent', ...(prev ? { h: prev } : {}), sha: r.body.sha });
    const content = { run, lane: lane.name, kind: 's', key, c, prev, pad: padding(rand, Math.min(maxSize, HOT_MAX_SIZE)) };
    const bytes = () => Buffer.byteLength(JSON.stringify({ file: key, data: content, loadedSha: r.body.sha }));
    while (bytes() > maxBody && content.pad.length > 0) content.pad = Array.from(content.pad).slice(0, Math.floor(Array.from(content.pad).length * 0.9)).join('');
    if (!(await ready(lane))) return null;
    const id = ++seq;
    // Logged whole: the checker follows `prev` and a person can put a version back.
    emit({ t: 'shared-send', id, lane: lane.name, key, c, h: hashOf(content), prev, base: r.body.sha, size: canonical(content).length, content, at: clock() });
    const w = await call('POST', `${lane.base}/api/config/data/update`, { file: key, data: content, loadedSha: r.body.sha }, timeoutMs, cut.signal);
    if (w.status === 429) buckets.get(lane.base)?.empty();
    const answer = classifyAnswer(w.status, w.body, 'data');
    sharedCounts[answer.cls] += 1;
    const err = w.err ?? (w.body && typeof w.body.error === 'string' ? w.body.error.slice(0, 200) : undefined);
    emit({ t: 'shared-ans', id, at: clock(), status: w.status, cls: answer.cls, definite: answer.definite, err, date: w.date });
    return answer;
  };

  /** @param {{ name: string, base: string, index: number }} lane */
  const runLane = async lane => {
    const rand = prng((seed ^ Math.imul(lane.index + 1, 0x9e3779b1)) >>> 0);
    /** @type {Map<string, number>} */
    const hotCounters = new Map();
    /** @type {Map<string, number>} */
    const sharedCounters = new Map();
    /** @type {string[]} */
    const deletable = [];
    /** @type {string[]} */
    const acked = [];
    /** @type {Map<string, string>} */
    const ackedHash = new Map();
    let n = 0;
    let sinceRead = 0;
    let readHot = true;
    // One request per tick, reads included, so --rate is what the node sees.
    while (!stop.signal.aborted) {
      if (readEvery > 0 && sinceRead >= readEvery && (hotCount > 0 || acked.length > 0)) {
        sinceRead = 0;
        const hot = hotCount > 0 && (readHot || acked.length === 0);
        readHot = !readHot;
        const key = hot ? hotKey(run, Math.floor(rand() * hotCount)) : acked[Math.floor(rand() * acked.length)];
        if ((await readBack(lane, key, hot ? 'h' : 'u')) === null) break;
      } else {
        sinceRead += 1;
        const pick = rand();
        if (pick < deleteRatio && deletable.length > 0) {
          const key = deletable.splice(Math.floor(rand() * deletable.length), 1)[0];
          // The bot answers 200 to a delete of a doc that is already gone, so
          // a loss before the delete would hide behind it: read it first, and
          // delete only the doc as written.
          const seen = await readBack(lane, key, 'u');
          if (seen === null) break;
          if (seen.s === 'present' && seen.h === ackedHash.get(key)) {
            if ((await send(lane, { op: 'delete', kind: 'u', key, c: 0 })) === null) break;
          }
        } else if (hotCount > 0 && pick < deleteRatio + hotRatio) {
          const key = hotKey(run, Math.floor(rand() * hotCount));
          const c = (hotCounters.get(key) ?? 0) + 1;
          const content = fit(key, { run, lane: lane.name, kind: 'h', key, c, pad: padding(rand, Math.min(maxSize, HOT_MAX_SIZE)) });
          if ((await send(lane, { op: 'write', kind: 'h', key, c, content })) === null) break;
          hotCounters.set(key, c);
        } else if (sharedIds.length > 0 && pick >= deleteRatio + hotRatio && pick < deleteRatio + hotRatio + sharedRatio) {
          const key = sharedIds[Math.floor(rand() * sharedIds.length)];
          const c = (sharedCounters.get(key) ?? 0) + 1;
          const answer = await sharedWrite(lane, key, c, rand);
          if (answer === null) break;
          if (answer !== 'skipped') sharedCounters.set(key, c);
        } else {
          const key = uniqueKey(run, lane.name, n + 1);
          const content = fit(key, { run, lane: lane.name, kind: 'u', key, c: n + 1, pad: padding(rand, maxSize) });
          const answer = await send(lane, { op: 'write', kind: 'u', key, c: n + 1, content });
          if (answer === null) break;
          n += 1;
          // Only a committed doc is deleted later, so its delete follows a known write.
          if (answer.cls === 'ACKED') {
            deletable.push(key);
            acked.push(key);
            ackedHash.set(key, hashOf(content));
          }
        }
      }
      // Inside a marked window the lane runs --burst times faster, as far as
      // the limiter's reserve allows.
      const interval = 1000 / rate / (openWindows.length > 0 ? burst : 1);
      await sleep(interval * (0.5 + rand()));
    }
  };

  await runFrame(frame, { marks: a.marks, marksEvery, duration }, () => ({ counts }), () => Promise.all(lanes.map(runLane)));
}

/**
 * What `write` and `act` share: the log sinks, the clock, the stop and the windows the marks file has open.
 * @param {string} command
 * @param {string[]} targets
 */
function writerFrame(command, targets) {
  // A file log gets each line before the request it names goes out, so it
  // holds every request even if the writer is killed. A stream (stdout) can
  // be cut on its way, so the checker refuses one with no end line.
  const sinks = (targets.length > 0 ? targets : ['-']).map(target => ({ write: openOut(target), sink: target === '-' ? 'stream' : 'file' }));
  // A line that cannot be written ends the writer at once: no lane goes on,
  // nothing follows the half line, and no end line can claim a whole log.
  /** @param {(sink: string) => object} lineFor */
  const writeAll = lineFor => {
    try {
      for (const s of sinks) s.write(lineFor(s.sink));
    } catch (error) {
      console.error(`oracle ${command}: a log line could not be written, so the writer stops at once: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(64);
    }
  };
  const emit = (/** @type {object} */ event) => writeAll(() => event);
  const clock = () => Math.round(performance.now() * 1000) / 1000;
  // stop: no new requests; cut: in-flight requests end, logged as unknown.
  const stop = new AbortController();
  const cut = new AbortController();
  const halt = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    setTimeout(() => cut.abort(), STOP_GRACE_MS).unref();
  };
  /** @type {string[]} */
  const openWindows = [];
  /** @param {number} ms */
  const sleep = async ms => {
    try {
      await delay(ms, undefined, { signal: stop.signal });
    } catch {
      // stopped
    }
  };
  /** A token from the node's bucket, or false once the writer is stopping. @param {Bucket} limit */
  const ready = async limit => {
    // Checked first: a bucket with tokens left answers at once without looking at the signal.
    if (stop.signal.aborted) return false;
    try {
      await limit.take(stop.signal);
      return true;
    } catch {
      return false;
    }
  };
  return { writeAll, emit, clock, stop, cut, halt, openWindows, sleep, ready };
}

/**
 * Runs a writer's lanes until they stop, with the marks file polled, the stop signals and --duration, then writes the
 * end line.
 * @param {ReturnType<typeof writerFrame>} frame
 * @param {{ marks?: string, marksEvery: number, duration: number }} opts
 * @param {() => object} endFields
 * @param {() => Promise<unknown>} runLanes
 */
async function runFrame(frame, opts, endFields, runLanes) {
  const { emit, clock, halt, openWindows } = frame;
  const { marksEvery, duration } = opts;
  /** @type {NodeJS.Timeout | undefined} */
  let marksTimer;
  let pollMarks = () => {};
  if (opts.marks) {
    const marksFile = opts.marks;
    if (!fs.existsSync(marksFile)) fs.writeFileSync(marksFile, '');
    let offset = fs.statSync(marksFile).size;
    let partial = '';
    pollMarks = () => {
      const size = fs.statSync(marksFile).size;
      if (size <= offset) return;
      const fd = fs.openSync(marksFile, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      const lines = (partial + buf.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      for (const raw of lines) {
        const label = raw.trim();
        if (label === '') continue;
        // A stop that needs no signal, so it works the same on every host (Windows cannot send one to node).
        if (label === 'stop') {
          halt();
          continue;
        }
        const m = MARK.exec(label);
        if (!m) console.error(`mark "${label}" is not "begin NAME", "end NAME" or "stop": the checker will call the run inconclusive`);
        if (m && m[1] === 'begin') openWindows.push(m[2]);
        if (m && m[1] === 'end') {
          const i = openWindows.indexOf(m[2]);
          if (i >= 0) openWindows.splice(i, 1);
        }
        emit({ t: 'mark', label, at: clock() });
      }
    };
    marksTimer = setInterval(pollMarks, marksEvery);
  }

  const finish = () => {
    // An end mark written just before the stop is not lost between two polls.
    pollMarks();
    emit({ t: 'end', at: clock(), endedAt: new Date().toISOString(), ...endFields() });
  };
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    // Every request sent so far is in each file log and none follows the
    // exit, so a file log stays complete: its unanswered requests read as
    // unknown. A stream may lose its last lines, end line included.
    if (signals > 1) {
      finish();
      process.exit(130);
    }
    halt();
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  /** @type {NodeJS.Timeout | undefined} */
  const timer = duration > 0 ? setTimeout(halt, duration * 1000) : undefined;

  await runLanes();
  if (timer) clearTimeout(timer);
  if (marksTimer) clearInterval(marksTimer);
  finish();
  for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
}

/**
 * The nonce one action carries (NB15 test 12): a panel button sends it after a colon in its button id, an invoke as
 * a command option. It starts with `act_`, which no run's `<run>-` prefix can match, so the guild listing never
 * holds an action's docs.
 * @param {string} run @param {string} lane @param {number} n
 */
export const actionNonce = (run, lane, n) => `act_${run}_${lane}_${n}`;
/** A doc the oracle's action module saves for one run of an action: `<nonce>.<tag>.json`, one per run. */
export const ACTION_DOC = /^(act_[a-z0-9]+_[a-z0-9]+_\d+)\.[A-Za-z0-9_-]+\.json$/;
const PANEL_ID = /^[a-zA-Z0-9._-]{1,99}$/;
const BUTTON_ID = /^[a-zA-Z0-9._\-/:]{1,100}$/;
const COMMAND = /^[\w-]{1,64}$/;
const OPTION = /^[a-z0-9_-]{1,32}$/;

/**
 * The listing of one run's action docs, one {"k": filename, "d": doc} line per row under `psql -At`: the input
 * check.mjs takes as --actions.
 * @param {string} guild
 * @param {string} run
 */
export function actionsSql(guild, run) {
  if (!/^\d{5,20}$/.test(guild) || !RUN_ID.test(run)) throw new Error('actionsSql needs a guild id and a run id');
  const prefix = `act_${run}_`;
  return `SELECT json_build_object('k', filename, 'd', doc) FROM smdb_data.guild_data WHERE guild_id = '${guild}' AND module = '${MODULE}' AND left(filename, ${prefix.length}) = '${prefix}' ORDER BY filename`;
}

const ACT_USAGE = `oracle.mjs act --run ID --guild ID --lane NAME=URL [--lane NAME=URL ...] --panel ID --button ID --command NAME
  [--option NAME (nonce)] [--channel ID] [--button-ratio R (0.5)] [--duration S (600, 0 = until stopped)]
  [--rate ACTIONS_PER_S (0.5, per lane)] [--seed N] [--marks FILE] [--marks-every MS (50)] [--burst X (4)]
  [--limiter CAPACITY/MS (${LIMITER}) | off] [--timeout MS (100000)] [--log FILE (- = stdout, the default; may repeat)]`;

/**
 * NB15 test 12: panel button presses and command invokes through each lane's web UI, for a guild another bot process
 * may hold, each answer classed by the panel and invoke routes' rule (classifyAnswer's 'panel' route).
 * @param {string[]} argv
 */
async function act(argv) {
  const a = parseArgs(argv, {
    run: 'one', guild: 'one', lane: 'many', panel: 'one', button: 'one', command: 'one', option: 'one', channel: 'one',
    'button-ratio': 'one', duration: 'one', rate: 'one', seed: 'one', marks: 'one', 'marks-every': 'one', burst: 'one',
    limiter: 'one', timeout: 'one', log: 'many',
  });
  if (!RUN_ID.test(a.run ?? '')) throw new Error('--run must be 1 to 24 of a-z and 0-9');
  checkGuild(a.guild);
  if (!PANEL_ID.test(a.panel ?? '')) throw new Error('--panel must be a panel id');
  if (!BUTTON_ID.test(a.button ?? '')) throw new Error('--button must be a button id of at most 100 characters');
  if (!COMMAND.test(a.command ?? '')) throw new Error('--command must be a command name');
  const option = a.option ?? 'nonce';
  if (!OPTION.test(option)) throw new Error('--option must be a command option name');
  if (a.channel !== undefined && !/^\d{17,19}$/.test(a.channel)) throw new Error('--channel must be a channel id');
  if (a.lane.length === 0) throw new Error('at least one --lane NAME=URL is needed');
  const lanes = a.lane.map((/** @type {string} */ spec, /** @type {number} */ index) => {
    const eq = spec.indexOf('=');
    const name = spec.slice(0, eq);
    if (eq < 0 || !LANE_NAME.test(name)) throw new Error(`--lane ${spec}: NAME must be 1 to 12 of a-z and 0-9`);
    return { name, base: checkBase(spec.slice(eq + 1)), index };
  });
  if (new Set(lanes.map((/** @type {{ name: string }} */ l) => l.name)).size !== lanes.length) throw new Error('lane names must differ');
  const run = /** @type {string} */ (a.run);
  const guild = /** @type {string} */ (a.guild);
  const duration = num(a.duration, 'duration', 600);
  const rate = num(a.rate, 'rate', 0.5);
  const buttonRatio = num(a['button-ratio'], 'button-ratio', 0.5);
  const burst = Math.max(1, num(a.burst, 'burst', 4));
  const limiterSpec = a.limiter ?? LIMITER;
  // Above the routes' own bound (a 30 s local wait plus T, 60 s): the route answers before the writer gives up.
  const timeoutMs = num(a.timeout, 'timeout', 100000);
  const marksEvery = Math.max(1, num(a['marks-every'], 'marks-every', 50));
  const seed = a.seed !== undefined ? Math.floor(num(a.seed, 'seed', 0)) : Math.floor(Math.random() * 2 ** 31);
  if (rate <= 0) throw new Error('--rate must be above 0');
  if (buttonRatio > 1) throw new Error('--button-ratio must stay at or under 1');
  /** @type {Map<string, Bucket>} */
  const buckets = new Map();
  for (const l of lanes) if (!buckets.has(l.base)) buckets.set(l.base, bucket(limiterSpec));

  const frame = writerFrame('act', a.log);
  const { writeAll, emit, clock, stop, cut, openWindows, sleep } = frame;
  let seq = 0;
  // The end line's guild counts stay zero: an act log holds no data write, and its own counts go under `act`.
  /** @type {Record<string, number>} */
  const actCounts = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0 };
  const counts = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0, reads: 0, readErrors: 0, act: actCounts };
  const startLine = {
    t: 'start', v: LOG_VERSION, mode: 'act', run, guild, module: MODULE, seed, startedAt: new Date().toISOString(),
    lanes: lanes.map((/** @type {{ name: string, base: string }} */ l) => ({ name: l.name, route: 'act', base: l.base })),
    settings: {
      duration, rate, buttonRatio, burst, limiter: limiterSpec, timeoutMs, marksEvery,
      panel: a.panel, button: a.button, command: a.command, option, ...(a.channel ? { channel: a.channel } : {}),
    },
  };
  writeAll(sink => ({ ...startLine, sink }));

  /** @param {{ name: string, base: string, index: number }} lane */
  const runLane = async lane => {
    const rand = prng((seed ^ Math.imul(lane.index + 1, 0x9e3779b1)) >>> 0);
    let n = 0;
    while (!stop.signal.aborted) {
      const kind = rand() < buttonRatio ? 'button' : 'invoke';
      if (!(await frame.ready(/** @type {Bucket} */ (buckets.get(lane.base))))) break;
      n += 1;
      const nonce = actionNonce(run, lane.name, n);
      const id = ++seq;
      const channel = a.channel ? { channelId: a.channel } : {};
      emit({ t: 'act-send', id, lane: lane.name, kind, nonce, at: clock() });
      const r = kind === 'button'
        ? await call('POST', `${lane.base}/api/panels/button`, { panelId: a.panel, buttonId: `${a.button}:${nonce}`, userId: 'web-ui-owner', guildId: guild, ...channel }, timeoutMs, cut.signal)
        : await call('POST', `${lane.base}/api/commands/invoke`, { command: a.command, guildId: guild, options: { [option]: nonce }, ...channel }, timeoutMs, cut.signal);
      if (r.status === 429) buckets.get(lane.base)?.empty();
      const answer = classifyAnswer(r.status, r.body, 'panel');
      actCounts[answer.cls] += 1;
      const b = r.body !== null && typeof r.body === 'object' ? r.body : {};
      const err = r.err ?? (typeof b.error === 'string' ? b.error.slice(0, 200) : undefined);
      emit({
        t: 'act-ans', id, at: clock(), status: r.status, cls: answer.cls, definite: answer.definite, err, date: r.date,
        ...(typeof b.code === 'string' ? { code: b.code } : {}), ...(typeof b.ran === 'boolean' ? { ran: b.ran } : {}),
        ...(typeof b.truth === 'string' ? { truth: b.truth } : {}),
      });
      const interval = 1000 / rate / (openWindows.length > 0 ? burst : 1);
      await sleep(interval * (0.5 + rand()));
    }
  };

  await runFrame(frame, { marks: a.marks, marksEvery, duration }, () => ({ counts }), () => Promise.all(lanes.map(runLane)));
}

/**
 * The run's keys and guild from writer logs.
 * @param {string[]} files
 */
function keysFromLogs(files) {
  if (files.length === 0) throw new Error('at least one --log is needed');
  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {Set<string>} */
  const runs = new Set();
  /** @type {Set<string>} */
  const guilds = new Set();
  /** @type {string[]} */
  const starts = [];
  /** @type {string[]} */
  const ends = [];
  let unended = false;
  for (const file of files) {
    let ended = false;
    for (const e of parseLog(fs.readFileSync(file, 'utf8'))) {
      if (e.t === 'start') {
        runs.add(e.run);
        guilds.add(e.guild);
        if (typeof e.startedAt === 'string') starts.push(e.startedAt);
      }
      if (e.t === 'end' && typeof e.endedAt === 'string') {
        ends.push(e.endedAt);
        ended = true;
      }
      if (e.t === 'send') keys.add(e.key);
    }
    if (!ended) unended = true;
  }
  if (runs.size !== 1 || guilds.size !== 1) throw new Error('the logs must hold exactly one run on one guild');
  const span = { from: starts.sort()[0] ?? null, to: unended ? null : ends.sort().at(-1) ?? null };
  return { keys: [...keys].sort(), run: [...runs][0], guild: [...guilds][0], span };
}

/** @param {string} what @param {number} count */
function announce(what, count) {
  console.error(`${what} ${count} docs at about 2 a second, the web UI's limit: about ${Math.ceil(count / 1.9 / 60)} min`);
}

/** @param {string[]} argv */
async function read(argv) {
  const a = parseArgs(argv, { log: 'many', target: 'one', name: 'one', out: 'one', limit: 'one', limiter: 'one', timeout: 'one' });
  if (!a.target || !a.name || !a.out) throw new Error('read needs --log, --target, --name and --out');
  const base = checkBase(a.target);
  const { keys, run, guild } = keysFromLogs(a.log);
  const timeoutMs = num(a.timeout, 'timeout', 20000);
  // An evenly spread sample when --limit is below the run's key count.
  const limit = Math.floor(num(a.limit, 'limit', keys.length));
  if (limit < 1) throw new Error('--limit must be 1 or more');
  const chosen = limit >= keys.length ? keys : Array.from({ length: limit }, (_, i) => keys[Math.floor((i * keys.length) / limit)]);
  const emit = openOut(a.out);
  emit({ t: 'copy', v: LOG_VERSION, kind: 'app', name: a.name, run, guild, base, at: new Date().toISOString(), keys: keys.length, sample: chosen.length < keys.length });
  announce(`reading from ${a.name}`, chosen.length);
  const limiter = bucket(a.limiter ?? LIMITER);
  let present = 0;
  let errors = 0;
  for (const k of chosen) {
    const state = docStateOf(await paced(limiter, () => call('GET', readUrl(base, guild, k), undefined, timeoutMs)));
    if (state.s === 'present') present += 1;
    if (state.s === 'error') errors += 1;
    emit({ k, ...state });
  }
  console.error(`read ${chosen.length} of ${keys.length} docs from ${a.name}: ${present} present, ${errors} unreadable`);
  if (errors > 0) process.exitCode = 1;
}

// Credentials in a URL (scheme://user:pass@host) never leave the host, even
// inside a field the reduction kept.
const URL_SECRET = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'@/]*@/gi;

/**
 * @typedef {{ initialized: boolean, nodeId: string | null, processId: string | null, shardCount: number | null,
 *   leases: { shardId: number, claim: number | null }[], shardTable: { shardId: number, nodeId: string | null, status: string | null }[],
 *   guildMap: Record<string, number>,
 *   reshard: { attempt: string, state: string, from: number, to: number } | null }} FleetFacts
 */

/**
 * The facts the control check needs, and nothing else: every other field of
 * the fleet state is dropped before the filter runs.
 * @param {any} state
 * @returns {FleetFacts}
 */
export function reduceFleetState(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    initialized: s.initialized === true,
    nodeId: typeof s.nodeId === 'string' ? s.nodeId : null,
    processId: typeof s.processId === 'string' && s.processId !== '' ? s.processId : null,
    shardCount: typeof s.shardCount === 'number' ? s.shardCount : null,
    leases: Array.isArray(s.leases)
      ? s.leases.map((/** @type {any} */ l) => ({ shardId: l.shardId, claim: typeof l.claim === 'number' ? l.claim : null }))
      : [],
    shardTable: Array.isArray(s.shardTable)
      ? s.shardTable.map((/** @type {any} */ r) => ({ shardId: r.shardId, nodeId: r.nodeId ?? null, status: r.status ?? null }))
      : [],
    guildMap: s.guildMap && typeof s.guildMap === 'object' ? s.guildMap : {},
    reshard: s.reshard && typeof s.reshard === 'object' && typeof s.reshard.attempt === 'string'
      ? { attempt: s.reshard.attempt, state: String(s.reshard.state), from: Number(s.reshard.from), to: Number(s.reshard.to) }
      : null,
  };
}

/** @param {string[]} argv */
async function fleet(argv) {
  const a = parseArgs(argv, { target: 'one', name: 'one', out: 'one', limiter: 'one', timeout: 'one' });
  if (!a.target || !a.name || !a.out) throw new Error('fleet needs --target, --name and --out');
  const r = await paced(bucket(a.limiter ?? LIMITER), () => call('GET', `${checkBase(a.target)}/api/fleet/state`, undefined, num(a.timeout, 'timeout', 20000)));
  if (r.status !== 200 || !r.body) throw new Error(`fleet state unreadable: ${r.err ?? r.status}`);
  const facts = reduceFleetState(r.body);
  const text = JSON.stringify({ t: 'fleet', v: LOG_VERSION, name: a.name, at: new Date().toISOString(), state: facts })
    .replace(URL_SECRET, '<redacted>@');
  if (a.out === '-') process.stdout.write(`${text}\n`);
  else fs.writeFileSync(a.out, `${text}\n`, { flag: 'wx' });
  if (!facts.initialized) {
    console.error(`${a.name} answered without a fleet state (its bot child is down or did not answer): the checker will call the run inconclusive`);
    process.exitCode = 1;
  }
}

/**
 * One machine's mirror files of the run's shared files, read from its data folder (NB6): the input check.mjs takes as
 * --mirror. Run it on the machine, with its /data mounted read-only, after the bound the checker names.
 * @param {string[]} argv
 */
async function mirror(argv) {
  const a = parseArgs(argv, { log: 'many', data: 'one', name: 'one', out: 'one' });
  if (a.log.length === 0 || !a.data || !a.name || !a.out) throw new Error('mirror needs --log, --data (the machine\'s /data), --name and --out');
  const logs = a.log.map((/** @type {string} */ f) => parseLog(fs.readFileSync(f, 'utf8')));
  const runs = new Set(logs.flatMap((/** @type {any[]} */ events) => events.filter(e => e.t === 'start').map(e => e.run)));
  if (runs.size !== 1) throw new Error('the logs must hold exactly one run');
  const ids = sharedIdsOf(logs);
  if (ids.length === 0) throw new Error('the logs name no shared file');
  const emit = openOut(a.out);
  emit({ t: 'copy', v: LOG_VERSION, kind: 'mirror', name: a.name, run: [...runs][0], at: new Date().toISOString(), keys: ids.length });
  let errors = 0;
  for (const id of ids) {
    const state = mirrorState(path.join(a.data, 'global', ...id.split('/')));
    if (state.s === 'error') errors += 1;
    emit({ k: id, ...state });
  }
  console.error(`read ${ids.length} shared files from ${a.name}'s mirror: ${errors} unreadable`);
  if (errors > 0) process.exitCode = 1;
}

/** @param {string[]} argv */
async function cleanup(argv) {
  const a = parseArgs(argv, { log: 'many', target: 'one', limiter: 'one', timeout: 'one' });
  if (!a.target) throw new Error('cleanup needs --log and --target (the bot)');
  const base = checkBase(a.target);
  const { keys, guild } = keysFromLogs(a.log);
  const timeoutMs = num(a.timeout, 'timeout', 20000);
  announce('deleting', keys.length);
  const limiter = bucket(a.limiter ?? LIMITER);
  /** @type {Record<string, number>} */
  const tally = {};
  for (const key of keys) {
    const r = await paced(limiter, () => call('POST', `${base}/api/config/data/delete`, { file: fileId(key), guildId: guild }, timeoutMs));
    const cls = classifyAnswer(r.status, r.body, 'data').cls;
    tally[cls] = (tally[cls] ?? 0) + 1;
  }
  console.error(`cleanup of ${keys.length} docs: ${JSON.stringify(tally)}`);
  if (Object.keys(tally).some(cls => cls !== 'ACKED')) process.exitCode = 1;
}

/**
 * The claim sequence listing, one line under `psql -At`: claim_seq's
 * last_value and is_called, the highest guild_ownership claim and the highest
 * shard_claims claim (each null when none). The input check.mjs takes as
 * --ownership.
 */
export function ownershipSql() {
  return `SELECT json_build_object('last', s.last_value, 'called', s.is_called, 'highest', (SELECT max(claim) FROM smdb_data.guild_ownership), 'claims', (SELECT max(claim) FROM smdb_data.shard_claims)) FROM smdb_data.claim_seq s`;
}

/**
 * The shard claims listing, one line under `psql -At` (jsonb prints no line
 * breaks): every shard_claims row of every count. The input check.mjs takes
 * as --claims.
 */
export function claimsSql() {
  return `SELECT jsonb_build_object('rows', COALESCE(jsonb_agg(jsonb_build_object('count', shard_count, 'shard', shard_id, 'claim', claim, 'process', holder_process, 'released', released) ORDER BY shard_count, shard_id), '[]'::jsonb)) FROM smdb_data.shard_claims`;
}

/**
 * The reshard listing, one line under `psql -At`, read in one snapshot: the
 * reshard row's attempt with the count of shard_claims rows of its from_count,
 * and meta 'shard_count'. The input check.mjs takes as --reshard (NB9 22).
 */
export function reshardSql() {
  return `SELECT jsonb_build_object('rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('attempt', r.attempt::text, 'state', r.state, 'from', r.from_count, 'to', r.to_count, 'fromRows', (SELECT count(*) FROM smdb_data.shard_claims c WHERE c.shard_count = r.from_count)) ORDER BY r.id) FROM smdb_data.reshard r WHERE r.attempt IS NOT NULL), '[]'::jsonb), 'meta', (SELECT (m.value::jsonb ->> 'count')::int FROM smdb_data.meta m WHERE m.key = 'shard_count'))`;
}

export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * One snapshot of the request rows of one run, one line per
 * smdb_data.guild_requests row of a write or a delete of the run's docs under
 * `psql -At`: its id, op and state, the body's filename ("k") and contentJson
 * ("c", null for a delete), whether a holder took it ("taken") and the
 * holder's reply; then one line with the database's time ("snapshot") and the
 * count of row lines ("rows"). A holder's claim empties the body (NB15
 * decision 16), so a row a holder took is listed with "k" and "c" null when it
 * was made inside the run's span (the logs' first start and last end, 30 s
 * either side for the clocks of two hosts; no end bounds nothing). The
 * cleanup deletes an answered row 2 minutes after its answer, so the snapshots
 * are taken every 30 s during the run and once at its end, appended to one
 * file: the input check.mjs takes as --requests.
 * @param {string} guild
 * @param {string} run
 * @param {{ from: string | null, to: string | null }} span
 */
export function requestsSql(guild, run, span) {
  if (!/^\d{5,20}$/.test(guild) || !RUN_ID.test(run)) throw new Error('requestsSql needs a guild id and a run id');
  if (!span || typeof span.from !== 'string' || !ISO_TIME.test(span.from) || (span.to !== null && (typeof span.to !== 'string' || !ISO_TIME.test(span.to)))) {
    throw new Error("requestsSql needs the run's span: the start line's startedAt and the end line's endedAt or null");
  }
  const prefix = `${run}-`;
  const field = (/** @type {string} */ name) => `(r.b ->> '${name}')`;
  const ours = `${field('module')} = '${MODULE}' AND left(${field('filename')}, ${prefix.length}) = '${prefix}'`;
  const inSpan = `r.created_at >= '${span.from}'::timestamptz - interval '30 seconds'${span.to === null ? '' : ` AND r.created_at <= '${span.to}'::timestamptz + interval '30 seconds'`}`;
  const rows = `SELECT r.created_at, r.id, json_build_object('id', r.id, 'op', r.op, 'state', r.state, 'k', ${field('filename')}, 'c', ${field('contentJson')}, 'taken', r.taken_at IS NOT NULL, 'reply', r.reply) AS line FROM (SELECT q.*, NULLIF(q.body, '')::jsonb AS b FROM smdb_data.guild_requests q WHERE q.guild_id = '${guild}' AND q.op IN ('write', 'delete')) r WHERE (r.b IS NOT NULL AND ${ours}) OR (r.b IS NULL AND r.taken_at IS NOT NULL AND ${inSpan})`;
  const snapshot = `json_build_object('snapshot', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'rows', (SELECT count(*) FROM l))`;
  return `WITH l AS (${rows}) SELECT s.line FROM (SELECT 0 AS o, l.created_at, l.id, l.line FROM l UNION ALL SELECT 1, NULL, NULL, ${snapshot}) s ORDER BY s.o, s.created_at, s.id`;
}

/** @param {string[]} argv */
async function sql(argv) {
  if (argv.length === 1 && argv[0] === 'ownership') {
    process.stdout.write(`${ownershipSql()}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === 'claims') {
    process.stdout.write(`${claimsSql()}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === 'reshard') {
    process.stdout.write(`${reshardSql()}\n`);
    return;
  }
  if (argv[0] === 'shared') {
    const r = parseArgs(argv.slice(1), { log: 'many' });
    if (r.log.length === 0) throw new Error('sql shared needs --log');
    process.stdout.write(`${sharedDumpSql(sharedIdsOf(r.log.map((/** @type {string} */ f) => parseLog(fs.readFileSync(f, 'utf8')))))}\n`);
    return;
  }
  if (argv[0] === 'actions') {
    const r = parseArgs(argv.slice(1), { log: 'many' });
    const { run, guild } = keysFromLogs(r.log);
    process.stdout.write(`${actionsSql(guild, run)}\n`);
    return;
  }
  if (argv[0] === 'requests') {
    const r = parseArgs(argv.slice(1), { log: 'many' });
    const { run, guild, span } = keysFromLogs(r.log);
    process.stdout.write(`${requestsSql(guild, run, span)}\n`);
    return;
  }
  const a = parseArgs(argv, { log: 'many' });
  const { run, guild } = keysFromLogs(a.log);
  process.stdout.write(`${dumpSql(guild, run)}\n`);
}

/**
 * The bite test's two tamperings (VERIFY.md 5.5), as SQL against a judged
 * copy: delete one acknowledged unique doc (the checker must say LOST) and
 * put back an older acknowledged version of a hot doc (ROLLBACK).
 * @param {any[][]} logs
 */
export function biteStatements(logs) {
  /** @type {Map<number, any>} */
  const answers = new Map();
  /** @type {any[]} */
  const sends = [];
  let guild = '';
  logs.forEach((events, log) => {
    for (const e of events) {
      if (e.t === 'start') guild = e.guild;
      if (e.t === 'ans') answers.set(log * 1e9 + e.id, e);
      if (e.t === 'send') sends.push({ ...e, log });
    }
  });
  const acked = (/** @type {any} */ s) => answers.get(s.log * 1e9 + s.id)?.cls === 'ACKED';
  const deleted = new Set(sends.filter(s => s.op === 'delete').map(s => s.key));
  const lost = sends.find(s => s.op === 'write' && s.kind === 'u' && acked(s) && !deleted.has(s.key));
  /** @type {Map<string, any[]>} */
  const byLaneKey = new Map();
  for (const s of sends) {
    if (s.op !== 'write' || s.kind !== 'h' || !acked(s) || !s.content) continue;
    const list = byLaneKey.get(`${s.lane} ${s.key}`) ?? [];
    list.push(s);
    byLaneKey.set(`${s.lane} ${s.key}`, list);
  }
  const pair = [...byLaneKey.values()].find(list => list.length >= 2);
  if (!lost || !pair) throw new Error('the logs need an acknowledged unique write and two acknowledged hot writes by one lane to one doc');
  const where = (/** @type {string} */ key) => `guild_id = '${guild}' AND module = '${MODULE}' AND filename = '${key}'`;
  const older = pair[pair.length - 2];
  const newer = pair[pair.length - 1];
  // Pretty-printed as the bot stores it; the dollar tag is one the text lacks.
  const text = JSON.stringify(older.content, null, 2);
  let tag = 'oracle';
  while (text.includes(`$${tag}$`)) tag += 'x';
  return {
    lost: { key: lost.key, expect: 'LOST', sql: `DELETE FROM smdb_data.guild_data WHERE ${where(lost.key)}` },
    rollback: {
      key: older.key, expect: 'ROLLBACK', lane: older.lane, from: newer.c, to: older.c,
      sql: `UPDATE smdb_data.guild_data SET doc = $${tag}$${text}$${tag}$ WHERE ${where(older.key)}`,
    },
  };
}

/** @param {string[]} argv */
async function bite(argv) {
  const a = parseArgs(argv, { log: 'many' });
  if (a.log.length === 0) throw new Error('bite needs --log');
  const b = biteStatements(a.log.map((/** @type {string} */ f) => parseLog(fs.readFileSync(f, 'utf8'))));
  process.stdout.write(`-- expect LOST on ${b.lost.key}\n${b.lost.sql};\n`);
  process.stdout.write(`-- expect ROLLBACK on ${b.rollback.key} (${b.rollback.lane} c=${b.rollback.from} back to c=${b.rollback.to})\n${b.rollback.sql};\n`);
}

const USAGE = `${WRITE_USAGE}
${ACT_USAGE}
oracle.mjs read --log FILE [--log FILE ...] --target URL --name COPY --out FILE [--limit N] [--limiter SPEC] [--timeout MS]
oracle.mjs fleet --target URL --name NODE --out FILE [--limiter SPEC] [--timeout MS]
oracle.mjs sql --log FILE      the psql query that lists the run's docs
oracle.mjs sql ownership       the psql query that lists the claim sequence and the highest stored claims
oracle.mjs sql claims          the psql query that lists shard_claims
oracle.mjs sql reshard         the psql query that lists the reshard attempt, its old rows and meta 'shard_count'
oracle.mjs sql requests --log FILE  the psql query that lists one snapshot of the run's rows of guild_requests
oracle.mjs sql actions --log FILE   the psql query that lists the docs an act run's actions saved
oracle.mjs sql shared --log FILE    the psql query that lists the run's shared files in smdb_data.shared_docs
oracle.mjs mirror --log FILE [--log FILE ...] --data DIR --name MACHINE --out FILE  one machine's mirror files of the run's shared files
oracle.mjs bite --log FILE     the bite test's two tamperings, as SQL
oracle.mjs cleanup --log FILE [--log FILE ...] --target URL [--limiter SPEC]`;

/** @param {string[]} argv */
export async function main(argv) {
  const [command, ...rest] = argv;
  const commands = { write, act, read, fleet, sql, mirror, bite, cleanup };
  const fn = /** @type {Record<string, (argv: string[]) => Promise<void>>} */ (commands)[command ?? ''];
  if (!fn) {
    console.error(USAGE);
    process.exitCode = 64;
    return;
  }
  try {
    await fn(rest);
  } catch (error) {
    console.error(`oracle ${command}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 64;
  }
}

// Run as a script (a path, or piped into `node -`), never when imported.
const entry = process.argv[1];
const invoked = entry === undefined || entry === '-' || path.resolve(entry) === fileURLToPath(import.meta.url);
if (invoked) await main(process.argv.slice(2));
