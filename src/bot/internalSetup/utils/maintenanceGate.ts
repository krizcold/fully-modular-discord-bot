// The maintenance gate of the bot process. While it is closed no interaction handler, module listener or timer of
// module code runs, and every guild write is refused with the cause 'maintenance'.

import { AsyncLocalStorage } from 'async_hooks';

export const DEFAULT_MAINTENANCE_MESSAGE = 'This bot is down for maintenance. Please try again later.';

/**
 * 'hook': the manager's maintenance hook or the state file at boot; 'login-refused': the database refused the login;
 * 'order': the main database holds a current maintenance order (NX5).
 */
export type MaintenanceCause = 'hook' | 'login-refused' | 'order';

let gate: { cause: MaintenanceCause; message: string } | null = null;
let bootMode = false;
let inFlight = 0;
let orderRefusal = false;

/** NX5 decision 10: from enterForOrder's start, and while the last order read is a current maintenance order, shared ops are refused. */
export function setOrderRefusal(on: boolean): void {
  orderRefusal = on;
}

export function orderRefusesSharedOps(): boolean {
  return orderRefusal;
}

const passesOrder = new AsyncLocalStorage<true>();

/** Runs a Discord entitlement event's handler: its writes pass the order's refusal (NX5 decision 10, risk 1). */
export function runEntitlementEvent<T>(fn: () => T): T {
  return passesOrder.run(true, fn);
}

/**
 * NX5 ruling G8-9 (a): a core subsystem's save of a change it accepted and holds (its retry, its final stop pass, the
 * answer's save run) passes the order's refusal.
 */
export function runHeldResave<T>(fn: () => T): T {
  return passesOrder.run(true, fn);
}

/**
 * NX5 rulings G8-8 and G8-9: while the gate is closed and the order refuses shared ops, a global-scope write is refused
 * unless an entitlement event's handler or a core subsystem's re-save of a held change makes it.
 */
export function orderRefusesGlobalWrite(): boolean {
  return gate !== null && orderRefusal && passesOrder.getStore() !== true;
}

export function isMaintenanceGateClosed(): boolean {
  return gate !== null;
}

export function maintenanceCause(): MaintenanceCause | null {
  return gate?.cause ?? null;
}

/** The text every interaction and refused request gets while the gate is closed. */
export function maintenanceText(): string {
  return gate?.message || DEFAULT_MAINTENANCE_MESSAGE;
}

export function setMaintenanceGate(next: { cause: MaintenanceCause; message: string } | null): void {
  gate = next;
}

/** The process booted in maintenance mode: no data backend, no claim, no module, no ticker. */
export function isMaintenanceBoot(): boolean {
  return bootMode;
}

export function markMaintenanceBoot(): void {
  bootMode = true;
}

/** Runs a handler of module or internal code, counted until it settles, so entering maintenance can wait for it. */
export async function runTracked<T>(fn: () => T | Promise<T>): Promise<T> {
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
  }
}

export function handlersInFlight(): number {
  return inFlight;
}

let opsRunning = 0;

/**
 * NX5 ruling G8-12: an operation the process accepted that can still write after its entry check (a shared op, a
 * premium or Dummy mutator awaiting its provider), counted until it settles. One started inside another counts on its
 * own, since it can outlive the outer one.
 */
export async function runAcceptedOp<T>(fn: () => T | Promise<T>): Promise<T> {
  opsRunning += 1;
  try {
    return await fn();
  } finally {
    opsRunning -= 1;
  }
}

export function acceptedOpsRunning(): number {
  return opsRunning;
}

/** A Dummy provider call refused because the main database's maintenance order holds: the caller changed nothing. */
export class MaintenanceRefusal extends Error {
  readonly causeKey = 'maintenance';
}
