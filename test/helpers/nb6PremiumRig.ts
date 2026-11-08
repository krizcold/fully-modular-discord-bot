import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { mirrorRig } from './nb6Mirror';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { _resetPremiumItems } from '../../src/bot/internalSetup/utils/premiumItems';

// Premium on a Postgres bot (NB6 part 11): the real PremiumManager in the bot process role over the mirror rig's real
// row flush and scripted shared tables. Premium's file is the key global/premium-tiers.json; its audit log and its
// events journal are lines keys.

export const PREMIUM_KEY = 'global/premium-tiers.json';
export const AUDIT_KEY = 'global/premium-tiers.audit.jsonl';
export const JOURNAL_KEY = 'global/premium-tiers.events.jsonl';

export function premiumRig() {
  const m = mirrorRig('nb6prem');
  const role = process.env.BOT_PROCESS_ROLE;
  return {
    m,
    async setup(asBot = true): Promise<void> {
      if (asBot) process.env.BOT_PROCESS_ROLE = 'bot';
      else delete process.env.BOT_PROCESS_ROLE;
      await m.setup();
      // The flush writes a key's mirror into its folder; the bot's /data/global exists before premium's first save.
      fs.mkdirSync(dataPath('global'), { recursive: true });
      resetPremiumManager();
      _resetPremiumItems();
    },
    async teardown(): Promise<void> {
      resetPremiumManager();
      _resetPremiumItems();
      await m.teardown();
      if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
      else process.env.BOT_PROCESS_ROLE = role;
    },
    pm: () => getPremiumManager(),
    /** Flush passes until this process holds no row op (one pass sends one op of a key). */
    async settle(): Promise<void> {
      await settleRows();
    },
    /** The stored lines of a key in seq order, parsed. */
    lines(key: string): any[] {
      return [...m.state.rows.lines.values()].filter(l => l.key === key).sort((a, b) => a.seq - b.seq).map(l => JSON.parse(l.line.toString('utf8')));
    },
    /** The stored premium-tiers.json row, parsed; null with no row. */
    row(): any {
      const row = m.state.rows.docs.get(PREMIUM_KEY);
      return row ? JSON.parse(row.body.toString('utf8')) : null;
    },
    /** The log lines written so far that contain the text. */
    logged(text: string): string[] {
      return m.state.lines.filter(l => l.includes(text));
    },
  };
}

/** A tier as setTier takes it. */
export const tier = (name: string, priority: number) => ({ displayName: name, priority, overrides: {}, offerings: [] });

/** Flush passes until this process holds no row op (one pass sends one op of a key). */
export async function settleRows(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await dm.flushAll();
    if (rowQueue.keys().length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
