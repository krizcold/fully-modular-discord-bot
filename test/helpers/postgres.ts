import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

// The production sidecar's image; testcontainers picks a free host port and
// its reaper removes the container even if the run dies.
export const POSTGRES_IMAGE = 'postgres:16-alpine';

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE).start();
}

export function poolFor(container: StartedPostgreSqlContainer): Pool {
  return new Pool({ connectionString: container.getConnectionUri(), max: 8 });
}

let databases = 0;

/**
 * A new, empty database on the container and its URL: the steps of one test row see only what that row wrote, as one
 * bot's database holds only its own fleet's rows.
 */
export async function freshDatabaseUrl(container: StartedPostgreSqlContainer, prefix: string): Promise<string> {
  const name = `${prefix}_${process.pid}_${++databases}`;
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return `postgres://${encodeURIComponent(container.getUsername())}:${encodeURIComponent(container.getPassword())}@${container.getHost()}:${container.getPort()}/${name}`;
}
