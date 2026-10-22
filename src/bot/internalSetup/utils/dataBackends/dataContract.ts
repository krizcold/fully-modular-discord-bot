// Which modules handle their own save outcomes (BT-5): a module whose manifest declares dataContract 2 sends its
// replies without the reply gate's wait, but never past a refusal. The module registry installs the reader of its
// live manifests, so a load, a hot reload or an unload counts at once.

type ManifestReader = (name: string) => { dataContract?: unknown } | undefined;

let reader: ManifestReader | null = null;

/** The ledger kinds tag core's own writes and replies: a module named like one never ungates them. */
const KINDS = new Set(['interaction', 'panel', 'console', 'message']);

export function setManifestReader(next: ManifestReader | null): void {
  reader = next;
}

export function declaresOwnOutcomes(name: string): boolean {
  return !KINDS.has(name) && reader?.(name)?.dataContract === 2;
}
