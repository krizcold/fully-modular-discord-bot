// Embedded file ControlStore under /data/global/fleet/ (dataRoot conventions).
// All writes are atomic temp+rename so a crash mid-write never leaves torn JSON.

import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import type { ControlStore, PersistedMigrations, PersistedPlan, PersistedRegistry, PersistedTerm, RedistributeProposal, ReshardArchive, ReshardMarker } from './controlStore';

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

  async saveRegistry(registry: PersistedRegistry): Promise<void> {
    atomicWriteFileSync(this.file('registry.json'), JSON.stringify(registry, null, 2));
  }

  async loadRegistry(): Promise<PersistedRegistry> {
    const parsed = readJson<PersistedRegistry>(this.file('registry.json'));
    return {
      nodes: Array.isArray(parsed?.nodes) ? parsed!.nodes! : [],
      lostNodes: Array.isArray(parsed?.lostNodes) ? parsed!.lostNodes! : undefined,
      updatedAt: Number(parsed?.updatedAt) || 0,
    };
  }

  async archivePlan(archive: ReshardArchive): Promise<string> {
    const file = dataPath('global', FLEET_DIR, 'archive', `plan-${archive.from}-${archive.archivedAt}.json`);
    atomicWriteFileSync(file, JSON.stringify(archive, null, 2));
    return file;
  }

  async loadReshardMarker(): Promise<ReshardMarker | 'corrupt' | null> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file('reshard-pending.json'), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return 'corrupt';
    }
    try {
      return JSON.parse(raw) as ReshardMarker;
    } catch {
      return 'corrupt';
    }
  }

  async saveReshardMarker(marker: ReshardMarker): Promise<void> {
    atomicWriteFileSync(this.file('reshard-pending.json'), JSON.stringify(marker, null, 2));
  }

  async clearReshardMarker(): Promise<void> {
    try {
      fs.unlinkSync(this.file('reshard-pending.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async saveMigrations(state: PersistedMigrations): Promise<void> {
    atomicWriteFileSync(this.file('migrations.json'), JSON.stringify(state, null, 2));
  }

  async loadMigrations(): Promise<PersistedMigrations> {
    const parsed = readJson<PersistedMigrations>(this.file('migrations.json'));
    return {
      active: parsed?.active ?? null,
      history: Array.isArray(parsed?.history) ? parsed!.history! : [],
      updatedAt: Number(parsed?.updatedAt) || 0,
    };
  }

  async saveRedistributeProposal(proposal: RedistributeProposal | null): Promise<void> {
    const file = this.file('redistribute-proposal.json');
    if (proposal === null) {
      try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return;
    }
    atomicWriteFileSync(file, JSON.stringify(proposal, null, 2));
  }

  async loadRedistributeProposal(): Promise<RedistributeProposal | null> {
    const parsed = readJson<RedistributeProposal>(this.file('redistribute-proposal.json'));
    if (!parsed || typeof parsed.proposal !== 'object' || parsed.proposal === null) return null;
    return { proposal: parsed.proposal, updatedAt: Number(parsed.updatedAt) || 0 };
  }
}
