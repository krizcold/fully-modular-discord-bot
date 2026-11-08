// Premium's side effects bound to the op that stores their change (NB6 decisions 47, 48, 63, 64, 73, 75 and 76): an
// audit line, a member notice or a provider event is an item, made with a link. A `{ carry }` item joins a list that
// the save given that list takes into its op; a `{ standalone }` item records or announces what no premium file holds.
// Items settle with their op: landed, the lines are stored and the effects run in the item's own async context;
// refused or 'unconfirmed', the effects are dropped and logged and each audit line is written marked.

import { AsyncResource } from 'async_hooks';
import { currentLedger, outsideLedgers, runSealed, type LedgerTicket, type WriteLedger } from './dataBackends/writeLedger';

export type ItemKind = 'audit' | 'notice' | 'event';

/**
 * Why an item's effect does not go out: its op was refused (with the cause words), ended 'unconfirmed', or the stop;
 * 'unsure' is the stop while its op's COMMIT may have landed (words: when, as "before this stop").
 */
export type DropHow =
  | { kind: 'refused'; words: string }
  | { kind: 'unconfirmed' }
  | { kind: 'stopped'; words: string }
  | { kind: 'unsure'; words: string };

export interface Item {
  readonly kind: ItemKind;
  /** The shared_lines id of an audit line, minted when the line was built; a notice's or event's own id. */
  readonly id: string;
  /** The manager that made it: its exit handler logs its open items. */
  readonly owner: object;
  /** currentLedger() when it was made: its effect's save and installs are recorded there. */
  readonly ledger: WriteLedger | undefined;
  readonly scope: AsyncResource;
  /** An audit item's line, as stored. */
  readonly line?: string;
  /** An audit item's line marked `notSaved` (decision 48). */
  marked?(cause: string, at: string): string;
  /** The effect (a notice, a provider event); for an audit item, the JSON bot's append. */
  run(): unknown;
  /** Logs that the item did not go out, and answers whoever waits for it. */
  drop(how: DropHow): void;
  /** The audit item's line landed, or its marked copy was queued; for an install line, its entry follows. */
  settledLine?(state: 'landed' | 'gone', ticket?: LedgerTicket): void;
  open: boolean;
}

/** A list of items one save takes into its op (decision 63). */
export class Carry {
  readonly items: Item[] = [];
}

export const newCarry = (): Carry => new Carry();

/** How an item is tied to the op that stores its change (decision 73). */
export type Link = { carry: Carry } | { standalone: string };

/** How a save's op settled (decision 63). */
export type SaveOutcome = 'landed' | { refused: string } | 'unconfirmed';

/**
 * The handle of the op a save started (decision 63): on a Postgres bot its outcome; on a JSON bot `outcome` is null
 * and `ticket` is NB13's file ticket, which NB10's verdict judges.
 */
export interface SaveOp {
  key: string;
  outcome: Promise<SaveOutcome> | null;
  ticket?: LedgerTicket;
}

const openItems = new Set<Item>();
const waiters = new Set<() => void>();

function wake(): void {
  for (const w of [...waiters]) w();
}

/** Makes an item in the current async context and registers it open. */
export function makeItem(spec: Omit<Item, 'ledger' | 'scope' | 'open'>): Item {
  const item: Item = { ...spec, ledger: currentLedger(), scope: new AsyncResource('PremiumItem'), open: true };
  openItems.add(item);
  return item;
}

function close(item: Item): void {
  if (!item.open) return;
  item.open = false;
  openItems.delete(item);
  item.scope.emitDestroy();
  wake();
}

/**
 * Runs an item's effect in its creator's context (decision 64): in its ledger while that ledger is open, else in a
 * console ledger of its own outside every other. The item stays open until the effect's promise settles.
 */
