import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// P7 claim 12 (sheet P7, section 10) in full: what premium holds for each linked Patreon user is what Patreon shows
// that user's member paying for. The real PatreonProvider and the real PremiumManager in the bot role over the JSON
// files (helpers/p7World.ts), and the fake of helpers/p7Patreon.ts as Patreon, with R1 to R22 drawn per run
// (`notFoundLive` empty, the campaign and the creator token kept, `staleReads` at most W). A link is the member routes'
// flow (start, Patreon's approval, the callback in the same session) to the user's own VIP, to the server the user owns
// (a pick change when linked elsewhere, a relink when linked there), or to a server another user owns (refused); an
// unlink is the VIP unlink route. Random sequences of link, unlink, pledge, cancel, periodEnd, decline, refund,
// refundedByPatreon, partialRefund, fraud, changeTier,
// startTrial, chargeTrial (paid or declined), gift, deleteMember (of a member who never paid), the delivery of every
// queued delivery or of one, drop, duplicate, reorder and replay of a delivery, a restart, a manual grant of the higher
// user tier for a day and its revoke, clock steps (which run the timed rounds and re-reads), rounds with Patreon
// answering, and rounds with Patreon failing on one route.
//
// P1 is checked at each `round` step's checkpoint: once reads are older than `staleReads` after Patreon's last change,
// a round, then W and 31 seconds for the re-reads and the armed rounds, then two rounds 31 seconds apart that Patreon
// answered (none of PT3, PT4, PT6, PT7, PT8 and PT20 logged); and at the end, after two rounds 61 minutes apart. Expected
// per Patreon user u with a link to holder h: u's followed records are exactly (h, t) for each tier t of its member that
// THE FIELD RULE reads as paid (none after a refund or fraud), wired for h's kind, not in a trial, where a tier no record
// held installs only with the install allowance; of tiers sharing a priority exactly one is held. Whether a tier is
// held where the allowance came and went between checkpoints depends on whether a read saw it, so the oracle keeps,
// per member and tier, the values a read of each state Patreon showed since the last checkpoint could leave (P1 then
// accepts either where both are possible); a masked member's tier no record names is never required (R11); a member
// Patreon deleted may keep its records until the end (two 404s an hour apart). With no link, u holds none, and no
// record names a holder its link does not name. No call reached a route the fake does not serve.
// A masked member's tiers are neither required nor refused (a pledge made after its last link waits for a relink, R11);
// a pick change leaves no tier the new holder cannot take (not wired for its kind, or a manual plan at its priority).
// P2, after every step: no record was removed without a member read showing its tier unpaid, two 404s for its member
// an hour apart, or its link no longer naming its holder.
//
// On P6's tree it fails at the first checkpoint: pp installs nothing outside its callback.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { allowDropLines } from '../helpers/p1Guard';
import { PATREON_USERS, PTIER, readFields, type FakeMember, type FieldName, type PatreonFault, type PatreonSettings, type RouteKind } from '../helpers/p7Patreon';
import { GUILDS, heldPatreon, p7World, patreonLinks, PRIORITY, USERS, W_MS, WIRING, type P7TierId, type P7World } from '../helpers/p7World';

type TierName = 'A' | 'A2' | 'B' | 'S' | 'UNWIRED';
type FailKind = 'campaigns500' | 'members500' | 'members429' | 'membersMalformed' | 'member500' | 'memberNoAnswer';
type MemberAction = 'cancel' | 'periodEnd' | 'decline' | 'refund' | 'refundedByPatreon' | 'partialRefund' | 'fraud' | 'chargeTrialPaid' | 'chargeTrialDeclined' | 'deleteMember';
type Step =
  | { t: 'link'; p: number; to: 'me' | 'own' | 'other' }
  | { t: 'unlink'; p: number }
  | { t: 'pledge'; p: number; tier: TierName }
  | { t: MemberAction; p: number }
  | { t: 'changeTier'; p: number; to: TierName }
  | { t: 'startTrial'; p: number; tier: TierName }
  | { t: 'gift'; p: number; tier: TierName; trial: boolean | null }
  | { t: 'deliver' }
  | { t: 'deliverOne' | 'drop' | 'duplicate' | 'replay'; pick: number }
  | { t: 'reorder'; from: number; to: number }
  | { t: 'restart' }
  | { t: 'grant' | 'revoke'; p: number }
  | { t: 'clock'; ms: number }
  | { t: 'round' }
  | { t: 'roundFail'; kind: FailKind };

