// A member's server list on a Postgres bot (NB15 decision 14): the member's admin servers that this machine's bot or
// another machine's bot is in. The local child answers for its own servers; for the rest, one 'guild:membership'
// request per holder process of another machine and 100 ids asks the bot that runs them. The answer is kept per member
// for 30 s (5 s with a notice), and a web UI runs at most 2 of these fan-outs at once.

import { holderStateOf } from '../../bot/internalSetup/fleet/claimStore';
import { MAX_MEMBERSHIP_IDS, shardOfGuild } from '../../bot/internalSetup/utils/panelRequestShape';
import { changeDeadlineMs } from '../../bot/internalSetup/utils/dataBackends/guildRequestSql';
import { guildRequestDeps, sendMembership, type Outcome, type RemoteHolder } from './guildRequests';

const KEEP_MS = 30_000;
const KEEP_NOTICE_MS = 5000;
const MAP_BOUND_MS = 5000;
const MAX_FANOUTS = 2;

/** In the order a list shows them: the first one found is the list's notice. */
export const MEMBER_NOTICES = {
  noDatabase: 'Some servers could not be listed because the database could not be reached; reload to try again.',
  maintenance: 'Some servers could not be listed because the database is in maintenance; reload later.',
  tooSlow: 'Some servers could not be listed because the database answered too slowly; reload to try again.',
  noTable: 'Some servers could not be listed because the database has no table for requests between machines.',
  insertRefused: 'Some servers could not be listed because the database refused the request.',
  insecure: 'Some servers could not be listed because this web panel cannot send requests safely to the machine that runs them.',
  shuttingDown: 'Some servers could not be listed because this web panel is shutting down; reload once it is back.',
  noHolder: 'Some servers could not be listed because no machine runs them right now; reload in a moment.',
  notHeld: 'Some servers could not be listed because the bot that ran them stopped serving them; reload in a moment.',
  notTaken: 'Some servers could not be listed because the bot that runs them did not take the request in time; reload in a moment.',
  withdrawn: 'Some servers could not be listed because the database did not confirm that the request was sent; reload to try again.',
  unsettled: 'Some servers could not be listed because the database could not show whether the bot that runs them took the request; reload to try again.',
  lost: 'Some servers could not be listed because the answer of the bot that runs them could not be read from the database; reload to try again.',
  noAnswer: 'Some servers could not be listed because the bot that runs them did not answer; reload to try again.',
  failed: 'Some servers could not be listed because the bot that runs them could not list them; reload to try again.',
  unknown: "Some servers could not be listed: this web panel can't confirm what happened to the request; reload to try again.",
  connecting: 'Some servers could not be listed because the bot that runs them is still connecting to Discord; reload in a moment.',
  starting: "Some servers could not be listed because this machine's bot is starting or stopped; reload in a moment.",
  busy: 'Some servers could not be listed right now because many members are loading this list; reload in a moment.',
};

/** The notice for a membership send that did not bring back a list. */
export function memberNoticeOf(outcome: Outcome): string {
  switch (outcome.k) {
    case 'unreachable': return MEMBER_NOTICES.noDatabase;
    case 'maintenance': return MEMBER_NOTICES.maintenance;
    case 'too-slow': return MEMBER_NOTICES.tooSlow;
    case 'no-table': return MEMBER_NOTICES.noTable;
    case 'insert-refused': return MEMBER_NOTICES.insertRefused;
    case 'insecure': return MEMBER_NOTICES.insecure;
    case 'exiting':
    case 'withdrawn-at-exit': return MEMBER_NOTICES.shuttingDown;
    case 'not-taken': return MEMBER_NOTICES.notTaken;
    case 'withdrawn': return MEMBER_NOTICES.withdrawn;
    case 'no-answer':
      if (outcome.cause === 'stopped') return MEMBER_NOTICES.shuttingDown;
      if (outcome.cause === 'unsettled') return MEMBER_NOTICES.unsettled;
      if (outcome.cause === 'lost') return MEMBER_NOTICES.lost;
      return MEMBER_NOTICES.noAnswer;
    case 'reply':
      if (outcome.reply?.code === 'not-held') return MEMBER_NOTICES.notHeld;
      return MEMBER_NOTICES.failed;
  }
}

export interface MemberList {
  /** The servers found, by id. */
  ids: Set<string>;
  notice: string | null;
}

export interface MemberListDeps {
  /** The local child's 'bot:guilds' answer while it is at its guild report; null otherwise. */
  localGuilds(): Promise<{ success?: boolean; guilds?: Array<{ id: string }>; incomplete?: boolean } | null>;
  holderMap(boundMs: number): Promise<{ rows: any[]; url?: string }>;
  currentUrl(): string | null;
  nodeId(): string | null;
  membership(holder: RemoteHolder, ids: string[], memberId: string, deadline: number): Promise<Outcome>;
}

const kept = new Map<string, { at: number; list: MemberList }>();
const running = new Map<string, Promise<MemberList>>();
let fanouts = 0;

export function _resetMemberLists(): void {
  kept.clear();
  running.clear();
  fanouts = 0;
}

export function realMemberDeps(localGuilds: MemberListDeps['localGuilds']): MemberListDeps {
  const deps = guildRequestDeps();
  return {
    localGuilds,
    holderMap: boundMs => deps.holderMap(boundMs),
    currentUrl: () => deps.currentUrl(),
    nodeId: () => deps.nodeId(),
    membership: sendMembership,
  };
}

