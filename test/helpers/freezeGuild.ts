import { getWorkingSet, initWorkingSet, WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from './backendKind';
import { FakeStore, tokenFor } from './fakeStore';

type SetState = { state: string };
const setOf = (guildId: string, manager: WorkingSetManager | null): SetState | undefined =>
  (manager as unknown as { sets: Map<string, SetState> } | null)?.sets.get(guildId);

/** Puts a ready working set into frozen-retained, as a lease's unload leaves it: its writes get the frozen answer. */
export function freezeGuildWrites(guildId: string, manager: WorkingSetManager | null = getWorkingSet()): void {
  const ws = setOf(guildId, manager);
  if (ws?.state !== 'ready') throw new Error(`freezeGuildWrites: guild ${guildId} has no ready working set`);
  ws.state = 'frozen-retained';
}

export function unfreezeGuildWrites(guildId: string, manager: WorkingSetManager | null = getWorkingSet()): void {
  const ws = setOf(guildId, manager);
  if (ws?.state === 'frozen-retained') ws.state = 'ready';
}

/** Routes every guild to a fresh working set over a FakeStore and hydrates the given guilds on it. */
export async function servedGuilds(...guildIds: string[]): Promise<WorkingSetManager> {
  setBackendKind('postgres');
  const ws = initWorkingSet(new FakeStore());
  for (const guildId of guildIds) {
    if (await ws.hydrate(guildId, tokenFor()) !== 'ready') throw new Error(`servedGuilds: guild ${guildId} did not hydrate`);
  }
  return ws;
}
