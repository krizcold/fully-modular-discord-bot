import type { DataBackendKind } from '../../src/utils/envLoader';

// setup.ts wraps resolveDataBackend so a test can pick the bot's one backend
// without a DATA_BACKEND in the scrubbed env; null falls back to the real one.
let forced: DataBackendKind | null = null;

export function setBackendKind(kind: DataBackendKind | null): void {
  forced = kind;
}

export function withBackendKind<T extends { resolveDataBackend(): DataBackendKind }>(real: T): T {
  return { ...real, resolveDataBackend: () => forced ?? real.resolveDataBackend() };
}