const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const pick = fc.nat({ max: 15 });
const who = fc.nat({ max: PATREON_USERS.length - 1 });
const tierName = fc.constantFrom<TierName>('A', 'A', 'A2', 'B', 'B', 'S', 'UNWIRED');
const MEMBER_ACTIONS: MemberAction[] = ['cancel', 'periodEnd', 'decline', 'refund', 'refundedByPatreon', 'partialRefund', 'fraud', 'chargeTrialPaid', 'chargeTrialDeclined', 'deleteMember'];
const link = fc.record({ t: fc.constant('link' as const), p: who, to: fc.constantFrom<'me' | 'own' | 'other'>('me', 'me', 'own', 'own', 'other') });
const unlink = fc.record({ t: fc.constant('unlink' as const), p: who });
const pledge = fc.record({ t: fc.constant('pledge' as const), p: who, tier: tierName });
const deliver = fc.record({ t: fc.constant('deliver' as const) });
const round = fc.record({ t: fc.constant('round' as const) });
const steps: fc.Arbitrary<Step>[] = [
  link, link, link, unlink, pledge, pledge, pledge,
  fc.record({ t: fc.constantFrom<MemberAction>(...MEMBER_ACTIONS), p: who }),
  fc.record({ t: fc.constantFrom<MemberAction>(...MEMBER_ACTIONS), p: who }),
  fc.record({ t: fc.constant('changeTier' as const), p: who, to: tierName }),
  fc.record({ t: fc.constant('startTrial' as const), p: who, tier: tierName }),
  fc.record({ t: fc.constant('gift' as const), p: who, tier: tierName, trial: fc.constantFrom<boolean | null>(false, true, null) }),
  deliver, deliver,
  fc.record({ t: fc.constantFrom<'deliverOne' | 'drop' | 'duplicate' | 'replay'>('deliverOne', 'drop', 'duplicate', 'replay'), pick }),
  fc.record({ t: fc.constant('reorder' as const), from: pick, to: pick }),
  fc.record({ t: fc.constant('restart' as const) }),
  fc.record({ t: fc.constantFrom<'grant' | 'revoke'>('grant', 'revoke'), p: who }),
  fc.record({ t: fc.constant('clock' as const), ms: fc.constantFrom(30 * SEC, 5 * MIN, 11 * MIN, 2 * HOUR, 25 * HOUR) }),
  round, round,
  fc.record({ t: fc.constant('roundFail' as const), kind: fc.constantFrom<FailKind>('campaigns500', 'members500', 'members429', 'membersMalformed', 'member500', 'memberNoAnswer') }),
];

/** The nullable fields THE FIELD RULE reads a null of (a null elsewhere is malformed, rows F1 to F4 cover it). */
const READ_NULLS: FieldName[] = ['is_free_trial', 'campaign_lifetime_support_cents', 'is_gifted', 'last_charge_status', 'last_charge_date', 'patron_status', 'user'];
const settingsArb: fc.Arbitrary<Partial<PatreonSettings>> = fc.record({
  retryNon2xx: fc.boolean(),
  batch: fc.constantFrom<'separate' | 'array'>('separate', 'array'),
  reorder: fc.boolean(),
  cancelEnds: fc.constantFrom<'now' | 'periodEnd'>('now', 'periodEnd'),
  declinedKeeps: fc.boolean(),
  refundDrops: fc.boolean(),
  giftedEntitled: fc.boolean(),
  lapseEvent: fc.boolean(),
  pageOrder: fc.constantFrom<'created' | 'reverse' | 'shuffled'>('created', 'reverse', 'shuffled'),
  skipOnChange: fc.boolean(),
  dupOnChange: fc.boolean(),
  staleReads: fc.constantFrom(0, 40, 300),
  maskUser: fc.constantFrom<'none' | 'one' | 'all'>('none', 'none', 'one', 'all'),
  multiTier: fc.boolean(),
  trialFlag: fc.constantFrom<'clears' | 'stays'>('clears', 'stays'),
  newMemberOnRenew: fc.boolean(),
  deliveryTimeout: fc.constantFrom(3, 10, 60),
  freeTierListed: fc.boolean(),
  pauseKeeps: fc.boolean(),
  refundLowersLifetime: fc.boolean(),
  partialAsRefunded: fc.boolean(),
  returningTrial: fc.boolean(),
  giftCharge: fc.constantFrom<'never' | 'giver'>('never', 'giver'),
  nullField: fc.subarray(READ_NULLS, { maxLength: 2 }).map(list => new Set<FieldName>(list)),
});

