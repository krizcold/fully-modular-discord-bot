import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { getConfigProperty, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';

// Its own file: the root config path is made unreadable before the first config read of the process.
describe('a config read never writes over a config.json that cannot be read', () => {
  it('never queues a default over a config.json that exists but cannot be read', () => {
    expect(ROOT_CONFIG_PATH.startsWith(process.env.DATA_DIR!)).toBe(true);
    // A directory where the file should be: it exists, and every read of it fails, as EBUSY or EACCES would.
    fs.mkdirSync(ROOT_CONFIG_PATH, { recursive: true });
    fs.writeFileSync(path.join(ROOT_CONFIG_PATH, 'kept.txt'), 'operator settings stand-in');
    expect(() => getConfigProperty('DEVS')).not.toThrow();
    expect(getPending(ROOT_CONFIG_PATH)).toBeUndefined();
    expect(fs.statSync(ROOT_CONFIG_PATH).isDirectory()).toBe(true);
  });
});
