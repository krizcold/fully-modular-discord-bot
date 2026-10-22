import type { Pool } from 'pg';

// A client left checked out (a test that failed before releasing it, or a
// mutant that skips the release) holds pool.end() forever: an afterAll waits
// at most this long, so the file ends and its report is written
// (mutation/README.md, pass B).
export async function endPool(pool: Pool | undefined, ms = 10_000): Promise<void> {
  if (!pool) return;
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([pool.end(), bound]);
  } finally {
    clearTimeout(timer);
  }
}
