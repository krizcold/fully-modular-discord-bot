import { afterAll, describe, expect, it, vi } from 'vitest';

// The smdb help lists the data migrate verb. smdb.ts runs its main() when imported, so argv, stdout, stderr and exit
// are replaced before the import (vi.hoisted runs first) and put back after it.

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
    if (state.exits.length === 1) throw new Error('nb3L5s15: exit');
  }) as typeof process.exit;
  return state;
});

import '../../src/cli/smdb';

function restore(): void {
  process.argv = cap.argv;
  process.stdout.write = cap.write;
  process.stderr.write = cap.errWrite;
  process.exit = cap.exit;
}

afterAll(restore);

describe('smdb --help', () => {
  it('prints the usage with the data migrate verb and exits with the usage code', async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    restore();
    expect(cap.out).toContain('smdb - Fully Modular Discord Bot console');
    expect(cap.out).toContain('data migrate --to postgres|file   (bot stopped; exits 0 only when the migration is done)');
    expect(cap.exits[0]).toBe(2);
  });
});
