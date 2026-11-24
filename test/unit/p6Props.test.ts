import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P6 claim 11 (sheet P6, section 10), in full: what premium holds for each user is what Discord bills. The real
// DiscordProvider and the real PremiumManager in the bot role over the JSON files, the Client of helpers/p6World.ts with
// the entitlement bridge attached, and the fake of helpers/p6Discord.ts as Discord, with R1 to R12 drawn per run
// (`notFoundLive` empty, the configured application kept). Random sequences of purchase, testGrant (a user or the
// server), a server subscription bought by a user, endAt (past or ahead), refund, removeByTooling, deleteTest,
// memberCancel, memberResume, an upgrade (A to A2 at the same priority, A or A2 to B), a downgrade (B to A or A2), the
// delivery of every queued event or of one, drop, duplicate and reorder of a queued event, a restart, a manual grant of
// the higher user tier for a day and its revoke, clock steps (which run the timed rounds and the minute checker), rounds
// with Discord answering, and rounds with Discord failing (a 500, a 429 or no answer on one route).
//
// P1 is checked after a round in which Discord answered (it logged none of PD6, PD8, PD15 and PD17), whose reads
// started more than `staleReads` seconds after Discord's last change, followed 31 seconds later by a second such
// round with no `ends_at` within 31 seconds of it (so no round is armed within the next 31 seconds), once the minute
// checker ran past every passed `ends_at`; and at the end, once the clock is past every `ends_at` drawn and two rounds
// 61 minutes apart ran. Expected, per user: the Discord records premium holds (active and queued) are that user's
// current entitlements of a wired SKU (not deleted, `ends_at` none or ahead), except: of current entitlements whose
// tiers share a priority exactly one is held; a test entitlement is not required when R4 is false and its create event
// was not delivered (R9 sends none, or it was dropped or is still queued) or was refused when it came. Each held record's endDate is Discord's `ends_at` in ms. No Discord record
// is held for a server, and no call reached a route or method the fake does not serve (no DELETE, no POST).
// P2, after every step: a record leaves premium only with evidence about its entitlement (an update or delete event
// delivered, a single read answered 200 while Discord shows it ended, two 404s for it at least an hour apart, or
// Discord's `ends_at` passed, which a read gave and the minute checker ends through `endsAtPaidEnd`), and only when
// Discord no longer bills it.
//
// The generator skips what premium refuses by design outside these rules: a purchase at the manual grant's priority
// while the user holds that grant (see skipNew). Two current entitlements at one priority under a higher record are
// drawn, and the second example forces one. A failure prints its seed; SMDB_TEST_SEED replays it.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { allowDropLines } from '../helpers/p1Guard';
import { SKU, type DiscordFault, type DiscordSettings, type FakeEntitlement, type RouteKind } from '../helpers/p6Discord';
import { GUILD, heldDiscord, p6World, PRIORITY, USERS, WIRING, type P6World } from '../helpers/p6World';

type SkuName = 'A' | 'A2' | 'B';
type FailKind = 'me500' | 'list500' | 'list429' | 'single500' | 'singleNoAnswer';
type Step =
  | { t: 'purchase'; u: number; sku: SkuName }
  | { t: 'testGrant'; u: number; guild: boolean; sku: SkuName }
  | { t: 'guildBuy'; u: number; sku: SkuName }
  | { t: 'endAt'; pick: number; ahead: boolean }
  | { t: 'refund' | 'removeByTooling' | 'deleteTest' | 'memberCancel' | 'memberResume'; pick: number }
  | { t: 'upgrade'; pick: number; to: 'A2' | 'B' }
  | { t: 'downgrade'; pick: number; to: 'A' | 'A2' }
  | { t: 'deliver' }
  | { t: 'deliverOne'; pick: number }
  | { t: 'drop' | 'duplicate'; pick: number }
  | { t: 'reorder'; from: number; to: number }
  | { t: 'restart' }
  | { t: 'grant' | 'revoke'; u: number }
  | { t: 'clock'; ms: number }
  | { t: 'round' }
  | { t: 'roundFail'; kind: FailKind };

