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
