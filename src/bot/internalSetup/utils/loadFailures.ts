const failures = new Set<string>();

/** Names what failed to load at this boot; the orphan command sweep refuses to run while any is recorded. */
export function recordLoadFailure(what: string): void {
  failures.add(what);
}

export function getLoadFailures(): string[] {
  return [...failures];
}

export function clearLoadFailures(): void {
  failures.clear();
}

let reloadsInFlight = 0;
let reloadsStarted = 0;

/** Marks a module reload as running; the orphan sweep refuses to delete while one runs or after one started. */
export function beginReload(): void {
  reloadsInFlight++;
  reloadsStarted++;
}

export function endReload(): void {
  if (reloadsInFlight > 0) reloadsInFlight--;
}

export function getReloadState(): { inFlight: number; started: number } {
  return { inFlight: reloadsInFlight, started: reloadsStarted };
}
