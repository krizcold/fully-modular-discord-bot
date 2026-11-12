import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import type { SharedReadOutcome, SharedTxOutcome } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fetchModule, moduleShaOf } from '../../src/bot/internalSetup/utils/sharedModules';
import { configureRowFlush, type RowBackend } from '../../src/bot/internalSetup/utils/sharedStore';
import { FLUSH_STATEMENT_BYTES } from '../../src/bot/internalSetup/utils/storableData';

const h = vi.hoisted(() => ({
  synced: [] as string[],
  events: [] as Array<{ op: string; fd: number; file?: string; mode?: number }>,
  zeroWrite: null as string | null,
  fds: new Map<number, string>(),
}));

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const wrapped = {
    ...real,
    openSync: (file: any, flags: any, ...rest: any[]) => {
      const fd = real.openSync(file, flags, ...rest);
      if (flags === 'w') {
        h.fds.set(fd, path.resolve(String(file)));
        h.events.push({ op: 'open', fd, file: path.resolve(String(file)) });
      }
      return fd;
    },
    writeSync: (fd: any, ...rest: any[]) => {
      if (h.zeroWrite && h.fds.get(fd) === h.zeroWrite) return 0;
      return real.writeSync(fd, ...rest);
    },
    fsyncSync: (fd: any) => {
      if (h.fds.has(fd)) h.events.push({ op: 'fsync', fd });
      return real.fsyncSync(fd);
    },
    chmodSync: (file: any, mode: any) => {
      h.events.push({ op: 'chmod', fd: -1, file: path.resolve(String(file)), mode });
      return real.chmodSync(file, mode);
    },
    closeSync: (fd: any) => {
      if (h.fds.has(fd)) {
        h.events.push({ op: 'close', fd });
        h.fds.delete(fd);
      }
      return real.closeSync(fd);
    },
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    flagAnswer: () => ({ failed: false }),
    syncFolderSync: (dir: string) => {
      h.synced.push(path.resolve(dir));
      return { failed: false };
    },
  };
});

const dirs: string[] = [];

afterEach(() => {
  configureRowFlush({ backend: () => null });
  h.synced = [];
  h.events = [];
  h.zeroWrite = null;
  for (const d of dirs.splice(0)) {
    unlock(d);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function unlock(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) unlock(p);
    else fs.chmodSync(p, 0o644);
  }
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra68-'));
  dirs.push(dir);
  return dir;
}

type Row = { rel: string; bytes: unknown; mode?: number; size?: number };

const sizeOf = (r: Row) => r.size ?? (Buffer.isBuffer(r.bytes) ? r.bytes.length : typeof r.bytes === 'string' ? Buffer.byteLength(r.bytes) : 0);

function backend(files: Row[], extra: Row[] = []) {
  const reads: Array<{ kind: string; values: unknown[] }> = [];
  const b: RowBackend = {
    async sharedTx<S>(): Promise<SharedTxOutcome<S>> {
      throw new Error('no transaction in a fetch');
    },
    async sharedRead(text: string, values: unknown[]): Promise<SharedReadOutcome> {
      if (text.includes('octet_length')) {
        reads.push({ kind: 'list', values });
        return { kind: 'read', rows: files.map(f => ({ rel: f.rel, mode: f.mode ?? 0o644, size: sizeOf(f) })) };
      }
      if (text.includes('substring')) {
        reads.push({ kind: 'piece', values });
        const f = files.find(x => x.rel === values[1]);
        if (!f || f.bytes === undefined) return { kind: 'read', rows: [] };
        const from = Number(values[2]) - 1;
        return { kind: 'read', rows: [{ piece: (f.bytes as Buffer).subarray(from, from + FLUSH_STATEMENT_BYTES) }] };
      }
      reads.push({ kind: 'batch', values });
      const asked = values[1] as string[];
      return { kind: 'read', rows: [...files.filter(f => asked.includes(f.rel)), ...extra].map(f => ({ rel: f.rel, bytes: f.bytes })) };
    },
  };
  configureRowFlush({ backend: () => b });
  return reads;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function modeAfterClose(file: string): number | undefined {
  const opened = h.events.findIndex(e => e.op === 'open' && e.file === file);
  const closed = h.events.findIndex((e, i) => i > opened && e.op === 'close' && e.fd === h.events[opened].fd);
  const set = h.events.find((e, i) => i > closed && e.op === 'chmod' && e.file === file);
  return opened < 0 || closed < 0 ? undefined : set?.mode;
}

const kinds = (reads: Array<{ kind: string }>) => reads.map(r => r.kind);

describe('a fetch of an empty module', () => {
  it('reads only the listing and syncs the folder it made', async () => {
    const reads = backend([]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([]), files: 0, bytes: 0 });
    expect(kinds(reads)).toEqual(['list']);
    expect(h.synced).toEqual([path.resolve(into)]);
  });
});

describe('a fetch into a folder that already exists', () => {
  it('writes the files into it', async () => {
    backend([{ rel: 'a.js', bytes: Buffer.from('abc') }]);
    const into = tempDir();
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'a.js', sha: sha256('abc') }]), files: 1, bytes: 3 });
    expect(fs.readFileSync(path.join(into, 'a.js'), 'utf8')).toBe('abc');
  });
});