const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const pick = fc.nat({ max: 15 });
const user = fc.nat({ max: USERS.length - 1 });
const skuName = fc.constantFrom<SkuName>('A', 'A2', 'B');
const purchase = fc.record({ t: fc.constant('purchase' as const), u: user, sku: skuName });
const deliver = fc.record({ t: fc.constant('deliver' as const) });
const round = fc.record({ t: fc.constant('round' as const) });
const steps: fc.Arbitrary<Step>[] = [
  purchase, purchase, purchase,
  fc.record({ t: fc.constant('testGrant' as const), u: user, guild: fc.boolean(), sku: skuName }),
  fc.record({ t: fc.constant('guildBuy' as const), u: user, sku: skuName }),
  fc.record({ t: fc.constant('endAt' as const), pick, ahead: fc.boolean() }),
  fc.record({ t: fc.constantFrom<'refund' | 'removeByTooling' | 'deleteTest' | 'memberCancel' | 'memberResume'>('refund', 'removeByTooling', 'deleteTest', 'memberCancel', 'memberResume'), pick }),
  fc.record({ t: fc.constant('upgrade' as const), pick, to: fc.constantFrom<'A2' | 'B'>('A2', 'B') }),
  fc.record({ t: fc.constant('downgrade' as const), pick, to: fc.constantFrom<'A' | 'A2'>('A', 'A2') }),
  deliver, deliver,
  fc.record({ t: fc.constant('deliverOne' as const), pick }),
  fc.record({ t: fc.constantFrom<'drop' | 'duplicate'>('drop', 'duplicate'), pick }),
  fc.record({ t: fc.constant('reorder' as const), from: pick, to: pick }),
  fc.record({ t: fc.constant('restart' as const) }),
  fc.record({ t: fc.constantFrom<'grant' | 'revoke'>('grant', 'revoke'), u: user }),
  fc.record({ t: fc.constant('clock' as const), ms: fc.constantFrom(30 * SEC, 10 * MIN, 2 * HOUR, 24 * HOUR) }),
  round, round,
  fc.record({ t: fc.constant('roundFail' as const), kind: fc.constantFrom<FailKind>('me500', 'list500', 'list429', 'single500', 'singleNoAnswer') }),
];
const order = fc.constantFrom<'asc' | 'desc'>('asc', 'desc');
const settingsArb: fc.Arbitrary<Partial<DiscordSettings>> = fc.record({
  updateEndsAt: fc.constantFrom<'past' | 'future'>('past', 'future'),
  cancelShowsEndsAt: fc.boolean(),
  deletedRead: fc.constantFrom<'200' | '404'>('200', '404'),
  listsTests: fc.boolean(),
  excludeEnded: fc.constantFrom<'passed' | 'any'>('passed', 'any'),
  firstWindow: fc.constantFrom<'oldest' | 'newest'>('oldest', 'newest'),
  sortFirst: order,
  sortAfter: order,
  sortBefore: order,
  shortPageMidway: fc.boolean(),
  delivery: fc.constantFrom<'one' | 'every'>('one', 'every'),
  testEvents: fc.boolean(),
  testType: fc.constantFrom<3 | 4>(3, 4),
  allowTwin: fc.boolean(),
  foreignApp: fc.constantFrom<'401' | '403' | '404' | '200-empty'>('401', '403', '404', '200-empty'),
  staleReads: fc.constantFrom(0, 10, 40),
  upgradeOrder: fc.constantFrom<'create-first' | 'update-first'>('create-first', 'update-first'),
});

const FAULTS: Record<FailKind, { route: RouteKind; fault: DiscordFault }> = {
  me500: { route: 'me', fault: { status: 500 } },
  list500: { route: 'list', fault: { status: 500 } },
  list429: { route: 'list', fault: { status: 429 } },
  single500: { route: 'single', fault: { status: 500 } },
  singleNoAnswer: { route: 'single', fault: { noAnswer: true } },
};
/** The lines that make a round not a checkpoint: an incomplete list, a failed read, a stop, a 404 the guard waits on. */
const NOT_ANSWERED = [
  "[DiscordProvider] Could not read the whole list of the app's entitlements",
  '[DiscordProvider] Could not read entitlement',
  '[DiscordProvider] The check stopped before it finished',
  '[DiscordProvider] Discord answered 404 for entitlement',
];

/** Across a describe's runs. */
const tally = { steps: 0, purchased: 0, delivered: 0, checkpoints: 0, heldChecked: 0, left: 0, queued: 0, restarts: 0, grants: 0, failedRounds: 0, endChecks: 0 };

function runSeed(): number {
  return fc.readConfigureGlobal().seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0);
}

