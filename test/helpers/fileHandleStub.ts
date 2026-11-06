import fs from 'fs';
import { vi } from 'vitest';

// NB13 C11: one stub for the append branch's file handles. It spies fs.promises.open and passes every open through.
// For an 'a+' open of a matched path it can hold or reject the open, and wraps the real handle so that write can
// hold, pass only the first k bytes and return k, or reject before any byte; sync, stat and the positional read can
// reject or answer otherwise; close is counted. Directory opens ('r' on a directory) are recorded, and their sync can
// reject, so a test sees the append branch's directory chain.

type Match = RegExp | string;
type Rule<T> = { match: Match; times: number; value: T };

const matches = (match: Match, p: string) => (typeof match === 'string' ? p === match : match.test(p.replace(/\\/g, '/')));

function take<T>(rules: Rule<T>[], p: string): T | undefined {
  const rule = rules.find(r => r.times > 0 && matches(r.match, p));
  if (!rule) return undefined;
  rule.times -= 1;
  return rule.value;
}

const errnoError = (code: string, syscall: string) => Object.assign(new Error(`${code}: stubbed ${syscall}`), { code, syscall });

export interface Hold {
  /** Resolves once the held call is waiting. */
  reached: Promise<void>;
  release(): void;
}

function holdPoint(): { hold: Hold; wait: () => Promise<void> } {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { hold: { reached: reachedP, release }, wait: async () => { reached(); await released; } };
}

