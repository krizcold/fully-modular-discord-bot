// This machine's node id as the web UI reads it (NB7 decision 13): /data/global/fleet/node.json, never written here.
// The bot's getNodeId() mints the file when absent; null here means this machine has never run a bot.

import * as fs from 'fs';
import { dataPath } from '../../utils/dataRoot';
import { FLEET_DIR } from '../../bot/internalSetup/fleet/constants';

export function readThisNodeId(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath('global', FLEET_DIR, 'node.json'), 'utf-8'));
    return parsed && typeof parsed.nodeId === 'string' && parsed.nodeId.length > 0 ? parsed.nodeId : null;
  } catch {
    return null;
  }
}
