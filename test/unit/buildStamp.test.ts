import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import builder from '../helpers/build.cjs';

// The child tier's dist stamp (helpers/build.cjs): a dist counts as fresh only
// when it was built from this src and nothing has changed it since.

function fakeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-build-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'dist', 'a.js'), 'exports.a = 1;\n');
  return root;
}

describe('the dist stamp', () => {
  it('goes stale when dist changes under it, a new file included, and fresh again when dist is back', () => {
    const root = fakeRoot();
    const built = path.join(root, 'dist', 'a.js');
    expect(builder.isFresh(root)).toBe(false);
    builder.writeStamp(root, builder.sourceHash(root));
    expect(builder.isFresh(root)).toBe(true);
    fs.writeFileSync(built, 'exports.a = 2;\n');
    expect(builder.isFresh(root)).toBe(false);
    fs.writeFileSync(built, 'exports.a = 1;\n');
    expect(builder.isFresh(root)).toBe(true);
    fs.writeFileSync(path.join(root, 'dist', 'b.js'), '');
    expect(builder.isFresh(root)).toBe(false);
  });

  it('goes stale when src, tsconfig.json or the typescript version changes', () => {
    const root = fakeRoot();
    builder.writeStamp(root, builder.sourceHash(root));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    expect(builder.isFresh(root)).toBe(false);
    builder.writeStamp(root, builder.sourceHash(root));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
    expect(builder.isFresh(root)).toBe(false);
    builder.writeStamp(root, builder.sourceHash(root));
    const ts = path.join(root, 'node_modules', 'typescript');
    fs.mkdirSync(ts, { recursive: true });
    fs.writeFileSync(path.join(ts, 'package.json'), '{ "version": "5.9.3" }\n');
    expect(builder.isFresh(root)).toBe(false);
    builder.writeStamp(root, builder.sourceHash(root));
    fs.writeFileSync(path.join(ts, 'package.json'), '{ "version": "7.0.0" }\n');
    expect(builder.isFresh(root)).toBe(false);
  });

  it('goes stale when a file src reaches through a link changes, as tsc compiles it', () => {
    const root = fakeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-linked-src-'));
    onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'b.ts'), 'export const b = 1;\n');
    // A junction on Windows, a dir symlink elsewhere; a link back to src, a broken one and one to itself are walked past.
    const self = path.join(root, 'src', 'self');
    const links = [[outside, 'linked'], [path.join(root, 'src'), 'loop'], [path.join(outside, 'gone'), 'broken'], [self, 'self']];
    try {
      for (const [target, name] of links) fs.symlinkSync(target, path.join(root, 'src', name), 'junction');
      builder.writeStamp(root, builder.sourceHash(root));
      expect(builder.isFresh(root)).toBe(true);
      fs.writeFileSync(path.join(outside, 'b.ts'), 'export const b = 2;\n');
      expect(builder.isFresh(root)).toBe(false);
    } finally {
      for (const [, name] of links) fs.rmSync(path.join(root, 'src', name), { force: true });
    }
  });

  it('stops on a dir under a link it cannot list, rather than hash what the link leads to as nothing', () => {
    const root = fakeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-linked-src-'));
    onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.mkdirSync(path.join(outside, 'locked'));
    fs.writeFileSync(path.join(outside, 'b.ts'), 'export const b = 1;\n');
    const link = path.join(root, 'src', 'linked');
    const list = fs.readdirSync;
    // A dir this user cannot list, on any platform: tsc still compiles what it reaches under the link.
    const denied = vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: never) => {
      if (path.basename(String(dir)) === 'locked') throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(dir)}'`), { code: 'EACCES' });
      return list(dir, options);
    }) as typeof fs.readdirSync);
    try {
      fs.symlinkSync(outside, link, 'junction');
      expect(() => builder.sourceHash(root)).toThrow(/EACCES/);
    } finally {
      denied.mockRestore();
      fs.rmSync(link, { force: true });
    }
  });

  it('leaves out .git and node_modules dirs under src, which tsc compiles nothing from, a linked one included', () => {
    const root = fakeRoot();
    const clone = path.join(root, 'src', 'clone');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-linked-src-'));
    onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
    for (const dir of ['.git', 'node_modules/pkg', 'Modules']) fs.mkdirSync(path.join(clone, dir), { recursive: true });
    fs.writeFileSync(path.join(outside, 'c.ts'), 'export const c = 1;\n');
    const linked = path.join(root, 'src', 'other', 'node_modules');
    fs.mkdirSync(path.dirname(linked));
    const kept = path.join(clone, 'Modules', 'x.ts');
    const ignored = [path.join(clone, '.git', 'FETCH_HEAD'), path.join(clone, 'node_modules', 'pkg', 'b.ts'), path.join(outside, 'c.ts')];
    try {
      fs.symlinkSync(outside, linked, 'junction');
      for (const file of [kept, ...ignored]) fs.writeFileSync(file, 'export const v = 1;\n');
      builder.writeStamp(root, builder.sourceHash(root));
      for (const file of ignored) {
        fs.writeFileSync(file, 'export const v = 2;\n');
        expect(builder.isFresh(root), file).toBe(true);
      }
      fs.writeFileSync(kept, 'export const v = 2;\n');
      expect(builder.isFresh(root)).toBe(false);
    } finally {
      fs.rmSync(linked, { force: true });
    }
  });
});