const skuOf = (name: SkuName): string => SKU[name];
const priorityOfSku = (skuId: string): number | null => (WIRING[skuId] ? PRIORITY[WIRING[skuId].tierId] : null);
const userEnts = (w: P6World, u: string): FakeEntitlement[] => [...w.fake.entitlements.values()].filter(e => e.userId === u && e.guildId === null);
const choose = <T>(list: T[], at: number): T | null => (list.length === 0 ? null : list[at % list.length]);

/** What a run knows beyond the fake: the ids whose create was delivered, the ids that got an update event queued. */
interface RunState { settings: Partial<DiscordSettings>; createDelivered: Set<string>; updated: Set<string> }

function manualHeld(w: P6World, u: string): boolean {
  const record = w.stored()?.subscriptions?.[`user:${u}`];
  return [record?.active, ...(record?.paused ?? [])].some((s: any) => s?.source === 'manual');
}

/**
 * Whether a new current entitlement of `skuId` for the user is one the generator skips: it would meet the manual grant
 * at its priority (the grant is of the higher user tier, so a purchase of B is refused while the grant is held), or it
 * would be a second current entitlement of the same SKU without R10.
 */
function skipNew(w: P6World, s: RunState, u: string, skuId: string, replacing: FakeEntitlement | null = null): boolean {
  const priority = priorityOfSku(skuId)!;
  if (manualHeld(w, u) && priority >= PRIORITY.star) return true;
  const current = userEnts(w, u).filter(e => w.fake.isCurrent(e) && e.id !== replacing?.id);
  return !s.settings.allowTwin && current.some(e => e.skuId === skuId);
}

async function run(w: P6World, s: RunState, step: Step): Promise<void> {
  const fake = w.fake;
  const ents = [...fake.entitlements.values()];
  const noteDelivered = (events: Array<{ name: string; entitlementId: string }>): void => {
    for (const e of events) if (e.name === 'entitlementCreate') s.createDelivered.add(e.entitlementId);
    tally.delivered += events.length;
  };
  switch (step.t) {
    case 'purchase': {
      const u = USERS[step.u];
      if (skipNew(w, s, u, skuOf(step.sku))) return;
      fake.purchase(u, skuOf(step.sku));
      tally.purchased += 1;
      return;
    }
    case 'testGrant': {
      if (step.guild) {
        fake.testGrant({ guildId: GUILD }, skuOf(step.sku));
        return;
      }
      const u = USERS[step.u];
      if (skipNew(w, s, u, skuOf(step.sku))) return;
      fake.testGrant({ userId: u }, skuOf(step.sku));
      return;
    }
    case 'guildBuy':
      fake.purchase(USERS[step.u], skuOf(step.sku), { guildId: GUILD });
      return;
    case 'endAt': {
      const ent = choose(ents.filter(e => !e.test && fake.isCurrent(e) && !s.updated.has(e.id)), step.pick);
      if (!ent) return;
      fake.endAt(ent, step.ahead ? Date.now() + 90 * MIN : Date.now() - SEC);
      s.updated.add(ent.id);
      return;
    }
    case 'refund':
    case 'removeByTooling': {
      const ent = choose(ents.filter(e => !e.test && !e.deleted), step.pick);
      if (ent) fake[step.t](ent);
      return;
    }
    case 'deleteTest': {
      const ent = choose(ents.filter(e => e.test && !e.deleted), step.pick);
      if (ent) fake.deleteTest(ent);
      return;
    }
    case 'memberCancel':
    case 'memberResume': {
      const ent = choose(ents.filter(e => !e.test && fake.isCurrent(e) && !s.updated.has(e.id)), step.pick);
      if (ent) fake[step.t](ent);
      return;
    }
    case 'upgrade': {
      const from = step.to === 'A2' ? [SKU.A] : [SKU.A, SKU.A2];
      const ent = choose(ents.filter(e => e.guildId === null && !e.test && fake.isCurrent(e) && !s.updated.has(e.id) && from.includes(e.skuId as any)), step.pick);
      if (!ent || skipUpgrade(w, s, ent, skuOf(step.to))) return;
      fake.upgrade(ent, skuOf(step.to));
      s.updated.add(ent.id);
      return;
    }
    case 'downgrade': {
      const ent = choose(ents.filter(e => e.guildId === null && !e.test && fake.isCurrent(e) && !s.updated.has(e.id) && e.skuId === SKU.B), step.pick);
      if (!ent || skipUpgrade(w, s, ent, skuOf(step.to))) return;
      fake.downgrade(ent, skuOf(step.to));
      s.updated.add(ent.id);
      return;
    }
    case 'deliver':
      noteDelivered(fake.queue.slice());
      await w.deliverAll();
      return;
    case 'deliverOne': {
      if (fake.queue.length === 0) return;
      const index = step.pick % fake.queue.length;
      noteDelivered([fake.queue[index]]);
      await w.deliver(index);
      return;
    }
    case 'drop':
      if (fake.queue.length > 0) fake.drop(step.pick % fake.queue.length);
      return;
    case 'duplicate':
      if (fake.queue.length > 0) fake.duplicate(step.pick % fake.queue.length);
      return;
    case 'reorder':
      if (fake.queue.length > 1) fake.reorder(step.from % fake.queue.length, step.to % fake.queue.length);
      return;
    case 'restart':
      await w.restart();
      tally.restarts += 1;
      return;
    case 'grant': {
      const u = USERS[step.u];
      if (manualHeld(w, u)) return;
      const live = userEnts(w, u).filter(e => w.fake.isCurrent(e) || fake.queue.some(q => q.entitlementId === e.id));
      if (live.some(e => priorityOfSku(e.skuId) === PRIORITY.star)) return;
      if (live.filter(e => priorityOfSku(e.skuId) === PRIORITY.vip).length > 1) return;
      const reply = await w.op('grantManual', `user:${u}`, 'star', 1);
      if (reply.ok) tally.grants += 1;
      return;
    }
    case 'revoke': {
      const u = USERS[step.u];
      if (w.stored()?.subscriptions?.[`user:${u}`]?.active?.source === 'manual') await w.op('revokeManual', `user:${u}`);
      return;
    }
    case 'clock':
      await w.advance(step.ms);
      return;
    case 'round':
      return;
    case 'roundFail': {
      const { route, fault } = FAULTS[step.kind];
      fake.fail(route, fault, 3);
      await w.roundAdvancing(5 * MIN);
      fake.clearFaults();
      tally.failedRounds += 1;
    }
  }
}