describe('the folders a fetch syncs', () => {
  it('are the folder and every folder made under it, none above it', async () => {
    backend([{ rel: 'lib/deep/a.js', bytes: Buffer.from('a') }, { rel: 'top.js', bytes: Buffer.from('t') }]);
    const into = path.join(tempDir(), 'out');
    const answer = await fetchModule('m', into);
    expect(answer.ok).toBe(true);
    const root = path.resolve(into);
    expect([...h.synced].sort()).toEqual([root, path.join(root, 'lib'), path.join(root, 'lib', 'deep')].sort());
  });
});

describe('every file a fetch writes', () => {
  it('is fsynced before it is closed, the small and the pieced alike', async () => {
    const big = Buffer.alloc(FLUSH_STATEMENT_BYTES + 5, 7);
    backend([{ rel: 'a.js', bytes: Buffer.from('abc') }, { rel: 'big.bin', bytes: big }]);
    const into = path.join(tempDir(), 'out');
    expect((await fetchModule('m', into)).ok).toBe(true);
    for (const rel of ['a.js', 'big.bin']) {
      const file = path.resolve(into, rel);
      const opened = h.events.find(e => e.op === 'open' && e.file === file)!;
      expect(opened).toBeDefined();
      const mine = h.events.filter(e => e.fd === opened.fd && h.events.indexOf(e) >= h.events.indexOf(opened)).map(e => e.op);
      expect(mine.slice(0, 3)).toEqual(['open', 'fsync', 'close']);
    }
  });
});

describe('the mode of a fetched file', () => {
  it('is set on a file that was already in the folder', async () => {
    const into = tempDir();
    fs.writeFileSync(path.join(into, 'a.js'), 'old');
    fs.chmodSync(path.join(into, 'a.js'), 0o644);
    backend([{ rel: 'a.js', bytes: Buffer.from('new'), mode: 0o444 }]);
    expect((await fetchModule('m', into)).ok).toBe(true);
    expect(fs.readFileSync(path.join(into, 'a.js'), 'utf8')).toBe('new');
    expect(fs.statSync(path.join(into, 'a.js')).mode & 0o200).toBe(0);
    expect(modeAfterClose(path.resolve(into, 'a.js'))).toBe(0o444);
  });

  it('is set on a pieced file that was already in the folder', async () => {
    const into = tempDir();
    fs.writeFileSync(path.join(into, 'big.bin'), 'old');
    fs.chmodSync(path.join(into, 'big.bin'), 0o644);
    const big = Buffer.alloc(FLUSH_STATEMENT_BYTES + 3, 1);
    backend([{ rel: 'big.bin', bytes: big, mode: 0o444 }]);
    const answer = await fetchModule('m', into);
    expect(answer).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'big.bin', sha: sha256(big) }]), files: 1, bytes: big.length });
    expect(fs.statSync(path.join(into, 'big.bin')).mode & 0o200).toBe(0);
    expect(modeAfterClose(path.resolve(into, 'big.bin'))).toBe(0o444);
  });
});

describe('the bytes column of a row', () => {
  it('is written as text when the driver gives a string', async () => {
    backend([{ rel: 'a.js', bytes: 'xyz', size: 3 }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'a.js', sha: sha256('xyz') }]), files: 1, bytes: 3 });
    expect(fs.readFileSync(path.join(into, 'a.js'), 'utf8')).toBe('xyz');
  });

  it('is written as an empty file when it is null', async () => {
    backend([{ rel: 'a.js', bytes: null, size: 0 }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'a.js', sha: sha256('') }]), files: 1, bytes: 0 });
    expect(fs.readFileSync(path.join(into, 'a.js')).length).toBe(0);
  });
});

