import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { freshDataDir, runScenario } from '../helpers/child';

// A node's identity and role override across real restarts: each step runs in
// its own process, so nothing carries over but what is on disk. The contract
// is nodeIdentity.ts's own: the takeover flags are one-shot, consumed after a
// successful term acquisition so a later restart never re-triggers them, while
// the role and the stand-in mark stay (dropping standIn would leave a serving
// stand-in indistinguishable from a true master on its next boot).

interface Override { role: string; takeover?: true; chainTakeover?: true; standIn?: true; setAt: number; setBy: string }
interface Read { override: Override | null; role: string; standIn: boolean }
interface NodeId { nodeId: string; fresh: boolean }

const step = async <T>(dataDir: string, ...args: string[]): Promise<T> => (await runScenario<T>('fleetIdentity.cjs', args, dataDir)).result;

describe('the role override across restarts', () => {
  const cases: Override[] = [
    { role: 'master', takeover: true, chainTakeover: true, standIn: true, setAt: 1234, setBy: 'webui-promote' },
    { role: 'master', takeover: true, standIn: true, setAt: 1234, setBy: 'webui-promote' },
    { role: 'master', chainTakeover: true, standIn: true, setAt: 1234, setBy: 'webui-promote' },
    { role: 'master', takeover: true, setAt: 1234, setBy: 'webui-promote' },
    { role: 'co-worker', chainTakeover: true, setAt: 99, setBy: 'webui-demote' },
  ];

  it.each(cases)('consumes the one-shot flags and keeps the rest: %o', async written => {
    const dataDir = freshDataDir();
    const standIn = written.standIn === true;
    await step(dataDir, 'write-override', JSON.stringify(written));
    expect(await step<Read>(dataDir, 'read')).toEqual({ override: written, role: written.role, standIn });

    const kept = { role: written.role, ...(standIn ? { standIn: true } : {}), setAt: written.setAt, setBy: written.setBy };
    expect(await step<Override>(dataDir, 'consume')).toEqual(kept);
    expect(await step<Read>(dataDir, 'read')).toEqual({ override: kept, role: written.role, standIn });
  });

  it('leaves an override with no takeover flag as it was', async () => {
    const dataDir = freshDataDir();
    const written: Override = { role: 'master', standIn: true, setAt: 7, setBy: 'webui-promote' };
    await step(dataDir, 'write-override', JSON.stringify(written));
    expect(await step<Override>(dataDir, 'consume')).toEqual(written);
    expect(await step<Read>(dataDir, 'read')).toEqual({ override: written, role: 'master', standIn: true });
  });
});

describe('the node id across restarts', () => {
  it('is minted once, loaded on every later boot, and minted again only when node.json is unreadable', async () => {
    const dataDir = freshDataDir();
    const first = await step<NodeId>(dataDir, 'node-id');
    expect(first.fresh).toBe(true);
    expect(first.nodeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await step<NodeId>(dataDir, 'node-id')).toEqual({ nodeId: first.nodeId, fresh: false });

    fs.writeFileSync(path.join(dataDir, 'global', 'fleet', 'node.json'), 'not json');
    const minted = await step<NodeId>(dataDir, 'node-id');
    expect(minted.fresh).toBe(true);
    expect(minted.nodeId).not.toBe(first.nodeId);
    expect(await step<NodeId>(dataDir, 'node-id')).toEqual({ nodeId: minted.nodeId, fresh: false });
  });
});