/** An upgrade or downgrade to `skuId`: skipped as skipNew skips a purchase, with the old entitlement current until it ends. */
function skipUpgrade(w: P6World, s: RunState, old: FakeEntitlement, skuId: string): boolean {
  return skipNew(w, s, old.userId!, skuId, old);
}

/** Premium refused the entitlement's create (PD14 behind a held one at its priority): with R4 false, as missed as a dropped create. */
const refusedAtEvent = (w: P6World, id: string): boolean => w.logs.some(l => l.startsWith('[PremiumManager] subscription.created') && l.includes(`(subscription ${id},`));

const endMs = (value: unknown): number | null => (value === null || value === undefined ? null : Date.parse(String(value)));

/** P1: what broke, collected for the caller to assert on. */
function brokenP1(w: P6World, s: RunState): string[] {
  const broken: string[] = [];
  const now = Date.now();
  const held = heldDiscord(w.stored());
  for (const h of held) if (!h.holder.startsWith('user:')) broken.push(`P1: ${h.holder} holds Discord record ${h.sub.providerSubId}`);
  const seen = new Set<string>();
  for (const h of held) {
    if (seen.has(h.sub.providerSubId)) broken.push(`P1: ${h.sub.providerSubId} is held twice`);
    seen.add(h.sub.providerSubId);
  }
  for (const u of USERS) {
    const mine = held.filter(h => h.holder === `user:${u}`);
    for (const h of mine) {
      tally.heldChecked += 1;
      if (h.location === 'paused') tally.queued += 1;
      const ent = w.fake.entitlements.get(h.sub.providerSubId);
      if (!ent || ent.userId !== u || ent.guildId !== null) {
        broken.push(`P1: user:${u} holds ${h.sub.providerSubId}, which is no user entitlement of ${u} at Discord`);
        continue;
      }
      if (!w.fake.isCurrent(ent, now)) {
        broken.push(`P1: user:${u} holds ${ent.id} (${h.location}), which Discord no longer bills (deleted ${ent.deleted}, ends_at ${ent.endsAt})`);
        continue;
      }
      if (endMs(h.sub.endDate) !== ent.endsAt) broken.push(`P1: user:${u} holds ${ent.id} with endDate ${h.sub.endDate}; Discord's ends_at is ${ent.endsAt === null ? null : new Date(ent.endsAt).toISOString()}`);
    }
    const required = userEnts(w, u).filter(e => WIRING[e.skuId] && w.fake.isCurrent(e, now)
      && !(e.test && !s.settings.listsTests && (!s.createDelivered.has(e.id) || refusedAtEvent(w, e.id))));
    const byPriority = new Map<number, FakeEntitlement[]>();
    for (const e of required) {
      const p = priorityOfSku(e.skuId)!;
      byPriority.set(p, [...(byPriority.get(p) ?? []), e]);
    }
    for (const [priority, group] of byPriority) {
      const heldOf = group.filter(e => mine.some(h => h.sub.providerSubId === e.id));
      if (heldOf.length !== 1) broken.push(`P1: user:${u} holds ${heldOf.length} of the ${group.length} current entitlements at priority ${priority} (${group.map(e => `${e.id} SKU ${e.skuId}${e.test ? ' test' : ''}`).join(', ')})`);
    }
  }
  for (const call of w.fake.unexpected) broken.push(`a call the fake does not serve: ${call}`);
  return broken;
}