export function stubAppendHandles() {
  const realOpen = fs.promises.open.bind(fs.promises);
  const openRules: Rule<{ code?: string; hold?: () => Promise<void>; holdForever?: boolean }>[] = [];
  const writeRules: Rule<{ code?: string; count?: (text: string) => number; hold?: () => Promise<void>; afterBytes?: boolean; decide?: (text: string) => string | number | undefined }>[] = [];
  const syncRules: Rule<{ code?: string; hold?: () => Promise<void> }>[] = [];
  const statRules: Rule<{ code?: string; as?: (real: fs.BigIntStats) => Partial<Record<keyof fs.BigIntStats, unknown>> }>[] = [];
  const readRules: Rule<string>[] = [];
  const dirSyncRules: Rule<string>[] = [];
  const dirSyncHolds: Rule<{ code?: string; hold: () => Promise<void> }>[] = [];
  const dirCloseRules: Rule<string>[] = [];
  const closeRules: Rule<string>[] = [];
  const appendOpens: string[] = [];
  const appendCloses: string[] = [];
  const dirOpens: string[] = [];
  const dirCloses: string[] = [];
  const dirSyncs: string[] = [];
  const writes: Array<{ path: string; text: string; accepted: number }> = [];
  const writeCalls: string[] = [];

  const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
    const p = String(file);
    if (flags === 'a+') {
      appendOpens.push(p);
      const rule = take(openRules, p);
      if (rule?.holdForever) await new Promise(() => undefined);
      if (rule?.hold) await rule.hold();
      if (rule?.code !== undefined) throw rule.code === 'undefined' ? undefined : errnoError(rule.code, 'open');
      const fh = await realOpen(file, flags, mode);
      return wrapAppend(p, fh);
    }
    if (flags === 'r' || flags === undefined) {
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch { /* not there: the real open answers */ }
      if (isDir) {
        dirOpens.push(p);
        const dh = await realOpen(file, flags, mode);
        return wrapDir(p, dh);
      }
    }
    return realOpen(file, flags, mode);
  }) as typeof fs.promises.open);

  function wrapAppend(p: string, fh: fs.promises.FileHandle): fs.promises.FileHandle {
    return new Proxy(fh, {
      get(target, prop, receiver) {
        if (prop === 'write') {
          return async (buffer: Buffer | string, ...rest: unknown[]) => {
            const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
            const text = bytes.toString('utf8');
            writeCalls.push(p);
            const rule = take(writeRules, p);
            const decided = rule?.decide?.(text);
            if (rule?.hold && !rule.afterBytes) await rule.hold();
            const code = rule?.code ?? (typeof decided === 'string' ? decided : undefined);
            if (code) throw errnoError(code, 'write');
            const count = rule?.count ?? (typeof decided === 'number' ? () => decided : undefined);
            if (count) {
              const k = count(text);
              const part = bytes.subarray(0, k);
              if (k > 0) await target.write(part, 0, part.length);
              writes.push({ path: p, text, accepted: k });
              if (rule?.hold) await rule.hold();
              return { bytesWritten: k, buffer };
            }
            const res = await (target.write as (...a: unknown[]) => Promise<{ bytesWritten: number }>)(buffer, ...rest);
            writes.push({ path: p, text, accepted: res.bytesWritten });
            if (rule?.hold && rule.afterBytes) await rule.hold();
            return res;
          };
        }
        if (prop === 'sync') {
          return async () => {
            const rule = take(syncRules, p);
            if (rule?.hold) await rule.hold();
            if (rule?.code) throw errnoError(rule.code, 'fsync');
            return target.sync();
          };
        }
        if (prop === 'stat') {
          return async (opts?: fs.StatOptions) => {
            const rule = take(statRules, p);
            if (rule?.code) throw errnoError(rule.code, 'fstat');
            const real = await target.stat({ bigint: true });
            if (rule?.as) {
              const over = rule.as(real);
              return new Proxy(real, { get: (s, key) => (key in over ? (over as Record<string | symbol, unknown>)[key] : Reflect.get(s, key)) });
            }
            return opts?.bigint ? real : target.stat(opts);
          };
        }
        if (prop === 'read') {
          return async (...args: unknown[]) => {
            const code = take(readRules, p);
            if (code) throw errnoError(code, 'read');
            return (target.read as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        if (prop === 'close') {
          return async () => {
            appendCloses.push(p);
            const code = take(closeRules, p);
            await target.close();
            if (code) throw code === 'none' ? new Error('stubbed close') : errnoError(code, 'close');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function wrapDir(p: string, dh: fs.promises.FileHandle): fs.promises.FileHandle {
    return new Proxy(dh, {
      get(target, prop, receiver) {
        if (prop === 'sync') {
          return async () => {
            dirSyncs.push(p);
            const held = take(dirSyncHolds, p);
            if (held) {
              await held.hold();
              if (held.code) throw errnoError(held.code, 'fsync');
            }
            const code = take(dirSyncRules, p);
            if (code) throw errnoError(code, 'fsync');
            return target.sync();
          };
        }
        if (prop === 'close') {
          return async () => {
            dirCloses.push(p);
            const code = take(dirCloseRules, p);
            await target.close();
            if (code) throw code === 'none' ? new Error('stubbed close') : errnoError(code, 'close');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  return {
    appendOpens, appendCloses, dirOpens, dirCloses, dirSyncs, writes, writeCalls,
    /** Rejects the next `times` 'a+' opens of a matched path with code ('undefined' rejects with undefined). */
    rejectOpen(match: Match, code: string, times = 1) { openRules.push({ match, times, value: { code } }); },
    /** Holds the next 'a+' open of a matched path until released. */
    holdOpen(match: Match): Hold { const h = holdPoint(); openRules.push({ match, times: 1, value: { hold: h.wait } }); return h.hold; },
    /** Holds every 'a+' open of a matched path for ever. */
    holdOpenForever(match: Match, times = 1_000) { openRules.push({ match, times, value: { holdForever: true } }); },
    /** The next `times` writes pass only count(text) bytes and return that count. */
    shortWrite(match: Match, count: (text: string) => number, times = 1) { writeRules.push({ match, times, value: { count } }); },
    /** The next `times` writes reject before any byte. */
    failWrite(match: Match, code: string, times = 1) { writeRules.push({ match, times, value: { code } }); },
    /** Holds the next write call: before any byte, or (afterBytes) once its bytes are in the file. */
    holdWrite(match: Match, afterBytes = false): Hold {
      const h = holdPoint();
      writeRules.push({ match, times: 1, value: { hold: h.wait, afterBytes } });
      return h.hold;
    },
    /** Every write of a matched path asks decide: a code rejects it before any byte, a number passes that many bytes. */
    onWrite(match: Match, decide: (text: string) => string | number | undefined) { writeRules.push({ match, times: Infinity, value: { decide } }); },
    /** The next `times` file fsyncs reject. */
    failSync(match: Match, code: string, times = 1) { syncRules.push({ match, times, value: { code } }); },
    /** Holds the next file fsync until released, then rejects it with code (or lets it run with none). */
    holdSync(match: Match, code?: string): Hold {
      const h = holdPoint();
      syncRules.push({ match, times: 1, value: { hold: h.wait, code } });
      return h.hold;
    },
    failStat(match: Match, code: string, times = 1) { statRules.push({ match, times, value: { code } }); },
    /** The next `times` stats answer the real stat with these fields replaced. */
    statAs(match: Match, as: (real: fs.BigIntStats) => Partial<Record<keyof fs.BigIntStats, unknown>>, times = 1) { statRules.push({ match, times, value: { as } }); },
    failRead(match: Match, code: string, times = 1) { readRules.push({ match, times, value: code }); },
    /** The next `times` closes reject after the handle closed ('none' rejects with an error carrying no code). */
    failClose(match: Match, code: string, times = 1) { closeRules.push({ match, times, value: code }); },
    /** The next `times` fsyncs of a matched directory reject. */
    failDirSync(match: Match, code: string, times = 1) { dirSyncRules.push({ match, times, value: code }); },
    /** Holds the next fsync of a matched directory until released, then rejects it with code (or lets it run with none). */
    holdDirSync(match: Match, code?: string): Hold {
      const h = holdPoint();
      dirSyncHolds.push({ match, times: 1, value: { hold: h.wait, code } });
      return h.hold;
    },
    failDirClose(match: Match, code: string, times = 1) { dirCloseRules.push({ match, times, value: code }); },
    restore() { spy.mockRestore(); },
  };
}

export type AppendStub = ReturnType<typeof stubAppendHandles>;
