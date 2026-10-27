import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/envLoader', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/utils/envLoader')>()),
  resolveDataBackend: () => 'file',
}));

import { MirrorEngine } from '../../src/bot/internalSetup/fleet/mirrorEngine';

// R39-J6: the mirror report counts every guild the copy holds now, complete and partial, from the current manifest.

function engine(): MirrorEngine {
  const e = new MirrorEngine({ request: async () => null, getTerm: () => 1, masterKnown: () => true, onChanged: () => undefined });
  (e as any).manifest = {
    sourceNodeId: 'n1', sourceNodeName: 'old', sourceTerm: 3, revision: 1, listedAt: 1, completedAt: Date.now(),
    guilds: {
      '111111111111111111': { hash: 'h1', files: { 'a.json': { size: 100, sha256: 'x' } } },
      '222222222222222222': { hash: null, files: { 'b.json': { size: 40, sha256: 'y' }, 'c.json': { size: 2, sha256: 'z' } } },
    },
    frozen: [], documents: {},
  };
  return e;
}

describe('A11-2 mirror report', () => {
  it('reports complete and partial guilds and bytes separately', () => {
    const r = engine().getReport()!;
    expect(r.guildCount).toBe(1);
    expect(r.totalBytes).toBe(100);
    expect(r.partialCount).toBe(1);
    expect(r.partialBytes).toBe(42);
  });

  it('follows guilds a migration forgot', () => {
    const e = engine();
    e.forgetGuilds(['222222222222222222'], Date.now());
    const r = e.getReport()!;
    expect(r.partialCount).toBe(0);
    expect(r.partialBytes).toBe(0);
  });
});

describe('A11-2 Fleet tab copy texts', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/webui/public/components/usage/FleetView.jsx'), 'utf8');
  const body = /function fleetCopyHolds\(m\) \{[\s\S]*?\n\}/.exec(src)![0];
  const holds = new Function(`${body}; return fleetCopyHolds;`)() as (m: any) => string;

  it('counts complete and partial guilds', () => {
    expect(holds({ guildCount: 1, totalBytes: 1048576, partialCount: 2, partialBytes: 1048576 })).toBe('3 guilds, 2.0 MB, 2 of them partial (incomplete, possibly mixing two passes)');
  });

  it('the mirror line names partial guilds held before any complete pass', () => {
    const fn = /function fleetMirrorCopyText\(mirror, skew\) \{[\s\S]*?\n\}/.exec(src)![0];
    const text = new Function('fleetFormatAge', `${body}; ${fn}; return fleetMirrorCopyText;`)(() => 'x') as (m: any, s: number) => string;
    expect(text({ completedAgoMs: null, guildCount: 0, totalBytes: 0, partialCount: 1, partialBytes: 1048576 }, 0)).toBe('none complete yet, holding 1 guild, 1.0 MB, 1 of them partial (incomplete, possibly mixing two passes)');
    expect(text({ completedAgoMs: null, guildCount: 0, totalBytes: 0 }, 0)).toBe('none yet');
  });
});
