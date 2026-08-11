// Which backend serves a guild's data. Default-only for now: per-guild
// overrides exist only while a backend transformation is active and are
// delivered with that machinery.

import { resolveDataBackend, DataBackendKind } from '../../../../utils/envLoader';

export function routeFor(_guildId: string): DataBackendKind {
  return resolveDataBackend();
}
