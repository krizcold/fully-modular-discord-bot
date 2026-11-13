import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import type { DataBackend, FlushFate, FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { tokenFor } from '../helpers/fakeStore';

// L5 run A survivors in workingSet.ts (wip-redesign/sheets/NB13.md to NB18.md): unanswered saves, re-saves and landings.

const UNANSWERED_NOTE = "a save's COMMIT got no answer; checking whether it landed";
const UNANSWERED: FlushOutcome = { ok: false, reason: 'unavailable', commitUnanswered: true, detail: 'connection ended' };
const REFUSED: FlushOutcome = { ok: false, reason: 'unavailable', detail: 'connection refused' };
const contentRefused = (code: string): FlushOutcome => ({ ok: false, reason: 'unavailable', code, detail: 'the database refused a document' });

interface Gate<T> { promise: Promise<T>; open(value: T): void }
function gate<T>(): Gate<T> {
  let open!: (value: T) => void;
  const promise = new Promise<T>(resolve => { open = resolve; });
  return { promise, open };
}

class ScriptStore {
  readonly kind = 'postgres' as const;
  epoch = 1;
  hydrated: { key: { module: string; filename: string }; doc: string }[] = [];
  readonly flushes: GuildFlushBatch[] = [];
  readonly flushPlan: Array<FlushOutcome | Gate<FlushOutcome>> = [];
  readonly resolvePlan: Array<FlushFate | Gate<FlushFate>> = [];
  checks = 0;

  databaseEpoch(): number { return this.epoch; }
  start(): void {}
  async stop(): Promise<void> {}
  connectionState() { return { state: 'ready' as const }; }
  onAlert(): void {}
  async hydrateGuild() { return { ok: true as const, docs: this.hydrated, appendKeys: [] }; }
  async reclaimGuild() { return 'kept' as const; }
  async flushGuild(_guildId: string, batch: GuildFlushBatch): Promise<FlushOutcome> {
    this.flushes.push(structuredClone(batch));
    const step = this.flushPlan.shift() ?? { ok: true };
    return 'promise' in step ? step.promise : step;
  }
  async resolveFlush(): Promise<FlushFate> {
    this.checks += 1;
    const step = this.resolvePlan.shift() ?? { fate: 'unknown', detail: 'no answer planned' };
    return 'promise' in step ? step.promise : step;
  }
}

let guilds = 0;
async function readySet(docs: Record<string, string> = {}) {
  const store = new ScriptStore();
  store.hydrated = Object.entries(docs).map(([name, doc]) => {
    const [module, filename] = name.split('/');
    return { key: { module, filename }, doc };
  });
  const mgr = new WorkingSetManager(store as unknown as DataBackend);
  const g = `rj2-${++guilds}`;
  expect(await mgr.hydrate(g, tokenFor())).toBe('ready');
  return { store, mgr, g };
}

const drain = () => new Promise<void>(resolve => { setImmediate(resolve); });
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await drain();
  if (!cond()) throw new Error(`did not see ${what}`);
}