const FAULTS: Record<FailKind, { route: RouteKind; fault: PatreonFault }> = {
  campaigns500: { route: 'campaigns', fault: { status: 500 } },
  members500: { route: 'members', fault: { status: 500 } },
  members429: { route: 'members', fault: { status: 429, retryAfter: 5 } },
  membersMalformed: { route: 'members', fault: { body: 'malformed' } },
  member500: { route: 'member', fault: { status: 500 } },
  memberNoAnswer: { route: 'member', fault: { noAnswer: true } },
};
/** The lines that make a round not a checkpoint: PT3, PT4, PT6, PT7, PT8 (and PT25) and PT20. */
const NOT_ANSWERED = [
  '[PatreonProvider] Could not read the members of campaign',
  '[PatreonProvider] Patreon refused the creator access token',
  '[PatreonProvider] The check stopped before it finished',
  '[PatreonProvider] Patreon answered 404 for member',
  '[PatreonProvider] Could not read member',
  '[PatreonProvider] Patreon lists the campaigns',
];
const ALL_TIERS = [PTIER.A, PTIER.A2, PTIER.B, PTIER.S, PTIER.UNWIRED, PTIER.FREE];

/** Across a describe's runs. */
const tally = { steps: 0, links: 0, pledges: 0, delivered: 0, checkpoints: 0, required: 0, heldChecked: 0, left: 0, queued: 0, restarts: 0, grants: 0, failedRounds: 0, endChecks: 0, picks: 0, unlinks: 0 };

function runSeed(): number {
  return fc.readConfigureGlobal().seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0);
}

/**
 * What a run knows beyond the fake: per member and tier, the held values a read of some state since the last
 * checkpoint could have left (THE LAG RULE and the re-reads make any of those reads possible, in any order).
 */
interface RunState { settings: Partial<PatreonSettings>; possible: Map<string, Set<boolean>>; lastDelivery: number }

const keyOf = (memberId: string, ptier: string): string => `${memberId}:${ptier}`;
const linkOf = (w: P7World, p: number) => patreonLinks(w.stored())[PATREON_USERS[p]] ?? null;
const holderKind = (holder: string): 'user' | 'guild' => (holder.startsWith('user:') ? 'user' : 'guild');

function manualAt(w: P7World, holder: string): any | null {
  const record = w.stored()?.subscriptions?.[holder];
  return [record?.active, ...(record?.paused ?? [])].find((s: any) => s?.source === 'manual') ?? null;
}

/**
 * Whether a read of the member's state now would install, end, or leave the tier as it is at the link's holder; a
 * masked member's tier that may install may be held or not (a link's callback proves its user, a round cannot); in a
 * trial or without the install allowance it installs for nobody.
 */
function transition(w: P7World, m: FakeMember, ptier: string, holder: string): 'set' | 'clear' | 'keep' | 'either' {
  const read = w.fake.currentRead(m);
  if (!read) return 'keep';
  const reading = readFields(read.data, read.included);
  if (reading.malformed) return 'keep';
  const tierId = WIRING[holderKind(holder)][ptier];
  if (!tierId || !reading.paid.includes(ptier)) return 'clear';
  if (reading.trial || !reading.allowance) return 'keep';
  const manual = manualAt(w, holder);
  if (manual && PRIORITY[tierId] === PRIORITY[manual.tierId as P7TierId]) return 'keep';
  return reading.userId === null ? 'either' : 'set';
}

