import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { flushAll, writeRawAtomic } from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { getConfigProperty, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';

const ticketNames = (ledger: ReturnType<typeof openLedger>) =>
  ledger.tickets().map(t => [path.basename((t.ticket as { path: string }).path), t.modules]);

// Its own file: the rows run in order from a process with no config read and no config.json.
describe('root config reads with the exit drain open', () => {
  it('never replaces a queued write that has not landed', async () => {
    expect(fs.existsSync(ROOT_CONFIG_PATH)).toBe(false);
    writeRawAtomic(ROOT_CONFIG_PATH, JSON.stringify({ DEVS: ['111'] }));
    expect(getConfigProperty('DEVS')).toEqual(['111']);
    expect(getPending(ROOT_CONFIG_PATH)).toMatchObject({ op: 'write', content: '{"DEVS":["111"]}' });
    await flushAll();
    expect(JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'))).toEqual({ DEVS: ['111'] });
  });

  it('writes nothing for a property config.json does not hold', async () => {
    const ledger = openLedger('interaction');
    expect(runInLedger(ledger, 'modA', () => getConfigProperty('testMode'))).toBe(false);
    expect(ledger.tickets()).toEqual([]);
    expect(getPending(ROOT_CONFIG_PATH)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'))).toEqual({ DEVS: ['111'] });
  });

  it('never creates a config.json missing from disk, and the read records nothing', async () => {
    fs.rmSync(ROOT_CONFIG_PATH);
    const ledger = openLedger('interaction');
    // A missing config.json answers the env value, then the schema default.
    process.env.DEVS = '111,222';
    try {
      expect(runInLedger(ledger, 'modA', () => getConfigProperty('DEVS'))).toEqual(['111', '222']);
    } finally {
      delete process.env.DEVS;
    }
    expect(runInLedger(ledger, 'modA', () => getConfigProperty('DEVS'))).toEqual([]);
    expect(getConfigProperty('adminPanel.itemsPerPage')).toBe(10);
    expect(ticketNames(ledger)).toEqual([]);
    expect(ledger.refusals()).toEqual([]);
    expect(getPending(ROOT_CONFIG_PATH)).toBeUndefined();
    await flushAll();
    expect(fs.existsSync(ROOT_CONFIG_PATH)).toBe(false);
  });

  it('never replaces a config.json that another writer lands after a read found it missing', async () => {
    expect(fs.existsSync(ROOT_CONFIG_PATH)).toBe(false);
    getConfigProperty('DEVS');
    // A writer outside this process's queue (the web UI parent's saveGlobalConfig, the co-worker sync's rename, an
    // operator restoring a backup) lands the file.
    fs.writeFileSync(ROOT_CONFIG_PATH, JSON.stringify({ DEVS: ['222'] }));
    await flushAll();
    expect(JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'))).toEqual({ DEVS: ['222'] });
  });
});