describe('a batch answer with a row the batch did not ask for', () => {
  it('writes only the asked files and ignores the rest', async () => {
    backend([{ rel: 'a.js', bytes: Buffer.from('a') }], [{ rel: 'stray.js', bytes: Buffer.from('s') }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'a.js', sha: sha256('a') }]), files: 1, bytes: 1 });
    expect(fs.existsSync(path.join(into, 'stray.js'))).toBe(false);
  });
});

describe('how a fetch groups files into reads', () => {
  it('reads small files in one batch', async () => {
    const reads = backend([{ rel: 'a.js', bytes: Buffer.from('a') }, { rel: 'b.js', bytes: Buffer.from('b') }, { rel: 'c.js', bytes: Buffer.from('c') }]);
    const into = path.join(tempDir(), 'out');
    expect((await fetchModule('m', into)).ok).toBe(true);
    expect(kinds(reads)).toEqual(['list', 'batch']);
    expect(reads[1].values[1]).toEqual(['a.js', 'b.js', 'c.js']);
  });

  it('reads files that together fill exactly one statement in one batch', async () => {
    const a = Buffer.alloc(FLUSH_STATEMENT_BYTES - 10, 2);
    const reads = backend([{ rel: 'a.bin', bytes: a }, { rel: 'b.js', bytes: Buffer.alloc(10, 3) }]);
    const into = path.join(tempDir(), 'out');
    const answer = await fetchModule('m', into);
    expect(answer.ok && answer.bytes).toBe(FLUSH_STATEMENT_BYTES);
    expect(kinds(reads)).toEqual(['list', 'batch']);
  });

  it('starts a second batch when the next file would pass one statement', async () => {
    const reads = backend([{ rel: 'a.bin', bytes: Buffer.alloc(FLUSH_STATEMENT_BYTES - 10, 2) }, { rel: 'b.js', bytes: Buffer.alloc(11, 3) }]);
    const into = path.join(tempDir(), 'out');
    expect((await fetchModule('m', into)).ok).toBe(true);
    expect(kinds(reads)).toEqual(['list', 'batch', 'batch']);
  });

  it('reads a file of exactly one statement in a batch, not in pieces', async () => {
    const full = Buffer.alloc(FLUSH_STATEMENT_BYTES, 4);
    const reads = backend([{ rel: 'full.bin', bytes: full }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'full.bin', sha: sha256(full) }]), files: 1, bytes: full.length });
    expect(kinds(reads)).toEqual(['list', 'batch']);
  });

  it('reads a larger file in pieces and no batch after it', async () => {
    const big = Buffer.alloc(FLUSH_STATEMENT_BYTES + 1, 5);
    const reads = backend([{ rel: 'big.bin', bytes: big }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'big.bin', sha: sha256(big) }]), files: 1, bytes: big.length });
    expect(kinds(reads)).toEqual(['list', 'piece', 'piece']);
  });
});

describe('a pieced file that changed after the listing', () => {
  it('stops reading at a short piece', async () => {
    const reads = backend([{ rel: 'big.bin', bytes: Buffer.from('shrunk'), size: 3 * FLUSH_STATEMENT_BYTES }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'big.bin', sha: sha256('shrunk') }]), files: 1, bytes: 6 });
    expect(kinds(reads)).toEqual(['list', 'piece']);
  });

  it('is left out when its row is gone', async () => {
    backend([{ rel: 'big.bin', bytes: undefined, size: FLUSH_STATEMENT_BYTES + 1 }, { rel: 'a.js', bytes: Buffer.from('a') }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'a.js', sha: sha256('a') }]), files: 1, bytes: 1 });
    expect(fs.existsSync(path.join(into, 'big.bin'))).toBe(false);
  });
});

describe('a write that takes no bytes', () => {
  it('fails the fetch naming where the write stopped', async () => {
    const into = path.join(tempDir(), 'out');
    h.zeroWrite = path.resolve(into, 'a.js');
    backend([{ rel: 'a.js', bytes: Buffer.from('abc') }]);
    expect(await fetchModule('m', into)).toEqual({ ok: false, cause: 'a write took no bytes after 0 of 3' });
  });
});