/** After a step: each linked member's tiers take the values a read of what Patreon shows now could leave. */
function noteStates(w: P7World, s: RunState): void {
  for (const [p, u] of PATREON_USERS.entries()) {
    const l = linkOf(w, p);
    if (!l) continue;
    for (const m of w.fake.members.values()) {
      if (m.userId !== u || m.deleted) continue;
      for (const t of ALL_TIERS) {
        const key = keyOf(m.id, t);
        const values = s.possible.get(key) ?? new Set<boolean>([false]);
        const f = transition(w, m, t, l.holder);
        if (f === 'set' || f === 'either') values.add(true);
        if (f === 'clear' || f === 'either') values.add(false);
        s.possible.set(key, values);
      }
    }
  }
}

/**
 * After a link step: an unlink leaves the user's member holding nothing; a move to another holder leaves held only the
 * tiers that holder can take (wired for its kind, no manual plan at its priority), which move as they are.
 */
function noteLink(w: P7World, s: RunState, p: number, before: { holder: string } | null): void {
  const after = linkOf(w, p);
  if (after && before && after.holder === before.holder) return;
  if (!after && !before) return;
  const manual = after ? manualAt(w, after.holder) : null;
  for (const m of w.fake.members.values()) {
    if (m.userId !== PATREON_USERS[p]) continue;
    for (const t of ALL_TIERS) {
      const tierId = after ? WIRING[holderKind(after.holder)][t] : undefined;
      const refused = !tierId || (manual && PRIORITY[tierId] === PRIORITY[manual.tierId as P7TierId]);
      if (refused) s.possible.set(keyOf(m.id, t), new Set([false]));
    }
  }
}

/** The member routes' link: start for `forWhat`, Patreon user p approves, the callback in the same session. */
async function linkThrough(w: P7World, p: number, forWhat: string): Promise<number> {
  const started = await w.memberRoute(USERS[p], 'get', '/patreon/start', { query: { for: forWhat } });
  if (!started.redirect?.startsWith('https://www.patreon.com/oauth2/authorize?')) throw new Error(`the start answered ${started.status}: ${started.html}`);
  const approved = w.fake.approve(started.redirect, PATREON_USERS[p]);
  const page = await w.memberRoute(USERS[p], 'get', '/patreon/callback', { query: approved.query });
  return page.status;
}

const choose = <T>(list: T[], at: number): T | null => (list.length === 0 ? null : list[at % list.length]);

