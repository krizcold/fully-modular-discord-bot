import { afterAll, describe, expect, it, vi } from 'vitest';

// The smdb help lists `data provision`. smdb.ts runs its main() when imported, so argv, stdout, stderr and exit are
// replaced before the import (vi.hoisted runs first) and put back after it.

const cap = vi.hoisted(() => {
  const state = {
    out: '',
    exits: [] as Array<number | undefined>,
    argv: process.argv,
    write: process.stdout.write,
    errWrite: process.stderr.write,
    exit: process.exit,
  };
  process.argv = [process.argv[0], 'smdb', '--help'];
  process.stdout.write = ((s: unknown) => { state.out += String(s); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    state.exits.push(code);
    if (state.exits.length === 1) throw new Error('nb36: exit');
  }) as typeof process.exit;
  return state;
});

import '../../src/cli/smdb';

afterAll(() => {
  process.argv = cap.argv;
  process.stdout.write = cap.write;
  process.stderr.write = cap.errWrite;
  process.exit = cap.exit;
});

describe('smdb --help', () => {
  it('lists data provision under Data', async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const lines = cap.out.split('\n');
    const data = lines.findIndex(l => l.startsWith('Data:'));
    const backups = lines.findIndex(l => l.startsWith('Backups:'));
    expect(lines.slice(data, backups).join('\n')).toContain('data provision   (creates an empty store in the database DATA_BACKEND_URL names, without serving it)');
  });
});
