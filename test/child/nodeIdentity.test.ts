import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { freshDataDir, runScenario } from '../helpers/child';

// Each boot runs in its own process, so nothing carries over but node.json.
const boot = async (dataDir: string): Promise<string> => (await runScenario<string>('nodeIdentity.cjs', [], dataDir)).result;

describe('the node id across restarts', () => {
  it('is minted once, loaded on every later boot, and minted again only when node.json is unreadable', async () => {
    const dataDir = freshDataDir();
    const first = await boot(dataDir);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await boot(dataDir)).toBe(first);

    fs.writeFileSync(path.join(dataDir, 'global', 'fleet', 'node.json'), 'not json');
    const minted = await boot(dataDir);
    expect(minted).not.toBe(first);
    expect(await boot(dataDir)).toBe(minted);
  });
});
