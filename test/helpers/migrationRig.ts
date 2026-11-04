import fs from 'fs';
import path from 'path';
import { FakeDb } from './fakePg';
import { MigrationService, type MigrationHost, type RunningMigration, type ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';

// NB3's job on this process's throwaway data root, against FakeDb, with a host that stands in for BotManager.

export const root = process.env.DATA_DIR as string;
export const PG_URL = 'postgres://bot:pw@db.example:5432/smdb';
export const MARKER = path.join(root, '.backend.json');
export const JOURNAL = path.join(root, '.migration.json');
export const STORES = path.join(root, '.stores.json');
export const ENV = path.join(root, '.env');

export function wipeRoot(): void {
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

/** An empty data root of a JSON bot that has booted once, so its marker exists (the boot guard writes it). */
export function freshJsonBot(): void {
  wipeRoot();
  fs.writeFileSync(MARKER, JSON.stringify({ live: 'file', storeId: null, flippedAt: 1 }, null, 2));
}

export class FakeHost implements MigrationHost {
  lock: RunningMigration | null = null;
  state: { ok: true } | { ok: false; error: string } = { ok: true };
  calls: string[] = [];
  takeMigrationLock(job: RunningMigration): boolean {
    this.calls.push('take');
    if (this.lock) return false;
    this.lock = job;
    return true;
  }
  releaseMigrationLock(): void {
    this.calls.push('release');
    this.lock = null;
  }
  migrationRunning(): RunningMigration | null {
    return this.lock;
  }
  migrationBotState(): { ok: true } | { ok: false; error: string } {
    return this.state;
  }
}

export function seedFile(rel: string, content: string | Buffer): void {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function serviceFor(db: FakeDb, host: MigrationHost = new FakeHost(), extra: ServiceOptions = {}): MigrationService {
  return new MigrationService(host, { connect: async (_url, app) => db.connect(app), nodeId: () => 'node-test', lockTimeoutMs: 1000, secondLookMs: 10, ...extra });
}

/** Every byte under the data root, for "nothing was written" checks. */
export function snapshotRoot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out[r] = fs.readFileSync(path.join(dir, e.name)).toString('base64');
    }
  };
  walk(root, '');
  return out;
}

/** A job or answer as text for an assertion's message, so a failure shows its stage and error. */
export function why(value: unknown): string {
  return JSON.stringify(value);
}

export function useDatabaseUrl(url = PG_URL): void {
  process.env.DATA_BACKEND_URL = url;
}