async function run(w: P7World, s: RunState, step: Step): Promise<void> {
  const fake = w.fake;
  const memberOfP = (p: number): FakeMember | null => fake.memberOf(PATREON_USERS[p]);
  switch (step.t) {
    case 'link': {
      const before = linkOf(w, step.p);
      const forWhat = step.to === 'me' ? 'me' : GUILDS[step.to === 'own' ? step.p : (step.p + 1) % GUILDS.length];
      const status = await linkThrough(w, step.p, forWhat);
      if (step.to === 'other' && status !== 403) throw new Error(`a link to another user's server answered ${status}`);
      if (status === 200) tally.links += 1;
      if (status === 200 && before && before.holder !== linkOf(w, step.p)?.holder) tally.picks += 1;
      noteLink(w, s, step.p, before);
      return;
    }
    case 'unlink': {
      const before = linkOf(w, step.p);
      const answer = await w.memberRoute(USERS[step.p], 'delete', '/patreon/link');
      if (before && answer.status === 200) tally.unlinks += 1;
      noteLink(w, s, step.p, before);
      return;
    }
    case 'pledge':
      fake.pledge(PATREON_USERS[step.p], PTIER[step.tier]);
      tally.pledges += 1;
      return;
    case 'changeTier': {
      const m = memberOfP(step.p);
      if (m && m.state.entitled.length > 0) fake.changeTier(m, PTIER[step.to]);
      return;
    }
    case 'startTrial':
      fake.startTrial(PATREON_USERS[step.p], PTIER[step.tier]);
      return;
    case 'gift':
      fake.gift(PATREON_USERS[step.p], PTIER[step.tier], { isFreeTrial: step.trial });
      return;
    case 'cancel':
    case 'periodEnd':
    case 'decline':
    case 'refund':
    case 'refundedByPatreon':
    case 'partialRefund':
    case 'fraud': {
      const m = memberOfP(step.p);
      if (m) fake[step.t](m);
      return;
    }
    case 'chargeTrialPaid':
    case 'chargeTrialDeclined': {
      const m = memberOfP(step.p);
      if (m && m.state.isFreeTrial === true && m.state.lastChargeDate === null) fake.chargeTrial(m, step.t === 'chargeTrialPaid');
      return;
    }
    case 'deleteMember': {
      const m = memberOfP(step.p);
      if (m && (m.state.lifetime ?? 0) === 0 && m.state.lastChargeDate === null) fake.deleteMember(m);
      return;
    }
    case 'deliver': {
      const out = await w.deliverAll();
      tally.delivered += out.length;
      if (out.length > 0) s.lastDelivery = Date.now();
      return;
    }
    case 'deliverOne': {
      if (fake.queue.length === 0) return;
      const out = await w.deliver(step.pick % fake.queue.length);
      tally.delivered += out.length;
      s.lastDelivery = Date.now();
      return;
    }
    case 'drop':
      if (fake.queue.length > 0) fake.drop(step.pick % fake.queue.length);
      return;
    case 'duplicate':
      if (fake.queue.length > 0) fake.duplicate(step.pick % fake.queue.length);
      return;
    case 'reorder':
      if (fake.queue.length > 1) fake.reorderQueue(step.from % fake.queue.length, step.to % fake.queue.length);
      return;
    case 'replay': {
      const old = choose(fake.posted, step.pick);
      if (!old) return;
      await w.pump(fake.replay(old.delivery));
      await w.settle();
      s.lastDelivery = Date.now();
      return;
    }
    case 'restart':
      await w.restart();
      tally.restarts += 1;
      return;
    case 'grant': {
      const l = linkOf(w, step.p);
      const holder = `user:${USERS[step.p]}`;
      if (!l || l.holder !== holder || manualAt(w, holder)) return;
      const m = memberOfP(step.p);
      if (m && m.state.entitled.includes(PTIER.B)) return;
      if (heldPatreon(w.stored()).some(h => h.holder === holder && h.ptier !== null && WIRING.user[h.ptier] === 'star')) return;
      const reply = await w.op('grantManual', holder, 'star', 1);
      if (reply.ok) tally.grants += 1;
      return;
    }
    case 'revoke': {
      const holder = `user:${USERS[step.p]}`;
      if (w.stored()?.subscriptions?.[holder]?.active?.source === 'manual') await w.op('revokeManual', holder);
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
      await w.roundAdvancing(6 * MIN);
      fake.clearFaults();
      tally.failedRounds += 1;
    }
  }
}

/** A round, and whether Patreon answered it whole (none of the lines of NOT_ANSWERED). */
async function answeredRound(w: P7World): Promise<boolean> {
  const from = w.logs.length;
  await w.round();
  return !w.logs.slice(from).some(l => NOT_ANSWERED.some(p => l.startsWith(p)));
}

/** The checkpoint: reads past the lag, a round, W and 31 s for re-reads and armed rounds, then two answered rounds 31 s apart. */
async function checkpoint(w: P7World, s: RunState): Promise<boolean> {
  const stale = (s.settings.staleReads ?? 0) * SEC;
  const wait = w.fake.lastChange() + stale + SEC - Date.now();
  if (wait > 0) await w.advance(wait);
  await w.round();
  await w.advance(W_MS + 31 * SEC);
  const first = await answeredRound(w);
  await w.advance(31 * SEC);
  const second = await answeredRound(w);
  return first && second;
}

