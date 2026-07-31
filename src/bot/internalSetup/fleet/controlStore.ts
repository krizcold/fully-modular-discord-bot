// ControlStore - persistence seam for the control plane (terms, leases,
// registry). Phase 1 ships the embedded file implementation; an external
// store with real CAS replaces it for multi-master durability later, behind
// this same interface.

import type { LeaseInfo, NodeCapabilities } from './protocol';

export interface PersistedTerm {
  term: number;
  nodeId: string;
  updatedAt: number;
}

export interface PersistedAssignment {
  nodeId: string;
  leases: LeaseInfo[];
}

export interface PersistedPlan {
  term: number;
  epoch: number;
  shardCount: number;
  assignments: PersistedAssignment[];
  updatedAt: number;
}

export interface PersistedNode {
  nodeId: string;
  nodeName: string;
  appVersion: string;
  capabilities: NodeCapabilities;
  lastSeenAt: number;
}

/** Outgoing plan + registry snapshot written on a confirmed reshard; ownership records are archived, never discarded. */
export interface ReshardArchive {
  plan: PersistedPlan;
  registry: PersistedNode[];
  archivedAt: number;
  from: number;
  to: number;
}

/** Reshard pause marker (reshard-pending.json): while it exists, ANY boot enters the pause regardless of env. */
export interface ReshardMarker {
  from: number;
  to: number;
  at: number;
  archiveFile: string;
}

export interface ControlStore {
  /** CAS-acquire a new master term: strictly greater than any previously stored term. */
  acquireTerm(nodeId: string): Promise<number>;
  getTerm(): Promise<PersistedTerm | null>;
  savePlan(plan: PersistedPlan): Promise<void>;
  loadPlan(): Promise<PersistedPlan | null>;
  saveRegistry(nodes: PersistedNode[]): Promise<void>;
  loadRegistry(): Promise<PersistedNode[]>;
  /** Archive the outgoing plan + registry on a confirmed reshard; returns the archive file reference. */
  archivePlan(archive: ReshardArchive): Promise<string>;
  /** Fail-closed: null ONLY when the marker file does not exist; any other read/parse failure returns 'corrupt' (still a pause). */
  loadReshardMarker(): Promise<ReshardMarker | 'corrupt' | null>;
  saveReshardMarker(marker: ReshardMarker): Promise<void>;
  clearReshardMarker(): Promise<void>;
}
