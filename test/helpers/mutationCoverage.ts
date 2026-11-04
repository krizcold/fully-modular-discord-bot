import childProcess from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import workerThreads from 'worker_threads';
import { INSTRUMENTER_CONSTANTS } from '@stryker-mutator/api/core';
import { beforeAll, expect } from 'vitest';

// Loaded first in every test file of a pass A run with no mutant, which names
// its dir in SMDB_MUTATION_COVERAGE (mutation/runner.mjs, mutation/reach.mjs).
// Stryker's instrumented code counts, in this process's global namespace, each
// mutant whose place ran with no mutant active; vitest runs each test file in
// a process of its own, so every count in it is this file's. The file is
// unsure, and so runs for every mutant, when this process ran another file
// first, when it started a process or a worker, which may run the
// instrumented code where no count reaches this file, or when its hooks did
// not run in vitest's default 'stack' order, so the record may come before
// other hooks.

const dir = process.env.SMDB_MUTATION_COVERAGE;
// A nested vitest a test starts must not write records into this run's dir.
delete process.env.SMDB_MUTATION_COVERAGE;
const MARK = Symbol.for('smdb.mutationCoverage');

// A hash, as a sandbox's path written out can pass Windows' 260 characters; the record names the file. With the
// process id, no record of a file replaces another of it.
export function recordName(file: string, pid: number) {
  return `${createHash('sha256').update(file).digest('hex').slice(0, 32)}-${pid}.json`;
}

/** The ids of every mutant the namespace counts, whichever test id they were counted under. */
export function reachedIds(namespace: unknown): string[] {
  const coverage = (namespace as { mutantCoverage?: { static?: Record<string, number>, perTest?: Record<string, Record<string, number>> } } | undefined)?.mutantCoverage;
  return [...new Set([...Object.keys(coverage?.static ?? {}), ...Object.values(coverage?.perTest ?? {}).flatMap(counts => Object.keys(counts ?? {}))])];
}

if (dir) {
  const global = globalThis as Record<PropertyKey, unknown>;
  let unsure = global[MARK] === undefined ? '' : 'its process ran another test file first';
  global[MARK] = true;
  const started = (what: string) => { unsure ||= `it started ${what}`; };

  // Every async form (fork, spawn, exec, execFile, a promisified one) starts its process here; Node's types omit it.
  const prototype = childProcess.ChildProcess.prototype as unknown as { spawn: (...args: unknown[]) => unknown };
  const spawn = prototype.spawn;
  prototype.spawn = function (this: unknown, ...args: unknown[]) {
    started('a process');
    return spawn.apply(this, args);
  };
  // The sync forms start their process with no ChildProcess.
  for (const name of ['spawnSync', 'execSync', 'execFileSync'] as const) {
    const original = childProcess[name] as (...args: unknown[]) => unknown;
    (childProcess as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      started('a process');
      return original.apply(this, args);
    };
  }
  const { Worker } = workerThreads;
  workerThreads.Worker = class CountedWorker extends Worker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      started('a worker');
      super(...args);
    }
  };
  syncBuiltinESMExports();

  // Taken now: a test may replace them on the fs module and leave them replaced.
  const { mkdirSync, writeFileSync } = fs;
  let file: string | undefined = expect.getState().testPath;
  // The cleanup of the file's first beforeAll: in the 'stack' order vitest runs it after every afterAll and every
  // other beforeAll's cleanup. Nothing later is counted (a file-level aroundAll's part after the suite, a file
  // fixture's teardown): vitest ends a fork with a signal, so no exit handler would run. A record that cannot be
  // written leaves the file with none, so it runs for every mutant.
  beforeAll(() => () => {
    file ??= expect.getState().testPath;
    if (!file) return;
    // A file may change the order with vi.setConfig; vitest reads it as each set of hooks starts.
    const hooks = (global.__vitest_worker__ as { config?: { sequence?: { hooks?: unknown } } } | undefined)?.config?.sequence?.hooks;
    if (hooks !== 'stack') unsure ||= `its hooks ran in the ${String(hooks)} order, not 'stack'`;
    const ids = reachedIds(global[INSTRUMENTER_CONSTANTS.NAMESPACE]);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, recordName(file, process.pid)), JSON.stringify({ file, ids, ...(unsure ? { unsure } : {}) }), { flag: 'wx' });
    } catch {}
  });
}