function quietConsole() {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => errors.mock.calls.map(call => String(call[0]));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a save whose COMMIT got no answer', () => {
  it('marks the backend degraded with the unanswered note', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { store, mgr, g } = await readySet();
    store.flushPlan.push(UNANSWERED);
    expect(mgr.save(g, 'm', 'a.json', '{"v":1}')).toBe('accepted');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('pending');
    expect(mgr.getBackendHealth()).toMatchObject({ state: 'degraded', lastError: UNANSWERED_NOTE });
  });

  it('a check that cannot tell marks the backend degraded again after another guild landed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const store = new ScriptStore();
    const mgr = new WorkingSetManager(store as unknown as DataBackend);
    const a = `rj2-${++guilds}`;
    const b = `rj2-${++guilds}`;
    expect(await mgr.hydrate(a, tokenFor())).toBe('ready');
    expect(await mgr.hydrate(b, tokenFor())).toBe('ready');
    store.flushPlan.push(UNANSWERED, { ok: true });
    store.resolvePlan.push({ fate: 'unknown', detail: 'the database did not answer' });
    mgr.save(a, 'm', 'a.json', '{"v":1}');
    expect(await mgr.flushGuildNow(a, 1000)).toBe('pending');
    mgr.save(b, 'm', 'b.json', '{"v":2}');
    expect(await mgr.flushGuildNow(b, 1000)).toBe('ok');
    expect(mgr.getBackendHealth()).toMatchObject({ state: 'healthy', lastError: null });
    expect(await mgr.flushGuildNow(a, 1000)).toBe('pending');
    expect(store.checks).toBe(1);
    expect(mgr.getBackendHealth()).toMatchObject({ state: 'degraded', lastError: UNANSWERED_NOTE });
  });

  it('a check that cannot tell is asked again by the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { store, mgr, g } = await readySet();
    store.flushPlan.push(UNANSWERED);
    store.resolvePlan.push({ fate: 'unknown', detail: 'first check failed' }, { fate: 'unknown', detail: 'second check failed' });
    mgr.save(g, 'm', 'a.json', '{"v":1}');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('pending');
    expect(store.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    await drain();
    expect(store.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await drain();
    expect(store.checks).toBe(2);
  });

  it('a check answered after the guild was deposed vouches for no write', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    quietConsole();
    const { store, mgr, g } = await readySet();
    store.flushPlan.push(UNANSWERED);
    mgr.save(g, 'm', 'a.json', '{"v":1}');
    const ticket = mgr.ticketFor(g);
    expect(await mgr.flushGuildNow(g, 1000)).toBe('pending');
    const answer = gate<FlushFate>();
    store.resolvePlan.push(answer);
    const flushing = mgr.flushGuildNow(g, 2000);
    await until(() => store.checks === 1, 'the check');
    mgr.depose(g);
    answer.open({ fate: 'landed' });
    expect(await flushing).toBe('deposed');
    expect(mgr.landedFlushes()).toBe(0);
    expect(await mgr.confirm(ticket, 200)).toBe('deposed');
  });

  it('a check finding the guild taken and the batch landed logs no may-have-landed words', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const errors = quietConsole();
    const { store, mgr, g } = await readySet();
    store.flushPlan.push(UNANSWERED);
    store.resolvePlan.push({ fate: 'deposed', landed: true, currentOwner: { nodeId: 'node-b', claim: 99 } });
    mgr.save(g, 'm', 'a.json', '{"v":1}');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('pending');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('deposed');
    const deposed = errors().filter(line => line.includes('Deposed writer'));
    expect(deposed).toHaveLength(1);
    expect(deposed[0]).not.toContain('may have landed');
  });

  it('a check finding the guild taken with the batch unknown logs the may-have-landed words', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const errors = quietConsole();
    const { store, mgr, g } = await readySet();
    store.flushPlan.push(UNANSWERED);
    store.resolvePlan.push({ fate: 'deposed', landed: null });
    mgr.save(g, 'm', 'a.json', '{"v":1}');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('pending');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('unavailable');
    const deposed = errors().filter(line => line.includes('Deposed writer'));
    expect(deposed).toHaveLength(1);
    expect(deposed[0]).toContain('; a save whose COMMIT got no answer may have landed');
  });

  it('a landed check followed by a refused save answers held', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { store, mgr, g } = await readySet();
    store.flushPlan.push(UNANSWERED, REFUSED, { ok: true });
    store.resolvePlan.push({ fate: 'landed' });
    mgr.save(g, 'm', 'a.json', '{"v":1}');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('pending');
    mgr.save(g, 'm', 'b.json', '{"v":2}');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('held');
    expect(store.flushes).toHaveLength(2);
    expect(mgr.dirtyGuildIds()).toContain(g);
  });

  it('a landed check with nothing more to send answers without waiting on a poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { store, mgr, g } = await readySet();
    store.flushPlan.push(UNANSWERED);
    store.resolvePlan.push({ fate: 'landed' });
    mgr.save(g, 'm', 'a.json', '{"v":1}');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('pending');
    let answer: string | null = null;
    const flushing = mgr.flushGuildNow(g, 1000).then(result => { answer = result; });
    await drain();
    expect(answer).toBe('ok');
    await vi.advanceTimersByTimeAsync(100);
    await flushing;
    expect(store.flushes).toHaveLength(1);
  });
});