function runEffect(item: Item): void {
  let result: unknown;
  try {
    result = item.ledger?.sealed
      ? outsideLedgers(() => runSealed('console', null, 'premium', async () => item.scope.runInAsyncScope(() => item.run())))
      : item.scope.runInAsyncScope(() => item.run());
  } catch (error) {
    console.error('[PremiumManager] A premium side effect failed:', error);
    close(item);
    return;
  }
  // A notice is settled once it is handed to the dispatcher; its delivery is not a write the op waits for.
  if (item.kind === 'notice') close(item);
  Promise.resolve(result).catch(error => {
    console.error('[PremiumManager] A premium side effect failed:', error);
  }).finally(() => close(item));
}

/** A JSON bot (decision 64): each item through NB10's path at once, in order; standalone items the same everywhere. */
export function runItems(items: readonly Item[]): void {
  for (const item of items) runEffect(item);
}

/** The op landed: its audit lines are stored, and each effect runs in item order. */
export function landItems(items: readonly Item[], ticket?: LedgerTicket): void {
  for (const item of items) {
    if (item.kind === 'audit') {
      item.settledLine?.('landed', ticket);
      close(item);
    } else {
      runEffect(item);
    }
  }
}

/** What a manager does for items that do not go out: whether it is stopped, and how its marked lines are queued. */
export interface ItemSink {
  /** The stop's words while the manager is stopped (no marked line is written then), else null. */
  stopWords(): string | null;
  writeMarked(lines: Array<{ id: string; line: string }>): void;
}

/**
 * The op was refused (cause, with its words for the logs) or ended 'unconfirmed' (decisions 48 and 64): each notice and
 * event is dropped and logged; each audit line is written marked with its own id, never after the stop.
 */
export function failItems(items: readonly Item[], how: { refused: string; words: string } | 'unconfirmed', sink: ItemSink): void {
  const stop = sink.stopWords();
  const at = new Date().toISOString();
  const cause = how === 'unconfirmed' ? 'not-landed' : how.refused;
  const marked: Array<{ id: string; line: string }> = [];
  for (const item of items) {
    if (item.kind === 'audit') {
      if (stop !== null) item.drop({ kind: 'stopped', words: stop });
      else if (item.marked) marked.push({ id: item.id, line: item.marked(cause, at) });
      item.settledLine?.('gone');
    } else {
      item.drop(how === 'unconfirmed' ? { kind: 'unconfirmed' } : { kind: 'refused', words: how.words });
    }
    close(item);
  }
  if (marked.length > 0) sink.writeMarked(marked);
}

/** The JSON bot's refusal (decision 64): each item dropped with its log; nothing is written. */
export function dropItems(items: readonly Item[], how: DropHow): void {
  for (const item of items) {
    item.drop(how);
    item.settledLine?.('gone');
    close(item);
  }
}

/** Items no save took and nothing else will settle (a carry dropped with no log, decision 63): closed silently. */
export function forgetItems(items: readonly Item[]): void {
  for (const item of items) {
    item.settledLine?.('gone');
    close(item);
  }
}

/** The owner's items not settled yet, in the order they were made. */
export function openItemsOf(owner: object): Item[] {
  return [...openItems].filter(item => item.owner === owner);
}

/**
 * Decision 64's `settled` items part: resolves once no item made under the ledger is open, or after boundMs (null: no
 * bound, the web UI's rule of decision 76). Items `skip` names are not waited for.
 */
export async function itemsSettled(ledger: WriteLedger | undefined, boundMs: number | null, skip?: (item: Item) => boolean): Promise<void> {
  const deadline = boundMs === null ? null : Date.now() + boundMs;
  for (;;) {
    if (![...openItems].some(item => item.ledger === ledger && !skip?.(item))) return;
    const left = deadline === null ? null : deadline - Date.now();
    if (left !== null && left <= 0) return;
    await new Promise<void>(resolve => {
      const done = () => {
        waiters.delete(done);
        if (timer) clearTimeout(timer);
        resolve();
      };
      const timer = left === null ? null : setTimeout(done, left);
      timer?.unref?.();
      waiters.add(done);
    });
  }
}

/** Tests: forgets every item. */
export function _resetPremiumItems(): void {
  openItems.clear();
  wake();
}
