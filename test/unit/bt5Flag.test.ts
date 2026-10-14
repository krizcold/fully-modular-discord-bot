import path from 'path';
import fc from 'fast-check';
import type { Client } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { declaresOwnOutcomes, setManifestReader } from '../../src/bot/internalSetup/utils/dataBackends/dataContract';
import { getModuleRegistry, resetModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import type { LoadedModule, ModuleManifest } from '../../src/bot/types/moduleTypes';

// BT-5, the flag (notes/BT.md, "BT-5 design sheet: final", decisions 4 and 5): a module declares dataContract 2 in its
// manifest to own its save outcomes. declaresOwnOutcomes reads the registry's live manifests through the reader
// moduleRegistry.ts installs; only the number 2 counts, the ledger kinds never do, and validateManifest warns on any
// other value.

const flagged = (name: string) => declaresOwnOutcomes(name);

const DATA = process.env.DATA_DIR!;
let modules = 0;
const freshName = () => `bt5-flag-${++modules}`;

function loaded(name: string, fields: Record<string, unknown> = {}): LoadedModule {
  const manifest = { name, version: '1.0.0', displayName: name, description: 'BT-5 flag row', author: 'test', category: 'misc', ...fields };
  return {
    manifest: manifest as ModuleManifest,
    path: path.join(DATA, 'modules', name),
    commands: [],
    events: new Map(),
    panels: [],
    exports: new Map(),
    initialized: true,
    importedFiles: [],
  };
}

const validate = (fields: Record<string, unknown>) =>
  (new ModuleLoader({} as Client) as any).validateManifest(loaded('bt5-validate', fields).manifest) as { valid: boolean; errors: string[]; warnings: string[] };

describe('the registry is where the flag is read', () => {
  it('a module registered with dataContract 2 is flagged, through the reader moduleRegistry.ts installs', () => {
    const name = freshName();
    const registry = getModuleRegistry();
    expect(flagged(name)).toBe(false);
    registry.register(loaded(name, { dataContract: 2 }));
    expect(flagged(name)).toBe(true);
  });

  it('unregister makes a flagged module unflagged', () => {
    const name = freshName();
    const registry = getModuleRegistry();
    registry.register(loaded(name, { dataContract: 2 }));
    expect(flagged(name)).toBe(true);
    registry.unregister(name);
    expect(flagged(name)).toBe(false);
  });

  it('unloadModule makes a flagged module unflagged', async () => {
    const name = freshName();
    const registry = getModuleRegistry();
    registry.register(loaded(name, { dataContract: 2 }));
    expect(flagged(name)).toBe(true);
    expect(await registry.unloadModule(name)).toBe(true);
    expect(flagged(name)).toBe(false);
  });

  it('clear makes every flagged module unflagged', () => {
    const names = [freshName(), freshName()];
    const registry = getModuleRegistry();
    for (const name of names) registry.register(loaded(name, { dataContract: 2 }));
    expect(names.map(flagged)).toEqual([true, true]);
    registry.clear();
    expect(names.map(flagged)).toEqual([false, false]);
  });

  it('a hot reload that drops the field unflags the module, and one that adds it flags the module', () => {
    const name = freshName();
    const registry = getModuleRegistry();
    registry.register(loaded(name, { dataContract: 2 }));
    expect(flagged(name)).toBe(true);
    registry.register(loaded(name));
    expect(flagged(name)).toBe(false);
    registry.register(loaded(name, { dataContract: 2 }));
    expect(flagged(name)).toBe(true);
    registry.register(loaded(name, { dataContract: 1 }));
    expect(flagged(name)).toBe(false);
  });

  it('a module that is not registered is not flagged', () => {
    expect(flagged(freshName())).toBe(false);
  });
});

describe('only the number 2 counts', () => {
  it('dataContract 1, the string "2", 3, null and an absent field are all unflagged', () => {
    const registry = getModuleRegistry();
    const values: Array<[string, Record<string, unknown>]> = [
      ['1', { dataContract: 1 }],
      ['the string "2"', { dataContract: '2' }],
      ['3', { dataContract: 3 }],
      ['null', { dataContract: null }],
      ['absent', {}],
    ];
    for (const [label, fields] of values) {
      const name = freshName();
      registry.register(loaded(name, fields));
      expect([label, flagged(name)]).toEqual([label, false]);
    }
  });

  it('any manifest value other than the number 2 leaves the module unflagged (property)', () => {
    const registry = getModuleRegistry();
    fc.assert(
      fc.property(fc.anything().filter(value => value !== 2), value => {
        const name = freshName();
        registry.register(loaded(name, { dataContract: value }));
        const answer = flagged(name);
        registry.unregister(name);
        return answer === false;
      }),
      { numRuns: 200 },
    );
  });
});

describe('the ledger kinds are never flagged', () => {
  it('a module named "interaction", "panel" or "console" that declares 2 is not flagged', () => {
    const registry = getModuleRegistry();
    for (const kind of ['interaction', 'panel', 'console']) {
      registry.register(loaded(kind, { dataContract: 2 }));
      expect([kind, flagged(kind)]).toEqual([kind, false]);
      registry.unregister(kind);
    }
  });

  it('a flagged module named next to a kind is still flagged, so the exclusion is by exact name', () => {
    const registry = getModuleRegistry();
    for (const name of ['interactions', 'panel-tools', 'console-x']) {
      registry.register(loaded(name, { dataContract: 2 }));
      expect([name, flagged(name)]).toEqual([name, true]);
      registry.unregister(name);
    }
  });
});

describe('validateManifest warns on a dataContract other than 1 or 2', () => {
  it('3, the string "2", 0 and null each give a warning naming dataContract, and no error', () => {
    for (const value of [3, '2', 0, null]) {
      const result = validate({ dataContract: value });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings.filter(w => w.includes('dataContract'))).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
    }
  });

  it('1, 2 and an absent field give no warning', () => {
    for (const fields of [{ dataContract: 1 }, { dataContract: 2 }, {}]) {
      const result = validate(fields);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });
});

describe('the reader follows the live registry', () => {
  it('after resetModuleRegistry, a module registered on the new registry is flagged and one left on the old one is not', () => {
    const before = freshName();
    getModuleRegistry().register(loaded(before, { dataContract: 2 }));
    expect(flagged(before)).toBe(true);
    resetModuleRegistry();
    expect(flagged(before)).toBe(false);
    const after = freshName();
    getModuleRegistry().register(loaded(after, { dataContract: 2 }));
    expect(flagged(after)).toBe(true);
  });
});

describe('with no reader installed', () => {
  it('setManifestReader(null) leaves every module unflagged, even one registered with 2', () => {
    const name = freshName();
    getModuleRegistry().register(loaded(name, { dataContract: 2 }));
    setManifestReader(null);
    expect(flagged(name)).toBe(false);
    expect(flagged('interaction')).toBe(false);
  });
});
