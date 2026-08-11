// Which backend serves a guild's data. Default-only for now: per-guild
// overrides exist only while a backend transformation is active and are
// delivered with that machinery.

import { resolveDataBackend, DataBackendKind } from '../../../../utils/envLoader';

// Recognition-guard override (transformation-required state): the node keeps
// serving from the marker-named LIVE backend even though DATA_BACKEND names
// the other one, until a transformation actually moves the data.
let forcedDefault: DataBackendKind | null = null;

export function forceRouteDefault(kind: DataBackendKind | null): void {
  forcedDefault = kind;
}

export function routeFor(_guildId: string): DataBackendKind {
  return forcedDefault ?? resolveDataBackend();
}
