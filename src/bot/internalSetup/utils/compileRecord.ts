import fs from 'fs';

let compileOpen = false;
const droppedRecords = new Set<string>();

/**
 * A module's dist folder was deleted with tsc's incremental record `record`. A compile running then writes the record
 * again when it ends, listing the deleted outputs as emitted, so that record is deleted once the compile has ended.
 */
export function distDropped(record: string): void {
  if (compileOpen) droppedRecords.add(record);
}

export function compileStarted(): void {
  compileOpen = true;
}

export function compileEnded(): void {
  compileOpen = false;
  for (const record of droppedRecords) {
    try {
      fs.rmSync(record, { force: true });
    } catch (error) {
      console.error(`[Reloader] Could not delete the compiler's record ${record} (${error instanceof Error ? error.message : String(error)}); a module whose compiled files are missing may load without them`);
    }
  }
  droppedRecords.clear();
}
