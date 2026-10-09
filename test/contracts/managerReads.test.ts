import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { PROMOTED_BY_HAND, type ArmPhase } from '../../src/bot/internalSetup/fleet/armRecord';
import type { FollowerHoldView } from '../../src/bot/internalSetup/fleet/state';

// Compile-time half for values that exist only as types: renaming one on the
// bot side stops this file from type-checking, which CI runs.
const PHASES = ['promoted', 'disarmed'] as const satisfies readonly ArmPhase[];
const HOLD_REASONS = ['behind', 'copy'] as const satisfies readonly FollowerHoldView['reason'][];

interface ContractString { id: string; value: string; botWriter: string; managerReader: string }

const here = path.dirname(fileURLToPath(import.meta.url));
const contract: { strings: ContractString[] } = JSON.parse(fs.readFileSync(path.join(here, 'manager-reads.json'), 'utf8'));
const entry = (id: string): ContractString => {
  const found = contract.strings.find(s => s.id === id);
  if (!found) throw new Error(`contract entry ${id} is missing`);
  return found;
};

// The checkouts sit side by side locally (the mirror and the verify worktrees);
// CI checks out one repo, so the cross-repo half runs only where both exist.
const managerRoot = path.resolve(here, '../../../docker-discord-bot-manager');
const managerPresent = fs.existsSync(path.join(managerRoot, 'src'));

describe('strings the manager compares against what this bot writes', () => {
  it('the bot still writes exactly the contracted text', () => {
    expect(PROMOTED_BY_HAND).toBe(entry('arm-record.disarmReason.promoted-by-hand').value);
  });

  it('the contract and the typed values agree both ways', () => {
    const valuesOf = (prefix: string) => contract.strings.filter(s => s.id.startsWith(prefix)).map(s => s.value).sort();
    expect(valuesOf('arm-record.phase.')).toEqual([...PHASES].sort());
    expect(valuesOf('follower-hold.reason.')).toEqual([...HOLD_REASONS].sort());
  });

  // Interim until the manager has its own suite asserting against its copy of
  // this file: its reader must still hold the contracted text verbatim.
  it.skipIf(!managerPresent)('the manager still reads exactly the contracted text', () => {
    for (const s of contract.strings) {
      const reader = fs.readFileSync(path.join(managerRoot, s.managerReader), 'utf8');
      expect(reader.includes(`'${s.value}'`), `${s.managerReader} no longer compares '${s.value}' (${s.id})`).toBe(true);
    }
  });
});
