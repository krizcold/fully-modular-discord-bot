// Records which mutants a test file's run reaches, for the run with no mutant
// of pass A, in the fast tier, and that of pass B, in the integration and child
// tiers (mutation/README.md, "Which fast tests a mutant runs" and "Which tests
// a pass B mutant runs"). It is loaded
// first in the test file's process (helpers/mutationCoverage.ts) and, through
// NODE_OPTIONS, in every Node process that descends from it. Stryker's
// instrumented code counts each mutant in globalThis.__stryker__.mutantCoverage;
// this file puts its own object there first and appends each id to this
// process's record the first time it is counted, with one synchronous write,
// as tests and scenarios end children with SIGKILL and no exit handler runs.
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const { syncBuiltinESMExports } = require('module');
const path = require('path');
const workerThreads = require('worker_threads');

// Taken now: a test may replace them on the fs module.
const { mkdirSync, openSync, writeSync, writeFileSync } = fs;
const { createHash, randomBytes } = crypto;
const win = process.platform === 'win32';
const SELF = __filename.split(path.sep).join('/');
const PRELOAD = `--require "${SELF.replace(/["\\]/g, '\\$&')}"`;
const NAMES = ['NODE_OPTIONS', 'SMDB_MUTATION_REACH', 'SMDB_MUTATION_REACH_TOKEN'];
// Programs that run none of the tree's code and pass their environment on to what they start.
const LISTED = new Set(['fsutil', 'git', 'sync']);

/**
 * @typedef {'node' | 'listed' | 'worker' | 'other'} Kind
 * @typedef {{ dir: string, file: string, fd: number, failed: boolean }} Sink
 * @typedef {{ sinks: Sink[], seen: Set<string>, ours: WeakSet<object>, coverage: object | null, late: boolean, hooked: boolean, testFiles: number }} State
 */

/** @returns {State} one per process, whichever copy of this file loads first */
function shared() {
  const key = Symbol.for('smdb.reachRecorder');
  const g = /** @type {Record<symbol, State | undefined>} */ (/** @type {unknown} */ (globalThis));
  return g[key] ??= { sinks: [], seen: new Set(), ours: new WeakSet(), coverage: null, late: false, hooked: false, testFiles: 0 };
}
const state = shared();

/**
 * The name a test file's record dir starts with (mutation/reach.mjs fileKey makes the same).
 * @param {string} file
 */
function fileKey(file) {
  return createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32);
}

/**
 * @param {Sink} sink
 * @param {object} line
 */
function put(sink, line) {
  const text = `${JSON.stringify(line)}\n`;
  try {
    if (sink.failed) {
      writeSync(sink.fd, '{"failed":true}\n');
      sink.failed = false;
    }
    if (writeSync(sink.fd, text) !== Buffer.byteLength(text)) sink.failed = true;
  } catch {
    if (!sink.failed) try { writeFileSync(`${sink.file}.failed`, ''); } catch {}
    sink.failed = true;
  }
}

/** @param {string} id */
function note(id) {
  if (state.seen.has(id)) return;
  state.seen.add(id);
  for (const sink of state.sinks) put(sink, { id });
}

/**
 * @template {object} T
 * @param {T} target
 * @returns {T}
 */
function counts(target) {
  for (const key of Object.keys(target)) note(key);
  const proxy = new Proxy(target, {
    set(object, key, value) {
      try { if (typeof key === 'string') note(key); } catch {}
      try { /** @type {Record<PropertyKey, unknown>} */ (object)[key] = value; } catch {}
      return true;
    },
  });
  state.ours.add(proxy);
  return proxy;
}

function install() {
  try {
    const g = /** @type {{ __stryker__?: Record<string, unknown> }} */ (globalThis);
    const ns = g.__stryker__ || (g.__stryker__ = {});
    if (ns.mutantCoverage !== undefined) { state.late = true; return; }
    // `c = perTest[id] = perTest[id] || {}` counts into the `{}` itself, whatever a set stores, so a test id never
    // reads as missing: its first read stores a recording object.
    const perTest = new Proxy({}, {
      get(object, key) {
        const table = /** @type {Record<PropertyKey, unknown>} */ (object);
        try { if (typeof key === 'string' && !Object.hasOwn(table, key)) table[key] = counts({}); } catch {}
        return table[key];
      },
      set(object, key, value) {
        try {
          /** @type {Record<PropertyKey, unknown>} */ (object)[key] = value !== null && typeof value === 'object' && !state.ours.has(value) ? counts(value) : value;
        } catch {}
        return true;
      },
    });
    ns.mutantCoverage = state.coverage = { static: counts({}), perTest };
  } catch {
    state.late = true;
  }
}