/** P2: each record premium held before the step and not after it has end evidence, and Discord no longer bills it. */
function brokenP2(w: P6World, before: Map<string, string>): string[] {
  const broken: string[] = [];
  const now = Date.now();
  const after = new Set(heldDiscord(w.stored()).map(h => h.sub.providerSubId));
  for (const [id, holder] of before) {
    if (after.has(id)) continue;
    tally.left += 1;
    const ent = w.fake.entitlements.get(id);
    const current = !!ent && w.fake.isCurrent(ent, now);
    if (current) broken.push(`P2: ${holder} lost ${id}, which Discord still bills`);
    const event = w.fake.delivered.some(e => e.entitlementId === id && (e.name === 'entitlementUpdate' || e.name === 'entitlementDelete'));
    const singles = w.fake.calls.filter(c => c.route === 'single' && c.path.split('?')[0].endsWith(`/${id}`));
    const readEnded = !current && singles.some(c => c.status === 200);
    const notFound = singles.filter(c => c.status === 404).map(c => c.at);
    const twice404 = notFound.length >= 2 && Math.max(...notFound) - Math.min(...notFound) >= HOUR;
    const endPassed = !!ent && ent.endsAt !== null && ent.endsAt <= now;
    if (!event && !readEnded && !twice404 && !endPassed) broken.push(`P2: ${holder} lost ${id} with no event, no single read showing an end, no two 404s an hour apart and no passed end`);
  }
  return broken;
}

const heldNow = (w: P6World): Map<string, string> => new Map(heldDiscord(w.stored()).map(h => [h.sub.providerSubId, h.holder]));

/** Discord's last change, in ms. */
const lastChange = (w: P6World): number => Math.max(0, ...[...w.fake.entitlements.values()].map(e => e.history[e.history.length - 1].at));

/** A round, and whether Discord answered it whole (none of the lines of NOT_ANSWERED). */
async function answeredRound(w: P6World): Promise<boolean> {
  const from = w.logs.length;
  await w.round();
  return !w.logs.slice(from).some(l => NOT_ANSWERED.some(p => l.startsWith(p)));
}

/**
 * The checkpoint: a round once reads are older than `staleReads` after Discord's last change, then 31 seconds later a
 * second; whether P1 can be checked now (both answered, no `ends_at` within 31 seconds of now, the minute checker ran
 * past every passed `ends_at`).
 */
async function checkpoint(w: P6World, s: RunState): Promise<boolean> {
  const stale = (s.settings.staleReads ?? 0) * SEC;
  const wait = lastChange(w) + stale + SEC - Date.now();
  if (wait > 0) await w.advance(wait);
  const first = await answeredRound(w);
  await w.advance(31 * SEC);
  const second = await answeredRound(w);
  if (!first || !second) return false;
  const now = Date.now();
  const lastCheck = w.expiryChecks.length > 0 ? w.expiryChecks[w.expiryChecks.length - 1] : -Infinity;
  const ends = [...w.fake.entitlements.values()].map(e => e.endsAt).filter((e): e is number => e !== null);
  if (ends.some(e => Math.abs(e - now) <= 31 * SEC)) return false;
  return ends.every(e => e > now || e <= lastCheck);
}

