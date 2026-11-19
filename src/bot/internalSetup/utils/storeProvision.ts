import { commitMayHaveLanded, describeFailure, inspectStore, provisionStoreInTransaction, SCHEMA_VERSION, type StoreVerdict } from './dataBackends/postgresBackend';
import { addressListText, closeSession, COMMIT_BOUND_MS, destroySession, isAddressList, openJobSession, within, type PgSession } from './dataMigration';
import { pgConfig, pgConfigCause, showEntry } from '../../../utils/databaseAddress';

export type StoreProvisionOutcome =
  | { state: 'created'; storeId: string; version: number }
  | { state: 'refused' | 'failed' | 'unconfirmed'; line: string };

const NOTHING = 'nothing was created';

/** Why the bot's own boot check would refuse the store just made; null when it matches. */
function checkRefusal(verdict: StoreVerdict): string | null {
  if (verdict.kind === 'matches') return null;
  if (verdict.kind === 'refused') return verdict.refusal.reason;
  if (verdict.kind === 'version') return `its schema_version reads ${verdict.found}`;
  return 'the schema it made holds no relation';
}

/**
 * `smdb data provision`: an empty store of the current layout in the database `url` names, in one transaction under
 * the bootstrap lock, checked as the bot's boot checks a store before the COMMIT. A database that already holds the
 * schema smdb_data is refused and left as it was.
 */
export async function provisionEmptyStore(url: string, opts: { commitBoundMs?: number } = {}): Promise<StoreProvisionOutcome> {
  const refused = (why: string): StoreProvisionOutcome => ({ state: 'refused', line: `data provision refused: ${why}; ${NOTHING}` });
  const raw = url.trim();
  if (raw === '') return refused('DATA_BACKEND_URL is not set');
  if (isAddressList(raw)) return refused(addressListText(raw, 'a provision'));
  try {
    pgConfig(raw);
  } catch (error) {
    const cause = pgConfigCause(raw, error);
    return refused(cause.startsWith('it ') ? `DATA_BACKEND_URL ${cause.slice(3)}` : `DATA_BACKEND_URL cannot be used: ${cause}`);
  }
  const shown = showEntry(raw);
  let session: PgSession;
  try {
    session = await openJobSession(raw, 'smdb-provision', 'job');
  } catch (error) {
    return refused(`the database ${shown} could not be opened (${describeFailure(error).detail})`);
  }
  const unconfirmed = (why: string): StoreProvisionOutcome => ({
    state: 'unconfirmed',
    line: `can't confirm whether data provision created a store at ${shown}: ${why}; check whether the schema smdb_data exists there`,
  });
  let committing = false;
  let destroyed = false;
  try {
    await session.query('BEGIN');
    await session.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_bootstrap'))`);
    const held = await session.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'smdb_data'`);
    if (held.rows.length > 0) {
      await session.query('ROLLBACK').catch(() => undefined);
      return refused(`the database ${shown} already holds the schema smdb_data`);
    }
    const storeId = await provisionStoreInTransaction(session);
    const refusal = checkRefusal(await inspectStore(session as unknown as Parameters<typeof inspectStore>[0]));
    if (refusal !== null) {
      await session.query('ROLLBACK').catch(() => undefined);
      return refused(`the database ${shown} can't hold this bot's store: ${refusal}`);
    }
    committing = true;
    const bound = opts.commitBoundMs ?? COMMIT_BOUND_MS;
    const answered = await within(session.query('COMMIT'), bound);
    if (!answered) {
      destroySession(session);
      destroyed = true;
      return unconfirmed(`the COMMIT got no answer within ${bound / 1000} s`);
    }
    if (answered.value.command === 'ROLLBACK') {
      return { state: 'failed', line: `data provision failed at ${shown}: the database rolled the transaction back at its COMMIT; ${NOTHING}` };
    }
    return { state: 'created', storeId, version: SCHEMA_VERSION };
  } catch (error) {
    const detail = describeFailure(error).detail;
    if (committing && commitMayHaveLanded(error)) return unconfirmed(`the COMMIT got no clear answer (${detail})`);
    if (!committing) await session.query('ROLLBACK').catch(() => undefined);
    return { state: 'failed', line: `data provision failed at ${shown}: ${detail}; ${NOTHING}` };
  } finally {
    if (!destroyed) await closeSession(session);
  }
}