/** True when the namespace no longer holds this file's object, so counts may go where it cannot see them. */
function late() {
  try {
    return state.late || /** @type {{ __stryker__?: { mutantCoverage?: unknown } }} */ (globalThis).__stryker__?.mutantCoverage !== state.coverage;
  } catch {
    return true;
  }
}

/**
 * Opens this process's record in `dir` and writes what it has seen so far.
 * @param {string} dir
 * @param {Record<string, unknown>} header
 */
function openSink(dir, header) {
  const file = path.join(dir, `${process.pid}-${randomBytes(8).toString('hex')}.jsonl`);
  let fd;
  try {
    mkdirSync(dir, { recursive: true });
    fd = openSync(file, 'ax');
  } catch {
    // A child that inherits the token would answer for this process's start, so none may; the marker says why.
    try { delete process.env.SMDB_MUTATION_REACH_TOKEN; } catch {}
    try { writeFileSync(`${file}.failed`, ''); } catch {}
    return;
  }
  const sink = { dir, file, fd, failed: false };
  put(sink, { ...header, pid: process.pid, late: late() });
  for (const id of state.seen) put(sink, { id });
  state.sinks.push(sink);
}

/**
 * The record lines of one start, written before it; the env names the newest record's dir, so an older one (a test
 * file's process that is also a child of another's) cannot follow it and says so.
 * @param {Kind} kind
 * @returns {{ token: string, dir: string } | null}
 */
function started(kind) {
  const last = state.sinks.at(-1);
  if (!last) return null;
  let token = '';
  try { token = randomBytes(8).toString('hex'); } catch { token = `${process.pid}-${Date.now()}-${Math.random()}`; }
  for (const sink of state.sinks) put(sink, sink === last ? { start: token, kind } : { start: token, kind, elsewhere: true });
  return { token, dir: last.dir };
}

/**
 * @param {string} file
 * @returns {Kind}
 */
function kindOfName(file) {
  if (file === process.execPath) return 'node';
  let name = /** @type {string} */ (file.split(win ? /[\\/]/ : '/').pop());
  if (win) {
    name = name.toLowerCase();
    if (name.endsWith('.exe')) name = name.slice(0, -4);
  }
  return name === 'node' ? 'node' : LISTED.has(name) ? 'listed' : 'other';
}

/**
 * The kind of a shell's whole command: that of its first word when it is one simple command.
 * @param {string} command
 * @returns {Kind}
 */