describe('a re-save after the latch', () => {
  it('a set held by a restore and flagged under the epoch in force is re-saved by a flush', async () => {
    const { store, mgr, g } = await readySet({ 'm/a.json': '{"v":1}' });
    expect(mgr.beginRestore(g)).toBe(true);
    mgr.markForResave('db-old');
    mgr.flagEpoch(store.epoch);
    expect(await mgr.flushGuildNow(g, 1000)).toBe('ok');
    expect(store.flushes).toHaveLength(1);
    expect(store.flushes[0].replace?.docKeys).toEqual([{ module: 'm', filename: 'a.json' }]);
    expect(mgr.resaveGuilds()).not.toContain(g);
  });

  it('a content refusal sends no write-free re-send once a later latch replaced the flag', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { store, mgr, g } = await readySet({ 'm/a.json': '{"v":1}' });
    mgr.markForResave('db-a');
    mgr.flagEpoch(1);
    const answer = gate<FlushOutcome>();
    store.flushPlan.push(answer, { ok: true });
    mgr.save(g, 'm', 'b.json', '{"v":2}');
    const flushing = mgr.flushGuildNow(g, 2000);
    await until(() => store.flushes.length === 1, 'the first flush');
    store.epoch = 2;
    mgr.markForResave('db-b');
    mgr.flagEpoch(2);
    answer.open(contentRefused('22001'));
    expect(await flushing).toBe('held');
    expect(store.flushes).toHaveLength(1);
    expect(mgr.resaveGuilds()).toContain(g);
  });

  it('a content refusal of a re-save holding no write sends nothing again and keeps the flag', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { store, mgr, g } = await readySet({ 'm/a.json': '{"v":1}' });
    mgr.markForResave('db-a');
    mgr.flagEpoch(1);
    store.flushPlan.push(contentRefused('23505'), { ok: true });
    expect(await mgr.flushGuildNow(g, 1000)).toBe('held');
    expect(store.flushes).toHaveLength(1);
    expect(mgr.resaveGuilds()).toContain(g);
  });

  it('a content refusal re-sends the clean documents, on the wire until it lands, and counts the landing', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { store, mgr, g } = await readySet({ 'm/a.json': '{"v":1}' });
    mgr.markForResave('db-a');
    mgr.flagEpoch(1);
    const resend = gate<FlushOutcome>();
    store.flushPlan.push(contentRefused('22001'), resend);
    mgr.save(g, 'm', 'b.json', '{"v":2}');
    const flushing = mgr.flushGuildNow(g, 2000);
    await until(() => store.flushes.length === 2, 'the re-send');
    expect(mgr.flushOnTheWire()).toBe(true);
    expect(store.flushes[1].upserts).toEqual([{ key: { module: 'm', filename: 'a.json' }, doc: '{"v":1}' }]);
    resend.open({ ok: true });
    expect(await flushing).toBe('held');
    expect(mgr.flushOnTheWire()).toBe(false);
    expect(mgr.landedFlushes()).toBe(1);
    expect(mgr.resaveGuilds()).not.toContain(g);
    expect(mgr.dirtyGuildIds()).toContain(g);
  });

  it('a latch during the flight leaves its new flag to a re-save of its own', async () => {
    const { store, mgr, g } = await readySet({ 'm/a.json': '{"v":1}' });
    mgr.markForResave('db-a');
    mgr.flagEpoch(1);
    const answer = gate<FlushOutcome>();
    store.flushPlan.push(answer, { ok: true });
    const flushing = mgr.flushGuildNow(g, 2000);
    await until(() => store.flushes.length === 1, 'the first flush');
    mgr.markForResave('db-b');
    mgr.flagEpoch(1);
    answer.open({ ok: true });
    expect(await flushing).toBe('ok');
    expect(store.flushes).toHaveLength(2);
    expect(store.flushes[1].replace?.reason).toContain('db-b');
    expect(mgr.resaveGuilds()).not.toContain(g);
  });

  it('a flag moved to another epoch during the flight stays pending', async () => {
    const { store, mgr, g } = await readySet({ 'm/a.json': '{"v":1}' });
    mgr.markForResave('db-a');
    mgr.flagEpoch(1);
    const answer = gate<FlushOutcome>();
    store.flushPlan.push(answer);
    const flushing = mgr.flushGuildNow(g, 2000);
    await until(() => store.flushes.length === 1, 'the first flush');
    mgr.flagEpoch(7);
    answer.open({ ok: true });
    expect(await flushing).toBe('ok');
    expect(mgr.resaveGuilds()).toContain(g);
  });

  it('a database epoch raised during the flight keeps the flag pending', async () => {
    const { store, mgr, g } = await readySet({ 'm/a.json': '{"v":1}' });
    mgr.markForResave('db-a');
    mgr.flagEpoch(1);
    const answer = gate<FlushOutcome>();
    store.flushPlan.push(answer);
    const flushing = mgr.flushGuildNow(g, 2000);
    await until(() => store.flushes.length === 1, 'the first flush');
    store.epoch = 2;
    answer.open({ ok: true });
    expect(await flushing).toBe('ok');
    expect(mgr.resaveGuilds()).toContain(g);
  });
});

describe('a deposed set and its re-save line', () => {
  it('an unflagged set deposed logs no re-save line', async () => {
    const errors = quietConsole();
    const { mgr, g } = await readySet({ 'm/a.json': '{"v":1}' });
    mgr.depose(g);
    expect(errors().some(line => line.includes('Deposed writer'))).toBe(true);
    expect(errors().filter(line => line.includes('were not re-saved'))).toEqual([]);
  });

  it('a flagged set deposed counts only its live documents', async () => {
    const errors = quietConsole();
    const { mgr, g } = await readySet({ 'm/a.json': '{"v":1}', 'm/b.json': '{"v":2}' });
    mgr.markForResave('db-a');
    expect(mgr.delete(g, 'm', 'a.json')).toBe('accepted');
    mgr.depose(g);
    expect(errors().filter(line => line.includes('were not re-saved'))).toEqual([
      `[Data] Guild ${g}: 1 document(s) were not re-saved on the main, once one is found (shard 0 is held by another process)`,
    ]);
  });
});

describe('landed flushes', () => {
  it('each landed flush counts one', async () => {
    const { mgr, g } = await readySet();
    mgr.save(g, 'm', 'a.json', '{"v":1}');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('ok');
    expect(mgr.landedFlushes()).toBe(1);
    mgr.save(g, 'm', 'a.json', '{"v":2}');
    expect(await mgr.flushGuildNow(g, 1000)).toBe('ok');
    expect(mgr.landedFlushes()).toBe(2);
  });
});
