import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, onTestFinished } from 'vitest';
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
});

describe('the build lock', () => {
  it('takes over a lock whose owner is gone, waits on a live one, and always lets go', () => {
    const root = fakeRoot();
    const lock = path.join(root, 'dist', '.build-lock');
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), String(gone));
    expect(builder.withLock(root, () => 'built')).toBe('built');
    expect(fs.existsSync(lock)).toBe(false);

    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), String(process.pid));
    expect(() => builder.withLock(root, () => 'built', 300)).toThrow(/dist is locked by process/);
    fs.rmSync(lock, { recursive: true });

    expect(() => builder.withLock(root, () => { throw new Error('tsc failed'); })).toThrow('tsc failed');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('takes over a lock left long ago even when its pid is alive again (a reused pid)', () => {
    const root = fakeRoot();
    const lock = path.join(root, 'dist', '.build-lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} old`);
    const longAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(lock, longAgo, longAgo);
    expect(builder.withLock(root, () => 'built', 300)).toBe('built');
  });

  it('removes only the lock it judged stale: a live lock taken meanwhile is put back', () => {
    const root = fakeRoot();
    const lock = path.join(root, 'dist', '.build-lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), '4242 live');
    expect(builder.claimStale(lock, '999999 dead')).toBe(false);
    expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe('4242 live');
    expect(builder.claimStale(lock, '4242 live')).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(path.join(root, 'dist')).filter(f => f.startsWith('.build-lock'))).toEqual([]);
  });
});

describe('a build', () => {
  it('stamps the src it started from, so an edit saved while it ran leaves dist stale', () => {
    const root = fakeRoot();
    const before = builder.sourceHash(root);
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 3;\n');
    builder.writeStamp(root, before);
    expect(builder.isFresh(root)).toBe(false);
  });
});
