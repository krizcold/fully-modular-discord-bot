// NB4 decision 6: whether this process stopped serving its shards (its claims lapsed or a shard was lost). The shard
// layer sets the hook; the data layer, the gates and the module paths ask it, so none of them imports the fleet layer.
// With no hook (a JSON bot, the web UI process) the answer is false.

let hook: (() => boolean) | null = null;

export function setStoppedServingHook(fn: (() => boolean) | null): void {
  hook = fn;
}

/** Synchronous and awaits nothing: asked at the moment a write is accepted or module code is called. */
export function stoppedServing(): boolean {
  return hook ? hook() : false;
}

/** The one answer for a web UI request that would run module code in a process that stopped serving. */
export const STOPPED_SERVING_TEXT = 'This bot process stopped serving its shards (its claims lapsed or a shard was lost) and restarts once its unsaved changes are saved or reported in its log; try again after the restart';
