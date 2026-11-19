import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classify, topItems } from '../../src/bot/internalSetup/utils/backups/snapshotSet';
import { dataPath } from '../../src/utils/dataRoot';

// NB8 test 2: what a snapshot holds (decision 1, decision 20, C5, C6).

const IN = [
  '868200000000000001',
  '868200000000000001/welcome/settings.json',
  '868200000000000001/m/events.jsonl',
  '_graveyard',
  '_graveyard/868200000000000002-1700000000000',
  '_graveyard/868200000000000002-1700000000000/.graveyard.json',
  '_graveyard/.copy-x',
  '_graveyard/.restore-x',
  'global',
  'global/mymod/state.json',
  'global/premium-tiers.json',
  'global/premium-tiers.audit.jsonl',
  'global/premium-tiers.events.jsonl',
  'global/payment-providers/dummy/state.json',
  'global/payment-providers/credentials.json',
  'global/metrics/totals.json',
  'dist/bot/config.json',
  'owner-channel.json',
];

const OUT = [
  '.env',
  'maintenance.json',
  '.backend.json',
  '_sessions/abc.json',
  'configBackups/x.json',
  'backups/backup-1/custom/a.js',
  'crash-logs/1.log',
  'recovery/x',
  'update-safety.json',
  'applied-version.json',
  'appstore-modules/m/index.js',
  'global/appstore',
  'global/appstore/x',
  'global/fleet',
  'global/fleet/node.json',
  'global/fleet/shards.json',
  '.bundle-import-1',
  '.writer.lock',
  '.writer.lock.takeover',
  '.migration.json',
  '.stores.json',
  '.migrate-1/x.json',
  '_superseded/shared-1/global/x.json',
  'owner-messages.json',
  'db-certs/ca.pem',
  'dist',
  'dist/bot',
  'dist/other',
  'dist/bot/other.json',
  'a.json.tmp',
  '868200000000000001/m/a.json.tmp',
  'global/m/a.json.tmp',
  '_snapshots',
  '_snapshots/x',
  '_graveyard/.sweep-x',
  '_graveyard/.sweep-x/a.json',
  '.shared-mirror.json',
  'build-safe-mode.json',
  'global/appstore/cache/.shared-mirror.json',
  'global/appstore/cache/module-crashes.json',
  'global/appstore/cache/backups/m-1-orphan/a.js',
  '.migrate-probe-12-34.tmp',
];

describe('classify', () => {
  it.each(IN)('%s is in', rel => {
    expect(classify(rel)).toBe('in');
  });

  it.each(OUT)('%s is out', rel => {
    expect(classify(rel)).toBe('out');
  });

  const segment = fc.oneof(
    fc.constantFrom('123', '_graveyard', 'global', 'dist', 'bot', 'config.json', 'owner-channel.json', 'appstore', 'fleet', 'a.json', '.sweep-1', 'x.tmp'),
    fc.stringMatching(/^[A-Za-z0-9_.-]{1,12}$/).filter(s => s !== '.' && s !== '..'),
  );
  const relPath = fc.array(segment, { minLength: 1, maxLength: 5 }).map(parts => parts.join('/'));

  it('puts out any path whose first segment is not one the set names', () => {
    fc.assert(
      fc.property(relPath, rel => {
        const top = rel.split('/')[0];
        const named = /^\d+$/.test(top) || top === '_graveyard' || top === 'global' || rel === 'dist/bot/config.json' || rel === 'owner-channel.json';
        if (!named) expect(classify(rel)).toBe('out');
      }),
    );
  });

  it('keeps a folder whose name ends in .tmp, with its files', () => {
    expect(classify('global/c.tmp', 'dir')).toBe('in');
    expect(classify('global/c.tmp/a.json')).toBe('in');
    expect(classify('868200000000000001/c.tmp', 'dir')).toBe('in');
  });

  it('puts out any file ending in .tmp', () => {
    fc.assert(
      fc.property(relPath, segment, (rel, last) => {
        expect(classify(`${rel}/${last}.tmp`)).toBe('out');
      }),
    );
  });
});

let trees = 0;
function freshRoot(): string {
  trees += 1;
  const root = dataPath(`nb8-tree-${process.pid}-${trees}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Writes each file unless a folder or file already stands in its way; answers the files written.
function plant(root: string, rels: string[]): string[] {
  const written: string[] = [];
  for (const rel of rels) {
    const parts = rel.split('/');
    const blocked = parts.some((_, i) => {
      const p = path.join(root, ...parts.slice(0, i + 1));
      if (!fs.existsSync(p)) return false;
      return i < parts.length - 1 ? !fs.statSync(p).isDirectory() : true;
    });
    if (blocked) continue;
    fs.mkdirSync(path.join(root, ...parts.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(root, ...parts), 'x');
    written.push(rel);
  }
  return written;
}

describe('topItems', () => {
  it('lists the units of a data folder that holds every kind', () => {
    const root = freshRoot();
    plant(root, [
      '868200000000000001/m/a.json',
      '868200000000000002/m/b.json',
      '_graveyard/868200000000000003-1/m/c.json',
      'global/mymod/state.json',
      'global/premium-tiers.json',
      'global/appstore/installed.json',
      'global/fleet/node.json',
      'global/x.json.tmp',
      'dist/bot/config.json',
      'dist/other.js',
      'owner-channel.json',
      'owner-messages.json',
      '.env',
      '_snapshots/state.json',
      '.writer.lock',
    ]);
    expect(topItems(root)).toEqual([
      '868200000000000001',
      '868200000000000002',
      '_graveyard',
      'dist/bot/config.json',
      'global/mymod',
      'global/premium-tiers.json',
      'owner-channel.json',
    ]);
  });

  it('lists no root config or owner channel file that is absent', () => {
    const root = freshRoot();
    plant(root, ['868200000000000001/m/a.json', 'dist/other.js']);
    expect(topItems(root)).toEqual(['868200000000000001']);
  });

  it('covers every path in the set exactly once', () => {
    const segment = fc.constantFrom('123', '456', '_graveyard', 'global', 'appstore', 'fleet', 'dist', 'bot', 'config.json', 'owner-channel.json', 'a', 'b.json', 'c.tmp', '.sweep-1', '.copy-2');
    fc.assert(
      fc.property(fc.array(fc.array(segment, { minLength: 1, maxLength: 4 }).map(p => p.join('/')), { maxLength: 12 }), rels => {
        const root = freshRoot();
        const files = plant(root, rels);
        const units = topItems(root);
        expect(new Set(units).size).toBe(units.length);
        const paths = new Map<string, 'file' | 'dir'>();
        for (const file of files) {
          const parts = file.split('/');
          for (let i = 1; i <= parts.length; i++) paths.set(parts.slice(0, i).join('/'), i === parts.length ? 'file' : 'dir');
        }
        for (const unit of units) expect(classify(unit, paths.get(unit)), unit).toBe('in');
        // The global folder holds units but is not one: a restore swaps its children and keeps it.
        const global = path.join(root, 'global');
        if (fs.existsSync(global) && fs.statSync(global).isDirectory()) paths.delete('global');
        for (const [p, type] of paths) {
          if (classify(p, type) !== 'in') continue;
          const covering = units.filter(u => p === u || p.startsWith(`${u}/`));
          expect(covering, p).toHaveLength(1);
        }
        fs.rmSync(root, { recursive: true, force: true });
      }),
      { numRuns: 60 },
    );
  });
});
