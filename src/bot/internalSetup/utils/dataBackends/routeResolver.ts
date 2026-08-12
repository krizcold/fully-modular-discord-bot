// Which backend serves a guild's data. Per-guild overrides exist only while a
// backend transformation is active: converted guilds route to the destination,
// everything else follows the default.

import { resolveDataBackend, DataBackendKind } from '../../../../utils/envLoader';

// Recognition-guard override (transformation-required state): the node keeps
// serving from the marker-named LIVE backend even though DATA_BACKEND names
// the other one, until a transformation actually moves the data.
let forcedDefault: DataBackendKind | null = null;

const overrides = new Map<string, DataBackendKind>();

export function forceRouteDefault(kind: DataBackendKind | null): void {
  forcedDefault = kind;
}

export function setRouteOverride(guildId: string, kind: DataBackendKind): void {
  overrides.set(guildId, kind);
}

export function clearRouteOverride(guildId: string): void {
  overrides.delete(guildId);
}

/** Replace the whole override map (delivered routing map; null/empty clears). */
export function applyRouteOverrides(routes: { guildId: string; backend: DataBackendKind }[] | null): void {
  overrides.clear();
  for (const route of routes ?? []) overrides.set(route.guildId, route.backend);
}

export function getRouteOverrides(): { guildId: string; backend: DataBackendKind }[] {
  return [...overrides.entries()].map(([guildId, backend]) => ({ guildId, backend }));
}

export function routeFor(guildId: string): DataBackendKind {
  return overrides.get(guildId) ?? forcedDefault ?? resolveDataBackend();
}

/** The default every non-overridden guild currently routes to (the node's LIVE backend). */
export function currentRouteDefault(): DataBackendKind {
  return forcedDefault ?? resolveDataBackend();
}