/** The member's list: a kept answer, the fan-out in flight, or a new one. */
export function memberServerList(memberId: string, adminIds: string[], deps: MemberListDeps): Promise<MemberList> {
  const now = performance.now();
  const last = kept.get(memberId);
  if (last && now - last.at < (last.list.notice ? KEEP_NOTICE_MS : KEEP_MS)) return Promise.resolve(last.list);
  const inFlight = running.get(memberId);
  if (inFlight) return inFlight;
  if (fanouts >= MAX_FANOUTS) return localOnly(adminIds, deps, last?.list.notice ?? MEMBER_NOTICES.busy);
  fanouts += 1;
  const run = fanOut(memberId, adminIds, deps).then(list => {
    const entry = { at: performance.now(), list };
    kept.set(memberId, entry);
    const end = setTimeout(() => { if (kept.get(memberId) === entry) kept.delete(memberId); }, list.notice ? KEEP_NOTICE_MS : KEEP_MS);
    (end as any).unref?.();
    return list;
  }).finally(() => {
    fanouts -= 1;
    running.delete(memberId);
  });
  running.set(memberId, run);
  return run;
}

async function localOnly(adminIds: string[], deps: MemberListDeps, notice: string): Promise<MemberList> {
  const local = await deps.localGuilds().catch(() => null);
  const ids = new Set<string>();
  const admin = new Set(adminIds);
  for (const g of local?.success ? local.guilds ?? [] : []) if (admin.has(g.id)) ids.add(g.id);
  return { ids, notice };
}

async function fanOut(memberId: string, adminIds: string[], deps: MemberListDeps): Promise<MemberList> {
  const ids = new Set<string>();
  const notices = new Set<string>();
  const admin = new Set(adminIds);
  const local = await deps.localGuilds().catch(() => null);
  const localUp = !!local?.success;
  if (localUp) {
    for (const g of local!.guilds ?? []) if (admin.has(g.id)) ids.add(g.id);
    if (local!.incomplete) notices.add(MEMBER_NOTICES.connecting);
  }
  const rest = adminIds.filter(id => !ids.has(id));
  if (rest.length > 0) await askHolders(memberId, rest, localUp, ids, notices, deps);
  return { ids, notice: Object.values(MEMBER_NOTICES).find(n => notices.has(n)) ?? null };
}

async function askHolders(memberId: string, rest: string[], localUp: boolean, ids: Set<string>, notices: Set<string>, deps: MemberListDeps): Promise<void> {
  let map: { rows: any[]; url?: string };
  try {
    map = await deps.holderMap(MAP_BOUND_MS);
  } catch {
    notices.add(MEMBER_NOTICES.noDatabase);
    return;
  }
  const url = map.url ?? deps.currentUrl();
  const here = deps.nodeId();
  const byShard = new Map<number, { held: boolean; processId?: string; node?: string | null; name?: string; count: number }>();
  for (const row of map.rows) {
    const check = holderStateOf([row]);
    if (check.kind !== 'row') continue;
    byShard.set(check.shardId, check.state === 'held'
      ? { held: true, processId: check.holderProcess!, node: check.holderNode, name: check.holderName!, count: check.shardCount }
      : { held: false, count: check.shardCount });
  }
  const count = map.rows.length > 0 ? Number(map.rows[0].n) : 0;
  if (!url) {
    notices.add(MEMBER_NOTICES.noDatabase);
    return;
  }
  if (count <= 0 || byShard.size === 0) {
    notices.add(MEMBER_NOTICES.noHolder);
    return;
  }
  const perProcess = new Map<string, { holder: Omit<RemoteHolder, 'shardId'>; ids: string[] }>();
  for (const id of rest) {
    const shard = shardOfGuild(id, count);
    const holder = byShard.get(shard);
    if (!holder || !holder.held) {
      notices.add(MEMBER_NOTICES.noHolder);
      continue;
    }
    if (here !== null && holder.node === here) {
      if (!localUp) notices.add(MEMBER_NOTICES.starting);
      continue;
    }
    const group = perProcess.get(holder.processId!) ?? { holder: { shardCount: count, processId: holder.processId!, name: holder.name!, url }, ids: [] };
    group.ids.push(id);
    perProcess.set(holder.processId!, group);
  }
  const deadline = performance.now() + changeDeadlineMs('guild:membership');
  const sends: Array<Promise<void>> = [];
  for (const { holder, ids: groupIds } of perProcess.values()) {
    for (let i = 0; i < groupIds.length; i += MAX_MEMBERSHIP_IDS) {
      const chunk = groupIds.slice(i, i + MAX_MEMBERSHIP_IDS);
      const target: RemoteHolder = { ...holder, shardId: shardOfGuild(chunk[0], count) };
      sends.push(deps.membership(target, chunk, memberId, deadline).then(outcome => {
        if (outcome.k === 'reply' && outcome.reply?.code === 'member-panel-off') return;
        if (outcome.k !== 'reply' || outcome.reply?.success !== true) {
          notices.add(memberNoticeOf(outcome));
          return;
        }
        const reply = outcome.reply;
        for (const g of reply.guilds ?? []) if (chunk.includes(String(g.id))) ids.add(String(g.id));
        if (reply.incomplete) notices.add(MEMBER_NOTICES.connecting);
      }, () => { notices.add(MEMBER_NOTICES.unknown); }));
    }
  }
  await Promise.all(sends);
}
