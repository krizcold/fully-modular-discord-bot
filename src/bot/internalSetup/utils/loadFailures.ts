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
