import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { forcePassive, readFleetConfigCache, renumberDesignations, validateBackupDesignations } from '../../src/bot/internalSetup/fleet/fleetConfig';
import { consentsToActiveMode } from '../../src/bot/internalSetup/fleet/nodeIdentity';

// B0, from R-F1's clarification of 2026-10-09 (PLAN_REPLICATION.md Section 21).
// Two properties that job 14 fused and B0 separates again:
//   zero loss  keyed on the designation itself, whatever its mode
//              (syncPostureTargets.test.ts);
//   stand in   keyed on BOTH the master's stored enable and the node's own
//              consent, and PASSIVE by default on both halves.
// These checks cover the second property, the one with a default to get wrong.
// The owner's words: "passive is the default".

const isActive = (d: { mode?: unknown }): boolean => d.mode === 'active';
const hasKey = (d: object, key: string): boolean => Object.keys(d).includes(key);
const known = (...ids: string[]) => new Set(ids);

describe('a designation is passive unless active is asked for', () => {
  it('reads an entry that names no mode as passive, even where the node consents', () => {
    const result = validateBackupDesignations([{ nodeId: 'n1', priority: 1 }], known('n1'), () => true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isActive(result.designations[0])).toBe(false);
  });

  it('reads a bare node id as passive', () => {
    const result = validateBackupDesignations(['n1'], known('n1'), () => true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isActive(result.designations[0])).toBe(false);
  });

  it('reads any mode that is not the literal active as passive', () => {
    fc.assert(
      fc.property(fc.anything().filter(v => v !== 'active'), value => {
        const result = validateBackupDesignations([{ nodeId: 'n1', priority: 1, mode: value }], known('n1'), () => true);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(isActive(result.designations[0])).toBe(false);
      }),
    );
  });

  it('enables active only where it is asked for', () => {
    const result = validateBackupDesignations(
      [{ nodeId: 'n1', priority: 1, mode: 'active' }, { nodeId: 'n2', priority: 2 }],
      known('n1', 'n2'),
      () => true,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.designations.map(isActive)).toEqual([true, false]);
  });

  it('refuses active on a node that declines it, naming the node', () => {
    const result = validateBackupDesignations([{ nodeId: 'node1234abcd', priority: 1, mode: 'active' }], known('node1234abcd'), () => false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('node1234');
  });

  it('gives every modeless list passive entries renumbered from one', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1 }).filter(s => s.trim() !== ''), { minLength: 1, maxLength: 16 }), ids => {
        const trimmed = [...new Set(ids.map(i => i.trim()))];
        const result = validateBackupDesignations(trimmed, known(...trimmed), () => true);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.designations.map(isActive)).toEqual(trimmed.map(() => false));
        expect(result.designations.map(d => d.priority)).toEqual(trimmed.map((_, i) => i + 1));
      }),
    );
  });

  it('keeps each mode through a renumber', () => {
    const list = renumberDesignations([{ nodeId: 'b', priority: 5 }, { nodeId: 'a', priority: 2, mode: 'active' }]);
    expect(list.map(d => [d.nodeId, d.priority, isActive(d)])).toEqual([['a', 1, true], ['b', 2, false]]);
  });

  it('reads a cached entry as active only when it says active', () => {
    const file = path.join(process.env.DATA_DIR!, 'global', 'fleet', 'config-cache.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      revision: 3,
      masterCandidates: [],
      backupDesignations: [
        { nodeId: 'none', priority: 1 },
        { nodeId: 'on', priority: 2, mode: 'active' },
        { nodeId: 'off', priority: 3, mode: 'passive' },
        { nodeId: 'odd', priority: 4, mode: 'ACTIVE', withdrawn: true },
      ],
    }));
    const cache = readFleetConfigCache();
    expect(cache).not.toBeNull();
    expect(cache!.backupDesignations.map(d => [d.nodeId, isActive(d)])).toEqual([['none', false], ['on', true], ['off', false], ['odd', false]]);
    expect(cache!.backupDesignations.some(d => hasKey(d, 'withdrawn'))).toBe(false);
  });
});

describe('consentsToActiveMode', () => {
  const saved = process.env.FLEET_BACKUP_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLEET_BACKUP_MODE;
    else process.env.FLEET_BACKUP_MODE = saved;
  });

  it('consents to the literal active, trimmed and in any case', () => {
    for (const value of ['active', 'ACTIVE', ' Active ']) {
      process.env.FLEET_BACKUP_MODE = value;
      expect(consentsToActiveMode()).toBe(true);
    }
  });

  it('declines when the env is unset', () => {
    delete process.env.FLEET_BACKUP_MODE;
    expect(consentsToActiveMode()).toBe(false);
  });

  it('declines passive, empty and every other value', () => {
    fc.assert(
      fc.property(fc.string().filter(s => s.trim().toLowerCase() !== 'active'), value => {
        process.env.FLEET_BACKUP_MODE = value;
        expect(consentsToActiveMode()).toBe(false);
      }),
    );
  });
});

describe('forcePassive', () => {
  it('drops the enable and leaves nothing that could restore it', () => {
    // A node's withdrawal is only ever downward (20.5, B6 map F7): re-enabling
    // is the master operator's act, so nothing records "it used to be active".
    const [entry] = forcePassive([{ nodeId: 'n1', priority: 1, mode: 'active' }], 'n1');
    expect(isActive(entry)).toBe(false);
    expect(hasKey(entry, 'withdrawn')).toBe(false);
  });

  it('leaves the other entries untouched', () => {
    const list = forcePassive(
      [{ nodeId: 'n1', priority: 1, mode: 'active' }, { nodeId: 'n2', priority: 2, mode: 'active' }],
      'n1',
    );
    expect(list.map(isActive)).toEqual([false, true]);
    expect(list.map(d => d.priority)).toEqual([1, 2]);
  });
});
