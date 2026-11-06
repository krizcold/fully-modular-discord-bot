import { afterEach, describe, expect, it, vi } from 'vitest';

// NB7 decision 19: once the process's lease is set, a panel action or a console invoke of a guild whose shard is not in
// it is refused at once, naming the machine that runs it (the holder check's statement on the sweep's pool, 2 s).
const local = vi.hoisted(() => ({ commands: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => local.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const client = { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: '11' }, application: { id: '11' } };
  return { ...real, getPanelManager: () => ({ getClient: () => client }) };
});

import { gateCauseText } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { _setLookupDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import { handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { runPanelAction } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { setBackendKind } from '../helpers/backendKind';
import { fakeClock, NOT_LEASED, readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

afterEach(() => {
  _setLookupDb(null);
  stopDrivers();
  vi.useRealTimers();
});

const heldRow = (state: 'held' | 'expired' | 'kept') => ({
  n: 1, shard: 0, holder_process: 'p-b', holder_node: 'n-b', holder_name: 'BRAVO', claim: '4',
  released: state === 'kept', reserved: false, ttl_ms: '30000', expires_up_ms: state === 'expired' ? '100' : '90000',
  renewed_ago_ms: 10, up_ms: '1000', node_process_id: 'p-b', node_takeover_seconds: 30, node_seen_ago_ms: 10,
});

function lookup(answer: () => unknown) {
  const sent: Array<{ text: string; values: unknown[]; boundMs: number }> = [];
  _setLookupDb({
    query: async (text: string, values: unknown[], boundMs: number) => {
      sent.push({ text, values, boundMs });
      const a = answer();
      if (a instanceof Error) throw a;
      return { rows: a as any[] };
    },
  });
  return sent;
}

const manager = () => ({ getPanel: () => undefined, executePanelForWebUI: vi.fn(async () => ({ success: true })) });

describe('a panel action of a server another machine runs', () => {
  it.each([
    ['held', () => [heldRow('held')], 'This server runs on BRAVO; open its panels from the web panel on BRAVO.'],
    ['another state', () => [heldRow('expired')], 'No machine runs this server right now; please try again in a moment.'],
    ['no shard count', () => [], 'No machine runs this server right now; please try again in a moment.'],
    ['a failed lookup', () => Object.assign(new Error('boom'), { code: '42P01' }), "This machine's bot does not run this server, and the machine that runs it could not be looked up (SQLSTATE 42P01: boom); open its panels from the web panel of the machine that runs it."],
  ] as const)('%s: refused in one turn with its text', async (_what, answer, text) => {
    fakeClock();
    const sent = lookup(answer);
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const pm = manager();
    const seen = watch(runPanelAction('panel:execute', { panelId: 'p', userId: 'u', guildId }, pm));
    await vi.advanceTimersByTimeAsync(5);
    expect(seen.settled()).toBe(true);
    expect(seen.value()).toEqual({ success: false, error: text });
    expect(pm.executePanelForWebUI).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].values).toEqual([guildId]);
    expect(sent[0].boundMs).toBeLessThanOrEqual(2000);
  });

  it('before the lease is set, holds as today and runs no lookup', async () => {
    fakeClock();
    const sent = lookup(() => [heldRow('held')]);
    const r = readinessRig(null);
    const guildId = r.guild();
    const pm = manager();
    const seen = watch(runPanelAction('panel:execute', { panelId: 'p', userId: 'u', guildId }, pm));
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.value()).toEqual({ success: false, error: gateCauseText('not-served') });
    expect(sent).toHaveLength(0);
  });

  it('a JSON bot is unchanged: no lookup', async () => {
    const sent = lookup(() => [heldRow('held')]);
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    setBackendKind('file');
    const pm = manager();
    const answer = await runPanelAction('panel:execute', { panelId: 'p', userId: 'u', guildId }, pm);
    expect(answer).toMatchObject({ success: true });
    expect(sent).toHaveLength(0);
  });
});

describe('a console invoke of a server another machine runs', () => {
  it.each([
    [false],
    [true],
  ])('force %s: refused before the cache check, naming the machine', async force => {
    fakeClock();
    const ran = vi.fn();
    local.commands = [{ name: 'probe', callback: ran }];
    lookup(() => [heldRow('held')]);
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const seen = watch(handleInvoke({ command: 'probe', guildId, force }));
    await vi.advanceTimersByTimeAsync(5);
    expect(seen.value()).toEqual({ success: false, error: `guild ${guildId} runs on BRAVO; run the command from the web panel on BRAVO` });
    expect(ran).not.toHaveBeenCalled();
  });

  it.each([
    ['another state', () => [heldRow('kept')], (g: string) => `no machine runs guild ${g} right now; try again in a moment`],
    ['a failed lookup', () => new Error('Query read timeout'), (g: string) => `this machine's bot does not run guild ${g}, and the machine that runs it could not be looked up (Query read timeout)`],
  ] as const)('%s answers its console text', async (_what, answer, text) => {
    fakeClock();
    local.commands = [{ name: 'probe', callback: vi.fn() }];
    lookup(answer);
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const seen = watch(handleInvoke({ command: 'probe', guildId, force: true }));
    await vi.advanceTimersByTimeAsync(5);
    expect(seen.value()).toEqual({ success: false, error: text(guildId) });
  });
});