/** Runs the steps on a new world, then moves the clock past every end and checks once more; what broke. */
async function broken(w: P6World, settings: Partial<DiscordSettings>, sequence: Step[]): Promise<string[]> {
  const found: string[] = [];
  const s: RunState = { settings, createDelivered: new Set(), updated: new Set() };
  await w.setup({ settings });
  allowDropLines('L3');
  try {
    for (const [index, step] of sequence.entries()) {
      const before = heldNow(w);
      await run(w, s, step);
      tally.steps += 1;
      for (const line of brokenP2(w, before)) found.push(`${line} after step ${index} ${JSON.stringify(step)}`);
      if (step.t === 'round') {
        const p2Before = heldNow(w);
        const checkable = await checkpoint(w, s);
        for (const line of brokenP2(w, p2Before)) found.push(`${line} in the checkpoint after step ${index}`);
        if (checkable) {
          tally.checkpoints += 1;
          for (const line of brokenP1(w, s)) found.push(`${line} after step ${index} ${JSON.stringify(step)}`);
        }
      }
      if (found.length > 0) return found;
    }
    const before = heldNow(w);
    const ends = [...w.fake.entitlements.values()].map(e => e.endsAt ?? 0);
    const last = Math.max(Date.now(), ...ends);
    await w.advance(last - Date.now() + 61 * SEC);
    await w.round();
    await w.advance(61 * MIN);
    await w.round();
    await w.advance(61 * MIN);
    const checkable = await checkpoint(w, s);
    found.push(...brokenP2(w, before).map(l => `${l} at the end`));
    if (!checkable) found.push('the end: the last rounds were not answered whole');
    tally.endChecks += 1;
    found.push(...brokenP1(w, s).map(l => `${l} at the end`));
  } finally {
    await w.teardown();
  }
  return found;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('P6 claim 11 on the JSON files: Discord user subscriptions with events lost, reordered and late, and rounds', () => {
  const w = p6World('json');

  it('P1 after every checkpoint and at the end, P2 after every step', async () => {
    Object.assign(tally, { steps: 0, purchased: 0, delivered: 0, checkpoints: 0, heldChecked: 0, left: 0, queued: 0, restarts: 0, grants: 0, failedRounds: 0, endChecks: 0 });
    const seed = runSeed();
    const lifecycle: Step[] = [
      { t: 'purchase', u: 0, sku: 'A' }, { t: 'deliver' }, { t: 'purchase', u: 1, sku: 'B' }, { t: 'drop', pick: 0 }, { t: 'round' },
      { t: 'grant', u: 0 }, { t: 'endAt', pick: 0, ahead: true }, { t: 'deliver' }, { t: 'clock', ms: 2 * HOUR },
      { t: 'revoke', u: 0 }, { t: 'upgrade', pick: 0, to: 'B' }, { t: 'drop', pick: 1 }, { t: 'deliver' }, { t: 'round' },
      { t: 'restart' }, { t: 'refund', pick: 0 }, { t: 'drop', pick: 0 }, { t: 'roundFail', kind: 'single500' }, { t: 'clock', ms: 2 * HOUR }, { t: 'round' },
    ];
    const lifecycleSettings: Partial<DiscordSettings> = { updateEndsAt: 'future', upgradeOrder: 'create-first', testEvents: true, testType: 4, cancelShowsEndsAt: true, deletedRead: '404', staleReads: 40 };
    const queuedTwins: Step[] = [
      { t: 'purchase', u: 0, sku: 'A' }, { t: 'deliver' }, { t: 'purchase', u: 0, sku: 'B' }, { t: 'deliver' },
      { t: 'purchase', u: 0, sku: 'A2' }, { t: 'deliver' }, { t: 'round' }, { t: 'endAt', pick: 0, ahead: false }, { t: 'deliver' }, { t: 'round' },
    ];
    const queuedTwinsSettings: Partial<DiscordSettings> = { updateEndsAt: 'past', staleReads: 0, deletedRead: '200' };
    await fc.assert(fc.asyncProperty(settingsArb, fc.array(fc.oneof(...steps), { minLength: 8, maxLength: 40 }), async (settings, sequence) => {
      expect(await broken(w, settings, sequence), `seed ${seed}`).toEqual([]);
    }), { numRuns: 200, seed, endOnFailure: true, examples: [[lifecycleSettings, lifecycle], [queuedTwinsSettings, queuedTwins]] });
    process.stdout.write(`[p6Props] json seed ${seed}: ${JSON.stringify(tally)}\n`);
    expect({ ...tally, seed, enough: tally.purchased > 0 && tally.delivered > 0 && tally.checkpoints > 0 && tally.heldChecked > 0 && tally.left > 0 && tally.queued > 0 && tally.failedRounds > 0 }).toMatchObject({ enough: true });
  }, 3_600_000);
});
