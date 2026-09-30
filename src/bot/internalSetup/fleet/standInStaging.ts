/**
 * The placement a serve-only stand-in builds while its copy is still in
 * recovery (PLAN_REPLICATION 20.5, B7-F29). The read-only store cannot hold
 * it, and every boot reads the plan back from the copy, so without this the
 * operator's Declare Lost and every lease the stand-in granted vanished at the
 * write step (the copy promoted and the bot restarted), at the hand promote
 * (F9's exit into a true master) and at any serve-only re-boot mid-lane.
 *
 * The three documents that carry the placement are staged here per lane,
 * keyed on the arm's armedAt, and only while the lane still serves read-only
 * (its record at or before promoting): the old process drains for a while
 * after the restart that ends the lane, and must not stage over what the new
 * one landed. While the lane serves, the store reads the
 * staging back before the copy's own. The boot that first writes (the write
 * step's, or the takeover the hand promote boots, keyed on its takeover flag
 * because the promote disarms the record only after that restart resolved)
 * lands the documents ONCE and leaves a spent marker for the lane in their
 * place, so no later boot can land them over what that master persisted
 * since. Any boot of a different lane, or of one that ended without taking
 * writes, discards them, so a hand-back or a demote still costs nothing, as
 * serve-only must (MAP F2).
 */
import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import { PROMOTED_BY_HAND, readArmRecord } from './armRecord';
import type { ControlStore, PersistedFleetConfig, PersistedPlan, PersistedRegistry } from './controlStore';

export const STAGED_DOC_NAMES = ['plan', 'registry', 'fleet-config'] as const;
export type StagedDocName = typeof STAGED_DOC_NAMES[number];

export interface StandInStaging {
  /** The arm this staging belongs to; another lane's staging is never landed or read. */
  armedAt: number;
  docs: Partial<Record<StagedDocName, { body: string; at: number }>>;
  /** Landed already (or given up): the lane stages nothing more and nothing lands again. */
  spent: boolean;
}

/** What a read-only store does with the placement documents: writes go to the staging, reads come from it first. */
export interface StagingHooks {
  write(name: StagedDocName, body: string): void;
  read(name: StagedDocName): string | null;
}

const file = () => dataPath('global', FLEET_DIR, 'stand-in-staging.json');

export function isStagedDocName(name: string): name is StagedDocName {
  return (STAGED_DOC_NAMES as readonly string[]).includes(name);
}

export function readStandInStaging(): StandInStaging | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    if (!(parsed?.armedAt > 0) || typeof parsed?.docs !== 'object' || parsed.docs === null) return null;
    const docs: StandInStaging['docs'] = {};
    for (const name of STAGED_DOC_NAMES) {
      const doc = parsed.docs[name];
      if (doc && typeof doc.body === 'string' && Number.isFinite(doc.at)) docs[name] = { body: doc.body, at: Number(doc.at) };
    }
    return { armedAt: Number(parsed.armedAt), docs, spent: parsed.spent === true };
  } catch {
    return null;
  }
}

/** Mark the lane's staging landed or given up; true when the marker is in place (or the file is gone). */
export function spendStandInStaging(armedAt: number): boolean {
  try {
    atomicWriteFileSync(file(), JSON.stringify({ armedAt, docs: {}, spent: true }));
    return true;
  } catch {
    return clearStandInStaging();
  }
}

