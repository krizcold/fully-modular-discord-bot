import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ denied: new Set<string>(), unreadable: new Set<string>() }));

vi.mock('fs', async (orig) => {
  const real = await orig<any>();
  const deny = (p: any) => {
    if (h.denied.has(path.resolve(String(p)))) {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), { code: 'EACCES' });
    }
  };
  const wrapped = {
    ...real,
    readdirSync: (p: any, ...rest: any[]) => { deny(p); return real.readdirSync(p, ...rest); },
    statSync: (p: any, ...rest: any[]) => { deny(p); return real.statSync(p, ...rest); },
    readFileSync: (p: any, ...rest: any[]) => {
      if (h.unreadable.has(path.resolve(String(p)))) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
      return real.readFileSync(p, ...rest);
    },
  };
  return { ...wrapped, default: wrapped };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { getSourceModulesDir } from '../../src/bot/internalSetup/utils/pathHelpers';
import { listDirFileSet, listModuleDirs, listScopeFiles } from '../../src/bot/internalSetup/fleet/syncManifest';
import { SyncAuthority, serveSyncRequest } from '../../src/bot/internalSetup/fleet/syncAuthority';
import { MSG } from '../../src/bot/internalSetup/fleet/protocol';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const authority: any = { getRevision: () => 3 };

describe('A06-2: sync listings fail on a read error', () => {
  beforeEach(() => {
    h.denied.clear();
    h.unreadable.clear();
  });

  it('a globaldata dir the master cannot list fails the listing instead of dropping its files', async () => {
    const lockedDir = dataPath('global', 'a062locked');
    write(path.join(lockedDir, 'keep.json'), '{}');
    expect(listScopeFiles('globaldata').some(f => f.path === 'a062locked/keep.json')).toBe(true);
    h.denied.add(path.resolve(lockedDir));
    expect(() => listScopeFiles('globaldata')).toThrow(/EACCES/);
    await expect(serveSyncRequest(authority, MSG.SYNC_FILES, { scope: 'globaldata' })).rejects.toThrow(/EACCES/);
  });

  it('a settings file the master cannot stat fails the listing', () => {
    const file = dataPath('global', 'a062mod', 'settings.json');
    write(file, '{}');
    h.denied.add(path.resolve(file));
    expect(() => listScopeFiles('settings')).toThrow(/EACCES/);
  });

  it('an unlistable modules dir fails listModuleDirs instead of answering no modules', () => {
    const dir = getSourceModulesDir();
    h.denied.add(path.resolve(dir));
    expect(() => listModuleDirs()).toThrow(/EACCES/);
  });

  it('an unlistable module subdir fails its file set', () => {
    const root = dataPath('a062tree');
    write(path.join(root, 'inner', 'a.js'), 'x');
    h.denied.add(path.resolve(root, 'inner'));
    expect(() => listDirFileSet(root)).toThrow(/EACCES/);
  });

  it('a globaldata file the master can stat but not read fails the listing', () => {
    const file = dataPath('global', 'a062unreadable', 'secret.json');
    write(file, '{}');
    h.unreadable.add(path.resolve(file));
    expect(() => listScopeFiles('globaldata')).toThrow(/EACCES/);
  });

  function hooks(applied = 0) {
    return {
      listWorkers: () => [{ nodeId: 'w1', nodeName: 'w1', syncAppliedRevision: applied, syncOk: true }],
      pushToNode: vi.fn(async () => ({})),
      getTerm: () => 1,
    };
  }

  it('a master that boots with an unlistable globaldata dir does not throw and pushes nothing', async () => {
    const lockedDir = dataPath('global', 'a062bootlocked');
    write(path.join(lockedDir, 'keep.json'), '{}');
    h.denied.add(path.resolve(lockedDir));
    const stub = hooks();
    let authority: any;
    expect(() => { authority = new SyncAuthority(stub); }).not.toThrow();
    expect(authority.getManifest()).toBeNull();
    await authority.pushTo('w1');
    authority.backstop();
    expect(stub.pushToNode).not.toHaveBeenCalled();
    h.denied.clear();
    const before = authority.getRevision();
    authority.backstop();
    expect(authority.getRevision()).toBe(before + 1);
    expect(stub.pushToNode).toHaveBeenCalled();
  });

  it('a recompute that cannot list globaldata keeps the revision and pushes nothing', () => {
    const lockedDir = dataPath('global', 'a062recompute');
    write(path.join(lockedDir, 'keep.json'), '{}');
    const stub = hooks(Number.MAX_SAFE_INTEGER);
    const authority: any = new SyncAuthority(stub);
    const revision = authority.getRevision();
    write(path.join(lockedDir, 'new.json'), '{"changed":true}');
    h.denied.add(path.resolve(lockedDir));
    authority.backstop();
    expect(authority.getRevision()).toBe(revision);
    expect(stub.pushToNode).not.toHaveBeenCalled();
  });

  it('an absent dir is still an empty listing', () => {
    expect(listDirFileSet(dataPath('global', 'a062-absent'))).toEqual([]);
  });
});
