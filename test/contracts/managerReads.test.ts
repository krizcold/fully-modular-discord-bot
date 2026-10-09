import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { PROMOTED_BY_HAND } from '../../src/bot/internalSetup/fleet/armRecord';

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

  // Interim until the manager has its own suite asserting against its copy of
  // this file: its reader must still hold the contracted text verbatim.
  it.skipIf(!managerPresent)('the manager still reads exactly the contracted text', () => {
    for (const s of contract.strings) {
      const reader = fs.readFileSync(path.join(managerRoot, s.managerReader), 'utf8');
      expect(reader.includes(`'${s.value}'`), `${s.managerReader} no longer compares '${s.value}' (${s.id})`).toBe(true);
    }
  });
});
