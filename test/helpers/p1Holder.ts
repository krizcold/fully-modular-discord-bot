// The holder keys a row passes to premium and reads from the store (sheet P1, section 2). This file imports nothing,
// so a mock factory may use it.

export type TestHolder = `guild:${string}` | `user:${string}`;

const DISCORD_ID = /^[1-9][0-9]{0,19}$/;
function checked(id: string, helper: string): string {
  if (typeof id !== 'string' || !DISCORD_ID.test(id)) throw new Error(`${helper}(${JSON.stringify(id)}): not a Discord id, so this is no holder key`);
  return id;
}

/** The holder key of a server; throws for a text that is no Discord id (a key wrapped twice, a name). */
export const gh = (id: string): TestHolder => `guild:${checked(id, 'gh')}`;
/** The holder key of a user; throws as gh does. */
export const uh = (id: string): TestHolder => `user:${checked(id, 'uh')}`;

/** The Discord user a seeded provider account link names as the one who linked it. */
export const LINK_BUYER = '80000000000000001';
/** A provider account link as the store holds one. */
export const linkOf = (serverId: string, buyerId: string = LINK_BUYER): { holder: TestHolder; buyerId: string } => ({ holder: gh(serverId), buyerId });
