// The maintenance gate of the bot process. While it is closed no interaction handler, module listener or timer of
// module code runs, and every guild write is refused with the cause 'maintenance'.

export const DEFAULT_MAINTENANCE_MESSAGE = 'This bot is down for maintenance. Please try again later.';

/** 'hook': the manager's maintenance hook or the state file at boot; 'login-refused': the database refused the login. */
export type MaintenanceCause = 'hook' | 'login-refused';

let gate: { cause: MaintenanceCause; message: string } | null = null;
let bootMode = false;
let inFlight = 0;

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
