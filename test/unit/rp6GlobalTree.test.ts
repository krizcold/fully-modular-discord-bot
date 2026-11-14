import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { dropGlobalKey, forgetGlobalTree, globalPlacement, noteGlobalKey } from '../../src/bot/internalSetup/utils/sharedStore';

// L5 run A, rp6 chunk of sharedStore.ts: rule P over the global keys (decision 18). The tree is listed from the files
// under /data/global at the first check after a forget; the App Store's cache and temp files are not keys.

function put(rel: string, bytes = '{}'): void {
  const file = dataPath('global', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

beforeEach(() => {
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  forgetGlobalTree();
});

describe('the files the tree is listed from', () => {
  it("does not list the App Store's cache, and lists the store's other files (rp6-29, rp6-30)", () => {
    put('appstore/cache/r1/Modules/m/index.js');
    put('appstore/installed.json');
    expect(globalPlacement('appstore/cache/r1/Modules/m/index.js/x')).toBeNull();
    expect(globalPlacement('appstore/installed.json/x')).toEqual({
      reason: 'the folder appstore/installed.json of it is a file', entry: 'appstore/installed.json', entryKind: 'file',
    });
  });

  it('does not list a temp file left beside a key, and lists the key (rp6-31, rp6-32)', () => {
    put('rp6t/a.json.tmp');
    put('rp6t/a.json');
    expect(globalPlacement('rp6t/a.json.tmp/x')).toBeNull();
    expect(globalPlacement('rp6t/a.json/x')).toEqual({ reason: 'the folder rp6t/a.json of it is a file', entry: 'rp6t/a.json', entryKind: 'file' });
  });
});

describe('the tree between lists', () => {
  it('a dropped key no longer stands in the way of a folder of the same name (rp6-33)', () => {
    expect(globalPlacement('rp6d/first.json')).toBeNull();
    noteGlobalKey('rp6d/a.json');
    expect(globalPlacement('rp6d/a.json/b')).toEqual({ reason: 'the folder rp6d/a.json of it is a file', entry: 'rp6d/a.json', entryKind: 'file' });
    dropGlobalKey('rp6d/a.json');
    expect(globalPlacement('rp6d/a.json/b')).toBeNull();
  });

  it('a forget lists the files again at the next check, with a file written since (rp6-34)', () => {
    expect(globalPlacement('rp6f/first.json')).toBeNull();
    put('rp6f/n.json');
    expect(globalPlacement('rp6f/n.json/x')).toBeNull();
    forgetGlobalTree();
    expect(globalPlacement('rp6f/n.json/x')).toEqual({ reason: 'the folder rp6f/n.json of it is a file', entry: 'rp6f/n.json', entryKind: 'file' });
  });
});
