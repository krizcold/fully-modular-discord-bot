import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { PATREON_USERS, type FakeMember } from './p7Patreon';
import { GUILDS, heldPatreon, patreonLinks, USERS, W_MS, type HeldPatreon, type P7World } from './p7World';

// Shared pieces of P7 part 2's rows (sheet P7, section 10): the texts of section 8 the rows match, and short readers
// of what premium stores. A link is made by premium's own writer (premium.linkAccount, the save the callback makes in
// part 3), a pick change by premium.setAccountHolder (the writer part 3's op calls).

export const SEC = 1000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const W = W_MS;

export const PT2 = 'Patreon pledges are made on Patreon. The member links their Patreon account on this site, and the tier their pledge pays for follows.';
export const PT11 = 'Patreon manages this subscription, so the bot cannot end or remove it. It ends when Patreon no longer shows its tier as paid, or when the member who linked it unlinks their Patreon account or moves it to another server or to their own VIP.';
export const PT12 = 'The bot cannot pause a Patreon pledge, so Patreon keeps charging it; if you no longer want it, end the pledge on patreon.com.';
export const PT13 = 'Patreon webhooks are not set up on this bot (no webhook secret is saved); nothing was applied.';
export const PT14 = "The Patreon delivery's signature does not match the saved webhook secret; nothing was applied.";

/** The start of each log line of section 8, as the rows match them. */
export const LOG = {
  PT1: '[PatreonProvider] Patreon member ',
  PT1_TAIL: 'shows no Patreon user and no stored record names one',
  PT3: '[PatreonProvider] Could not read the members of campaign',
  PT4: '[PatreonProvider] Patreon refused the creator access token (401)',
  PT5_TAIL: 'at two checks at least an hour apart',
  PT6: '[PatreonProvider] The check stopped before it finished',
  PT7_TAIL: 'its tier is kept. The bot ends it only if Patreon answers 404 again',
  PT8: '[PatreonProvider] Could not read member',
  PT10_TAIL: 'not to what the bot holds for it; no change was made',
  PT18_TAIL: 'that the bot does not follow (made by an earlier version or under another campaign)',
  PT20: '[PatreonProvider] Patreon lists the campaigns of the creator access token',
  PT24_TAIL: 'whose link no longer points there; it was handed to premium as ended',
  PT25_DELIVERY: 'from Patreon after a delivery',
  PD3_TAIL: 'Wire it to one offering; the bot tries again at its next check.',
};

export const holderOf = (p: number, guild = false): string => (guild ? `guild:${GUILDS[p]}` : `user:${USERS[p]}`);

/** Links Patreon user p to the holder with premium's own writer; whether it was saved. */
export async function link(w: P7World, p: number, holder = holderOf(p)): Promise<boolean> {
  const reply = await w.op('linkAccount', 'patreon', PATREON_USERS[p], holder, USERS[p]);
  return reply.ok && reply.result === true;
}

/** Moves Patreon user p's link to the holder with premium's own writer (the pick change's save). */
export async function pick(w: P7World, p: number, holder: string): Promise<boolean> {
  const moved = (getPremiumManager() as any).setAccountHolder('patreon', PATREON_USERS[p], USERS[p], holder) as boolean;
  await w.settle();
  return moved;
}

export const held = (w: P7World): HeldPatreon[] => heldPatreon(w.stored());
/** The Patreon tiers premium holds at a holder, `<ptier>:<location>`, sorted. */
export const tiersAt = (w: P7World, holder: string): string[] => held(w).filter(h => h.holder === holder).map(h => `${h.ptier}:${h.location}`).sort();
/** The Patreon tiers held at a holder, sorted, wherever they sit. */
export const ptiersAt = (w: P7World, holder: string): string[] => held(w).filter(h => h.holder === holder).map(h => String(h.ptier)).sort();
export const links = (w: P7World) => patreonLinks(w.stored());

/** Calls the fake answered or refused for a route, as `<route> <path>`. */
export const callsTo = (w: P7World, route: string, from = 0) => w.fake.calls.slice(from).filter(c => c.route === route);
export const memberReads = (w: P7World, m: FakeMember | string, from = 0) => {
  const id = typeof m === 'string' ? m : m.id;
  return w.fake.calls.slice(from).filter(c => c.route === 'member' && c.path.split('?')[0] === `/members/${id}`);
};

/** The events the provider handed to premium since `from`, as `<type> <holder> <ptier>`. */
export function eventsSince(w: P7World, from: number): string[] {
  return w.emitted.slice(from).filter(e => e.providerId === 'patreon').map(e => `${e.type.replace('subscription.', '')} ${e.holder} ${String(e.providerSubId).split(':')[2]}`);
}

/** Moves the clock past the lag of reads, so the next read shows Patreon's state now. */
export async function pastLag(w: P7World): Promise<void> {
  const wait = w.fake.lastChange() + w.fake.settings.staleReads * SEC + SEC - Date.now();
  if (wait > 0) await w.advance(wait);
}

/** The largest number of creator-token calls the fake saw in any one minute. */
export function busiestMinute(w: P7World, token: string): number {
  const times = w.fake.calls.filter(c => c.token === token && c.route !== 'token' && c.route !== 'identity').map(c => c.at).sort((a, b) => a - b);
  let most = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= MIN) j++;
    most = Math.max(most, i - j + 1);
  }
  return most;
}