describe('the build lock', () => {
  it('waits on a live owner, and always lets go', () => {
    const root = fakeRoot();
    const lock = path.join(root, 'dist', '.build-lock');
    fs.writeFileSync(lock, String(process.pid));
    expect(() => builder.withLock(root, () => 'built', 300)).toThrow(/is held by process \d+, still building/);
    fs.rmSync(lock);

    expect(builder.withLock(root, () => fs.readFileSync(lock, 'utf8'))).toBe(String(process.pid));
    expect(fs.existsSync(lock)).toBe(false);
    expect(() => builder.withLock(root, () => { throw new Error('tsc failed'); })).toThrow('tsc failed');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('never takes a lock from another process: one a dead build left stops the run and names the file', () => {
    const root = fakeRoot();
    const lock = path.join(root, 'dist', '.build-lock');
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    fs.writeFileSync(lock, String(gone));
    expect(() => builder.withLock(root, () => 'built', 300)).toThrow(`${lock} was left by a build that died (process ${gone} is gone); remove that file`);
    expect(fs.readFileSync(lock, 'utf8')).toBe(String(gone));

    fs.writeFileSync(lock, '');
    expect(() => builder.withLock(root, () => 'built', 300)).toThrow(/is held by process \(none yet\)/);
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, longAgo, longAgo);
    expect(() => builder.withLock(root, () => 'built', 300)).toThrow(`${lock} was left by a build that died (it holds no process id)`);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('sees a fresh dist without the lock, so a run that only checks never waits on a build', () => {
    const root = fakeRoot();
    builder.writeStamp(root, builder.sourceHash(root));
    fs.writeFileSync(path.join(root, 'dist', '.build-lock'), String(process.pid));
    expect(builder.run(root, true, 300)).toBe(0);
  });
});

describe('a build', () => {
  // A stand-in for tsc that writes dist and, given a script, does more first.
  function withTsc(root: string, script = ''): void {
    const bin = path.join(root, 'node_modules', 'typescript', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), '{ "version": "5.9.3" }\n');
    fs.writeFileSync(path.join(bin, 'tsc'), `const fs = require('fs');\nconst path = require('path');\nconst root = ${JSON.stringify(root)};\n${script}\nfs.writeFileSync(path.join(root, 'dist', 'a.js'), 'exports.a = 1;\\n');\n`);
    fs.mkdirSync(path.join(root, 'src', 'webui', 'public'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'bot', 'modules'), { recursive: true });
  }

  it('stamps the src it started from, so an edit saved while it ran leaves dist stale', () => {
    const root = fakeRoot();
    const before = builder.sourceHash(root);
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 3;\n');
    builder.writeStamp(root, before);
    expect(builder.isFresh(root)).toBe(false);
  });

  it('leaves dist unstamped when src is rewritten while it builds, even back to the same bytes (a stash, then a pop)', () => {
    const root = fakeRoot();
    const stamp = path.join(root, 'dist', '.smdb-build.json');
    withTsc(root, "const a = path.join(root, 'src', 'a.ts');\nconst text = fs.readFileSync(a);\nfs.writeFileSync(a, 'export const a = 2;\\n');\nfs.writeFileSync(a, text);");
    expect(builder.build(root)).toBe(1);
    expect(fs.existsSync(stamp)).toBe(false);
    withTsc(root);
    expect(builder.build(root)).toBe(0);
    expect(builder.isFresh(root)).toBe(true);
  });
});
