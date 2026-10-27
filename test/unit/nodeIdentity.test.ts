import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppVersion, getNodeName } from '../../src/bot/internalSetup/fleet/nodeIdentity';

const repo = path.resolve(__dirname, '..', '..');

describe('the node name', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is NODE_NAME without its spaces, or the host name when that is blank or unset', () => {
    vi.stubEnv('NODE_NAME', '  node-a  ');
    expect(getNodeName()).toBe('node-a');
    vi.stubEnv('NODE_NAME', '   ');
    expect(getNodeName()).toBe(os.hostname());
    vi.stubEnv('NODE_NAME', undefined as unknown as string);
    expect(getNodeName()).toBe(os.hostname());
  });
});

describe('the app version', () => {
  it("is the bot's package.json version", () => {
    expect(getAppVersion()).toBe(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
  });
});