function kindOfCommand(command) {
  if (/[&|;<>()`$%^\r\n]/.test(command)) return 'other';
  const text = command.replace(/^\s+/, '');
  const quote = text[0] === '"' || (!win && text[0] === "'") ? text[0] : '';
  let word;
  if (quote) {
    const end = text.indexOf(quote, 1);
    if (end < 0 || (end + 1 < text.length && !/\s/.test(text[end + 1]))) return 'other';
    word = text.slice(1, end);
  } else {
    word = text.split(/\s/)[0];
  }
  return word ? kindOfName(word) : 'other';
}

/**
 * The command a shell is given, in the forms child_process gives it (lib/child_process.js normalizeSpawnArguments).
 * @param {string} shell
 * @param {unknown[]} argv the arguments after argv0
 */
function shellCommand(shell, argv) {
  if (win && /^(?:.*\\)?cmd(?:\.exe)?$/i.test(shell)) {
    const quoted = argv[3];
    const form = argv.length === 4 && argv[0] === '/d' && argv[1] === '/s' && argv[2] === '/c' && typeof quoted === 'string';
    return form && quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"') ? quoted.slice(1, -1) : null;
  }
  return argv.length === 2 && argv[0] === '-c' && typeof argv[1] === 'string' ? argv[1] : null;
}

/**
 * A shell given by name may read a command by rules other than the platform shell's.
 * @param {unknown} shell
 */
const namesShell = shell => typeof shell === 'string' && shell !== '';

/** @param {string} file */
function isPlatformShell(file) {
  if (win) return file.toLowerCase() === (process.env.comspec || 'cmd.exe').toLowerCase();
  return file === (process.platform === 'android' ? '/system/bin/sh' : '/bin/sh');
}

/**
 * @param {string} file
 * @param {unknown[]} argv the arguments after argv0
 * @param {unknown} shell the shell option: truthy when child_process made `file` the shell, a string when it names one
 * @returns {Kind}
 */
function kindOfProgram(file, argv, shell) {
  if (namesShell(shell)) return 'other';
  if (shell || isPlatformShell(file)) {
    const command = shellCommand(file, argv);
    return command === null ? 'other' : kindOfCommand(command);
  }
  return kindOfName(file);
}

/**
 * The three variables a child is given, NODE_OPTIONS after the one it would have had.
 * @param {string | undefined} base
 * @param {{ token: string, dir: string }} start
 */
function variables(base, start) {
  return {
    NODE_OPTIONS: base ? (base.includes(PRELOAD) ? base : `${base} ${PRELOAD}`) : PRELOAD,
    SMDB_MUTATION_REACH: start.dir,
    SMDB_MUTATION_REACH_TOKEN: start.token,
  };
}

/** @param {string} name */
const ours = name => NAMES.includes(win ? name.toUpperCase() : name);

/**
 * envPairs as ChildProcess.prototype.spawn takes them ("NAME=value"; on Windows, names deduplicated by case already).
 * @param {unknown} pairs
 * @param {{ token: string, dir: string }} start
 */
function pairsWith(pairs, start) {
  const list = Array.isArray(pairs) ? pairs : Object.keys(process.env).map(key => `${key}=${process.env[key]}`);
  /** @type {string[]} */
  const out = [];
  /** @type {string | undefined} */
  let base;
  for (const pair of list) {
    const text = String(pair);
    const at = text.indexOf('=', 1);
    const name = at < 0 ? text : text.slice(0, at);
    if (!ours(name)) { out.push(pair); continue; }
    if ((win ? name.toUpperCase() : name) === 'NODE_OPTIONS' && base === undefined) base = at < 0 ? '' : text.slice(at + 1);
  }
  for (const [name, value] of Object.entries(variables(base, start))) out.push(`${name}=${value}`);
  return out;
}

/**
 * An env object as the sync forms take it; Node reads every key `for in` gives, and on Windows keeps the first of a
 * name's case forms in sorted order.
 * @param {Record<string, unknown> | undefined | null} env
 * @param {{ token: string, dir: string }} start
 */
function envWith(env, start) {
  const from = env ?? process.env;
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {string[]} */
  const bases = [];
  for (const key in from) {
    if (!ours(key)) { out[key] = from[key]; continue; }
    if ((win ? key.toUpperCase() : key) === 'NODE_OPTIONS') bases.push(key);
  }
  const value = bases.length > 0 ? from[bases.sort()[0]] : undefined;
  return Object.assign(out, variables(value === undefined ? undefined : String(value), start));
}

/**
 * Records a start of `kind` and gives the child its variables through `give`; when either fails, the start is
 * recorded as one of kind other, which leaves the file unsure.
 * @template T
 * @param {() => Kind} kind
 * @param {(start: { token: string, dir: string }) => T} give
 * @param {T} unchanged
 * @returns {T}
 */
function prepare(kind, give, unchanged) {
  /** @type {Kind} */
  let found = 'other';
  try { found = kind(); } catch {}
  const start = started(found);
  if (!start) return unchanged;
  try {
    return give(start);
  } catch {
    started('other');
    return unchanged;
  }
}

/** @param {unknown} value */
const isOptions = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * An object a spread copies exactly as Node reads it: no prototype but Object's or none, every own key enumerable
 * and a data property, so each read gives the same value.
 * @param {unknown} value
 */
function isPlain(value) {
  if (!isOptions(value)) return false;
  const object = /** @type {object} */ (value);
  const proto = Object.getPrototypeOf(object);
  return (proto === Object.prototype || proto === null) && Object.getOwnPropertySymbols(object).length === 0
    && Object.getOwnPropertyNames(object).length === Object.keys(object).length
    && Object.values(Object.getOwnPropertyDescriptors(object)).every(descriptor => 'value' in descriptor);
}

/** @param {unknown} options */
const isReadable = options => isPlain(options) && (/** @type {{ env?: unknown }} */ (options).env === undefined || isPlain(/** @type {{ env?: unknown }} */ (options).env));

/** @param {unknown[]} rest */
const onlyUndefined = rest => rest.every(value => value === undefined);

/**
 * A shape the wrappers do not read may still start a process: it is recorded as a start of kind other.
 * @param {unknown[]} args
 */
function unread(args) {
  started('other');
  return args;
}

/**
 * The sync forms' arguments, with the variables in a copy of the options, for a call the copy reproduces exactly:
 * spawnSync and execFileSync take (file, [args], [options]) or (file, options), execSync takes (command, [options]),
 * the options plain objects and nothing but undefined after them. Any other call is unread.
 * @param {string} name
 * @param {unknown[]} args
 */
function syncArgs(name, args) {
  if (name === 'execSync') {
    const [command, options] = args;
    if (typeof command !== 'string' || (options != null && !isReadable(options)) || !onlyUndefined(args.slice(2))) return unread(args);
    const given = /** @type {{ env?: Record<string, unknown>, shell?: unknown } | null | undefined} */ (options);
    return prepare(() => (namesShell(given?.shell) ? 'other' : kindOfCommand(command)), start => [command, { ...given, env: envWith(given?.env, start) }], args);
  }
  let [file, list, options] = args;
  let rest = args.slice(3);
  if (list === undefined) list = [];
  else if (isOptions(list)) { rest = args.slice(2); options = list; list = []; }
  // spawnSync, unlike execFileSync, rejects null options.
  if (typeof file !== 'string' || !Array.isArray(list) || (options != null && !isReadable(options)) || (name === 'spawnSync' && options === null) || !onlyUndefined(rest)) return unread(args);
  const given = /** @type {{ env?: Record<string, unknown>, shell?: unknown } | undefined} */ (options);
  const words = list;
  return prepare(() => (namesShell(given?.shell) ? 'other' : given?.shell ? kindOfCommand(words.length > 0 ? `${file} ${words.join(' ')}` : file) : kindOfProgram(file, words, false)),
    start => [file, words, { ...given, env: envWith(given?.env, start) }], args);
}

function hook() {
  // Every async form (fork, spawn, exec, execFile, a promisified one) starts its process here, with Node's own
  // normalized options; Node's types omit it.
  const prototype = /** @type {{ spawn: (this: unknown, options: unknown) => unknown }} */ (/** @type {unknown} */ (childProcess.ChildProcess.prototype));
  const spawn = prototype.spawn;
  prototype.spawn = function (options) {
    if (!isOptions(options)) return spawn.call(this, options);
    const given = /** @type {{ file?: unknown, args?: unknown, shell?: unknown, envPairs?: unknown }} */ (options);
    const next = prepare(() => {
      const argv = given.args;
      return typeof given.file === 'string' && Array.isArray(argv) ? kindOfProgram(given.file, argv.slice(1), given.shell) : 'other';
    }, start => ({ ...given, envPairs: pairsWith(given.envPairs, start) }), given);
    return spawn.call(this, next);
  };
  const forms = /** @type {Record<string, (...args: unknown[]) => unknown>} */ (/** @type {unknown} */ (childProcess));
  for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
    const original = forms[name];
    forms[name] = function (...args) {
      return original.apply(this, syncArgs(name, args));
    };
  }
  const { Worker } = workerThreads;
  workerThreads.Worker = class RecordedWorker extends Worker {
    /** @param {ConstructorParameters<typeof Worker>} args */
    constructor(...args) {
      started('worker');
      super(...args);
    }
  };
  syncBuiltinESMExports();
}

function begin() {
  if (state.hooked) return;
  state.hooked = true;
  install();
  hook();
}

/**
 * Starts recording for a test file in this process: its record dir, named by the file and the process, under the
 * pass's coverage dir.
 * @param {string} coverage
 * @param {string} file
 */
function openTestFile(coverage, file) {
  begin();
  const ranOther = state.testFiles > 0;
  state.testFiles += 1;
  openSink(path.join(coverage, `${fileKey(file)}-${process.pid}`), { role: 'file', file, ranOther });
}

const reach = process.env.SMDB_MUTATION_REACH;
const token = process.env.SMDB_MUTATION_REACH_TOKEN;
if (reach && token && !state.sinks.some(sink => sink.dir === reach)) {
  begin();
  openSink(reach, { role: 'child', token, ranOther: false });
}

module.exports = { fileKey, kindOfCommand, kindOfProgram, openTestFile, pairsWith, envWith };