/** P1: what broke, collected for the caller to assert on. `end`: a deleted member's records must be gone. */
function brokenP1(w: P7World, s: RunState, end: boolean): string[] {
  const broken: string[] = [];
  const doc = w.stored();
  const links = patreonLinks(doc);
  const held = heldPatreon(doc);
  const seen = new Set<string>();
  for (const h of held) {
    if (seen.has(h.sub.providerSubId)) broken.push(`P1: ${h.sub.providerSubId} is held twice`);
    seen.add(h.sub.providerSubId);
    if (h.memberId === null) continue;
    const u = String(h.sub.providerMeta?.patreonUserId ?? '');
    const l = links[u];
    if (!l) broken.push(`P1: ${h.holder} holds ${h.sub.providerSubId} of Patreon user '${u}', which has no link`);
    else if (l.holder !== h.holder) broken.push(`P1: ${h.holder} holds ${h.sub.providerSubId} of Patreon user ${u}, whose link names ${l.holder}`);
    else if (h.sub.buyerId !== l.buyerId) broken.push(`P1: ${h.sub.providerSubId} names buyer ${h.sub.buyerId}; the link's buyer is ${l.buyerId}`);
    const m = w.fake.members.get(h.memberId);
    if (!m) broken.push(`P1: ${h.holder} holds ${h.sub.providerSubId}, a member Patreon never had`);
    else if (m.userId !== u) broken.push(`P1: ${h.sub.providerSubId} names Patreon user ${u}; its member is user ${m.userId}'s`);
  }
  for (const [p, u] of PATREON_USERS.entries()) {
    const l = links[u];
    const mine = held.filter(h => h.memberId !== null && w.fake.members.get(h.memberId)?.userId === u);
    if (!l) {
      for (const h of mine) broken.push(`P1: Patreon user ${u} has no link, and ${h.holder} holds ${h.sub.providerSubId}`);
      continue;
    }
    const kind = holderKind(l.holder);
    for (const h of mine) {
      tally.heldChecked += 1;
      if (h.location === 'paused') tally.queued += 1;
      const m = w.fake.members.get(h.memberId!)!;
      if (m.deleted && end) broken.push(`P1: ${h.holder} holds ${h.sub.providerSubId} of member ${m.id}, deleted on Patreon, after two 404s an hour apart`);
    }
    const live = w.fake.memberOf(u);
    if (!live) continue;
    const required: string[] = [];
    const either: string[] = [];
    for (const t of ALL_TIERS) {
      const tierId = WIRING[kind][t];
      const isHeld = mine.some(h => h.memberId === live.id && h.ptier === t);
      const values = new Set<boolean>();
      const f = transition(w, live, t, l.holder);
      for (const v of s.possible.get(keyOf(live.id, t)) ?? new Set([false])) values.add(f === 'set' ? true : f === 'clear' ? false : v);
      if (f === 'either') values.add(true).add(false);
      if (!tierId) {
        if (isHeld) broken.push(`P1: ${l.holder} holds Patreon tier ${t} of member ${live.id}, which no ${kind} tier is wired to`);
        continue;
      }
      if (values.size === 2) either.push(t);
      else if (values.has(true)) required.push(t);
      else if (isHeld) broken.push(`P1: ${l.holder} holds Patreon tier ${t} of member ${live.id} (user ${p}), which Patreon does not show paid for, or which never had the install allowance (${JSON.stringify(w.fake.currentRead(live)?.data.attributes)})`);
    }
    const byPriority = new Map<number, { required: string[]; either: string[] }>();
    for (const t of required) {
      const pr = PRIORITY[WIRING[kind][t]];
      byPriority.set(pr, { required: [...(byPriority.get(pr)?.required ?? []), t], either: byPriority.get(pr)?.either ?? [] });
    }
    for (const t of either) {
      const pr = PRIORITY[WIRING[kind][t]];
      byPriority.set(pr, { required: byPriority.get(pr)?.required ?? [], either: [...(byPriority.get(pr)?.either ?? []), t] });
    }
    for (const [priority, group] of byPriority) {
      const heldOf = [...group.required, ...group.either].filter(t => mine.some(h => h.memberId === live.id && h.ptier === t));
      tally.required += group.required.length;
      if (group.required.length > 0 && heldOf.length !== 1) {
        broken.push(`P1: ${l.holder}, linked to Patreon user ${u}, holds ${heldOf.length} of the tiers at priority ${priority} Patreon shows paid for (${group.required.join(', ')} required, ${group.either.join(', ') || 'none'} allowed)`);
      } else if (heldOf.length > 1) {
        broken.push(`P1: ${l.holder} holds ${heldOf.length} Patreon tiers at priority ${priority} (${heldOf.join(', ')})`);
      }
    }
  }
  for (const call of w.fake.unexpected) broken.push(`a call the fake does not serve: ${call}`);
  return broken;
}

/**
 * P2: each record premium held before the step and not after it has end evidence made while it was held: a member read
 * or 404 from the start of the window in which the record was first held (`since`). `since` then follows what is held
 * after the window, each newly held record from `windowStart`.
 */
