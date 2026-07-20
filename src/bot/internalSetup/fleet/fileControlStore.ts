// Embedded file ControlStore under /data/global/fleet/ (dataRoot conventions).
// All writes are atomic temp+rename so a crash mid-write never leaves torn JSON.

import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import type { ControlStore, PersistedNode, PersistedPlan, PersistedTerm } from './controlStore';

export function atomicWriteFileSync(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf-8');
  // Windows can throw EPERM on rename-over-existing while a reader holds the
  // target open; a short bounded retry keeps the write atomic instead of
  // degrading to a torn direct write.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 3) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw error;
      }
      const waitUntil = Date.now() + 25 * (attempt + 1);
      while (Date.now() < waitUntil) { /* store writes are rare and tiny */ }
    }
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export class FileControlStore implements ControlStore {
  private file(name: string): string {
    return dataPath('global', FLEET_DIR, name);
  }

  // Embedded store: only this box's master process touches these files, so
  // read-increment-write is an adequate CAS. A shared store with a real CAS
  // row replaces this for warm-standby topologies.
  async acquireTerm(nodeId: string): Promise<number> {
    const current = readJson<PersistedTerm>(this.file('term.json'));
    const term = (current && Number.isFinite(current.term) ? current.term : 0) + 1;
    const persisted: PersistedTerm = { term, nodeId, updatedAt: Date.now() };
    atomicWriteFileSync(this.file('term.json'), JSON.stringify(persisted, null, 2));
    return term;
  }

  async getTerm(): Promise<PersistedTerm | null> {
    return readJson<PersistedTerm>(this.file('term.json'));
  }

  async savePlan(plan: PersistedPlan): Promise<void> {
    atomicWriteFileSync(this.file('leases.json'), JSON.stringify(plan, null, 2));
  }

  async loadPlan(): Promise<PersistedPlan | null> {
    return readJson<PersistedPlan>(this.file('leases.json'));
  }

  async saveRegistry(nodes: PersistedNode[]): Promise<void> {
    atomicWriteFileSync(this.file('registry.json'), JSON.stringify({ nodes, updatedAt: Date.now() }, null, 2));
  }

  async loadRegistry(): Promise<PersistedNode[]> {
    const parsed = readJson<{ nodes?: PersistedNode[] }>(this.file('registry.json'));
    return Array.isArray(parsed?.nodes) ? parsed!.nodes! : [];
  }
}
