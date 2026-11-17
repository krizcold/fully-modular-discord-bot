// NX5 decisions 8 and 9: the bot's read of the manager's save order and its answer, the same on the claims pool and in
// the probe pass. The tables are the manager's (smdb_manager.save_order, smdb_manager.save_acks).

/** The save order as a database holds it; current is its generation = the database's. */
export interface SaveOrderRow {
  orderId: string;
  state: 'maintenance' | 'running';
  message: string;
  current: boolean;
}

export const CURRENT_GENERATION_SQL = 'coalesce((SELECT generation FROM smdb_manager.generation), 0)';

export const SAVE_ORDER_READ_SQL = `SELECT order_id, state, message, generation = ${CURRENT_GENERATION_SQL} AS current FROM smdb_manager.save_order`;

export function saveOrderOf(rows: Array<Record<string, unknown>>): SaveOrderRow | null {
  const row = rows[0];
  if (!row) return null;
  return { orderId: String(row.order_id), state: row.state === 'running' ? 'running' : 'maintenance', message: String(row.message ?? ''), current: row.current === true };
}