function brokenP2(w: P7World, before: Map<string, { holder: string; memberId: string | null; ptier: string | null; user: string }>, since: Map<string, number>, windowStart: number): string[] {
  const broken: string[] = [];
  const after = new Set(heldPatreon(w.stored()).map(h => h.sub.providerSubId as string));
  const links = patreonLinks(w.stored());
  for (const [id, h] of before) {
    if (after.has(id) || h.memberId === null) continue;
    tally.left += 1;
    if (links[h.user]?.holder !== h.holder) continue;
    const heldFrom = since.get(id) ?? 0;
    const reads = w.fake.calls.filter(c => c.at >= heldFrom && c.route === 'member' && c.path.split('?')[0] === `/members/${h.memberId}`);
    const readUnpaid = reads.some(c => {
      if (c.status !== 200 || !c.body) return false;
      const body = c.body as { data: any; included?: any[] };
      const reading = readFields(body.data, body.included ?? []);
      return reading.malformed === null && !reading.paid.includes(h.ptier!);
    });
    const notFound = reads.filter(c => c.status === 404).map(c => c.at);
    const twice404 = notFound.length >= 2 && Math.max(...notFound) - Math.min(...notFound) >= HOUR;
    if (!readUnpaid && !twice404) broken.push(`P2: ${h.holder} lost ${id} with no member read since it was held showing tier ${h.ptier} unpaid and no two 404s an hour apart`);
  }
  for (const id of [...since.keys()]) if (!after.has(id)) since.delete(id);
  for (const id of after) if (!since.has(id)) since.set(id, windowStart);
  return broken;
}

const heldNow = (w: P7World) => new Map(heldPatreon(w.stored()).map(h => [h.sub.providerSubId as string, { holder: h.holder, memberId: h.memberId, ptier: h.ptier, user: String(h.sub.providerMeta?.patreonUserId ?? '') }]));

/** After a checked checkpoint: the values the oracle knows are the ones premium holds now. */
function rebase(w: P7World, s: RunState): void {
  const held = heldPatreon(w.stored());
  for (const key of s.possible.keys()) {
    const [memberId, t] = key.split(':');
    s.possible.set(key, new Set([held.some(h => h.memberId === memberId && h.ptier === t)]));
  }
}