/** Remove the staging whatever lane it belongs to; a file that will not go is spent for its own lane instead. True when gone or spent. */
export function clearStandInStaging(): boolean {
  let current: StandInStaging | null = null;
  try {
    fs.unlinkSync(file());
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return true;
    current = readStandInStaging();
  }
  if (current === null) return false;
  try {
    atomicWriteFileSync(file(), JSON.stringify({ armedAt: current.armedAt, docs: {}, spent: true }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the lane armed at armedAt still serves read-only: its record on disk
 * is at or before promoting. The write step's parent writes promoted before
 * the restart, so the draining old process stages nothing more on that exit;
 * on the hand promote's exit the record stays serving until after the restart,
 * and the spent marker the landing leaves is what closes that process out.
 */
function laneStillStages(armedAt: number): boolean {
  const arm = readArmRecord();
  if (arm === null || arm.armedAt !== armedAt) return false;
  return arm.phase === 'claimed' || arm.phase === 'serving' || arm.phase === 'promoting';
}

/** Stage one document of the lane armed at armedAt; a staging another lane left is replaced, never merged; a spent lane stages nothing. */
export function stageStandInDoc(armedAt: number, name: StagedDocName, body: string): void {
  const current = readStandInStaging();
  if (current !== null && current.armedAt === armedAt && current.spent) return;
  if (!laneStillStages(armedAt)) return;
  const docs = current !== null && current.armedAt === armedAt ? current.docs : {};
  docs[name] = { body, at: Date.now() };
  atomicWriteFileSync(file(), JSON.stringify({ armedAt, docs, spent: false }, null, 2));
}

/** The staged body of one document of the lane armed at armedAt, or null. */
export function stagedDocBody(armedAt: number, name: StagedDocName): string | null {
  const staging = readStandInStaging();
  if (staging === null || staging.armedAt !== armedAt || staging.spent) return null;
  return staging.docs[name]?.body ?? null;
}

export function stagingHooksFor(armedAt: number): StagingHooks {
  return {
    write: (name, body) => stageStandInDoc(armedAt, name, body),
    read: name => stagedDocBody(armedAt, name),
  };
}

/**
 * The first writing boot of the lane lands its staged documents, plan first,
 * on the database that now takes writes. One shot: the staging is marked spent
 * before the first write, so a failure part-way is reported and never retried
 * over what this master persists from here. Another lane's staging is
 * discarded unlanded. Returns the names landed.
 */
export async function landStandInStaging(store: ControlStore, armedAt: number): Promise<StagedDocName[]> {
  const staging = readStandInStaging();
  if (staging === null || (staging.armedAt === armedAt && staging.spent)) return [];
  if (staging.armedAt !== armedAt) {
    clearStandInStaging();
    return [];
  }
  if (!spendStandInStaging(armedAt)) {
    throw new Error('the staging could not be marked spent, so nothing was landed rather than risk landing it twice');
  }
  const landed: StagedDocName[] = [];
  for (const name of STAGED_DOC_NAMES) {
    const doc = staging.docs[name];
    if (!doc) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(doc.body); } catch { continue; }
    try {
      if (name === 'plan') await store.savePlan(parsed as PersistedPlan);
      else if (name === 'registry') await store.saveRegistry(parsed as PersistedRegistry);
      else await store.saveFleetConfig(parsed as PersistedFleetConfig);
    } catch (error) {
      const first = landed.length > 0 ? `; ${landed.join(' and ')} landed first` : '';
      throw new Error(`${name} could not be written (${error instanceof Error ? error.message : error})${first}; the staging is spent`);
    }
    landed.push(name);
  }
  return landed;
}

/** The landing with its own report, for the boots that write: nothing here fails the boot. */
export async function landStandInStagingOrWarn(store: ControlStore, armedAt: number, prefix: string): Promise<void> {
  try {
    const landed = await landStandInStaging(store, armedAt);
    if (landed.length > 0) console.warn(`${prefix}: the placement made while serving read-only landed on this node's database (${landed.join(', ')})`);
  } catch (error) {
    console.error(`${prefix}: the placement made while serving read-only could not land: ${error instanceof Error ? error.message : error}; the plan read back is the one this database last held`);
  }
}

/**
 * A boot that cannot land or read the staging drops it: no arm record, another
 * lane, or a lane that ended without taking writes. The hand promote's exit
 * disarms the record before or after the takeover boot that lands, so that
 * reason keeps the staging on a takeover boot alone.
 */
export function reconcileStandInStaging(arm: { phase: string; armedAt: number; disarmReason: string | null } | null, takeoverBoot: boolean): void {
  const staging = readStandInStaging();
  if (staging === null) return;
  const live = arm !== null && arm.armedAt === staging.armedAt
    && (arm.phase !== 'disarmed' || (takeoverBoot && arm.disarmReason === PROMOTED_BY_HAND));
  if (!live) clearStandInStaging();
}