async function broken(w: P7World, settings: Partial<PatreonSettings>, sequence: Step[]): Promise<string[]> {
  const found: string[] = [];
  const s: RunState = { settings, possible: new Map(), lastDelivery: 0 };
  const since = new Map<string, number>();
  await w.setup({ settings });
  allowDropLines('L3');
  try {
    for (const [index, step] of sequence.entries()) {
      const before = heldNow(w);
      const stepStart = Date.now();
      await run(w, s, step);
      noteStates(w, s);
      tally.steps += 1;
      for (const line of brokenP2(w, before, since, stepStart)) found.push(`${line} after step ${index} ${JSON.stringify(step)}`);
      if (step.t === 'round') {
        const p2Before = heldNow(w);
        const checkStart = Date.now();
        const checkable = await checkpoint(w, s);
        for (const line of brokenP2(w, p2Before, since, checkStart)) found.push(`${line} in the checkpoint after step ${index}`);
        if (checkable) {
          tally.checkpoints += 1;
          const lines = brokenP1(w, s, false);
          for (const line of lines) found.push(`${line} after step ${index} ${JSON.stringify(step)}`);
          if (lines.length === 0) rebase(w, s);
        }
      }
      if (found.length > 0) return found;
    }
    const before = heldNow(w);
    const endStart = Date.now();
    await w.advance(2 * MIN);
    await w.round();
    await w.advance(61 * MIN);
    await w.round();
    const checkable = await checkpoint(w, s);
    found.push(...brokenP2(w, before, since, endStart).map(l => `${l} at the end`));
    if (!checkable) found.push('the end: the last rounds were not answered whole');
    tally.endChecks += 1;
    found.push(...brokenP1(w, s, true).map(l => `${l} at the end`));
  } finally {
    await w.teardown();
  }
  return found;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('P7 claim 12 on the JSON files: Patreon pledges of linked users, with deliveries lost, late and replayed, and rounds', () => {
  const w = p7World('json');

  it('P1 after every checkpoint and at the end, P2 after every step', async () => {
    Object.assign(tally, { steps: 0, links: 0, pledges: 0, delivered: 0, checkpoints: 0, required: 0, heldChecked: 0, left: 0, queued: 0, restarts: 0, grants: 0, failedRounds: 0, endChecks: 0, picks: 0, unlinks: 0 });
    const seed = runSeed();
    const lifecycle: Step[] = [
      { t: 'link', p: 0, to: 'me' }, { t: 'pledge', p: 0, tier: 'A' }, { t: 'deliver' }, { t: 'link', p: 1, to: 'own' }, { t: 'pledge', p: 1, tier: 'S' },
      { t: 'drop', pick: 0 }, { t: 'round' }, { t: 'pledge', p: 0, tier: 'B' }, { t: 'deliver' }, { t: 'round' },
      { t: 'cancel', p: 0 }, { t: 'deliver' }, { t: 'clock', ms: 2 * HOUR }, { t: 'round' },
      { t: 'restart' }, { t: 'refund', p: 1 }, { t: 'roundFail', kind: 'member500' }, { t: 'clock', ms: 2 * HOUR }, { t: 'round' },
    ];
    const lifecycleSettings: Partial<PatreonSettings> = { staleReads: 40, maskUser: 'none', cancelEnds: 'now', refundDrops: false, multiTier: true, retryNon2xx: true };
    const trialAndGift: Step[] = [
      { t: 'link', p: 2, to: 'me' }, { t: 'startTrial', p: 2, tier: 'A' }, { t: 'deliver' }, { t: 'round' }, { t: 'chargeTrialPaid', p: 2 }, { t: 'deliver' }, { t: 'round' },
      { t: 'decline', p: 2 }, { t: 'deliver' }, { t: 'round' }, { t: 'link', p: 0, to: 'own' }, { t: 'gift', p: 0, tier: 'B', trial: null }, { t: 'round' },
      { t: 'grant', p: 2 }, { t: 'clock', ms: 25 * HOUR }, { t: 'round' },
    ];
    const trialAndGiftSettings: Partial<PatreonSettings> = { staleReads: 0, maskUser: 'none', trialFlag: 'stays', declinedKeeps: true, giftedEntitled: true, giftCharge: 'never' };
    const picks: Step[] = [
      { t: 'link', p: 0, to: 'me' }, { t: 'pledge', p: 0, tier: 'A' }, { t: 'deliver' }, { t: 'round' }, { t: 'decline', p: 0 }, { t: 'deliver' },
      { t: 'link', p: 0, to: 'own' }, { t: 'round' }, { t: 'link', p: 0, to: 'other' }, { t: 'link', p: 0, to: 'me' }, { t: 'round' },
      { t: 'unlink', p: 0 }, { t: 'round' }, { t: 'link', p: 0, to: 'own' }, { t: 'periodEnd', p: 0 }, { t: 'deliver' }, { t: 'round' },
    ];
    const picksSettings: Partial<PatreonSettings> = { staleReads: 40, maskUser: 'none', declinedKeeps: true, multiTier: false };
    const maskedTrial: Step[] = [
      { t: 'link', p: 0, to: 'me' }, { t: 'startTrial', p: 0, tier: 'A' }, { t: 'deliver' }, { t: 'round' }, { t: 'link', p: 0, to: 'me' }, { t: 'round' },
    ];
    const maskedTrialSettings: Partial<PatreonSettings> = { staleReads: 0, maskUser: 'all', trialFlag: 'stays' };
    await fc.assert(fc.asyncProperty(settingsArb, fc.array(fc.oneof(...steps), { minLength: 8, maxLength: 40 }), async (settings, sequence) => {
      expect(await broken(w, settings, sequence), `seed ${seed}`).toEqual([]);
    }), { numRuns: 200, seed, endOnFailure: true, examples: [[lifecycleSettings, lifecycle], [trialAndGiftSettings, trialAndGift], [picksSettings, picks], [maskedTrialSettings, maskedTrial]] });
    process.stdout.write(`[p7Props] json seed ${seed}: ${JSON.stringify(tally)}\n`);
    expect({ ...tally, seed, enough: tally.links > 0 && tally.pledges > 0 && tally.delivered > 0 && tally.checkpoints > 0 && tally.required > 0 && tally.heldChecked > 0 && tally.left > 0 && tally.queued > 0 && tally.failedRounds > 0 && tally.picks > 0 && tally.unlinks > 0 }).toMatchObject({ enough: true });
  }, 3_600_000);
});
