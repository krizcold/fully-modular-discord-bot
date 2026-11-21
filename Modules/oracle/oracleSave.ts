import { randomBytes } from 'crypto';
import { confirmSaved, saveModuleData } from '@internal/utils/dataManager';

/** The module the act run's listing reads (oracle.mjs MODULE, actionsSql). */
export const MODULE = 'oracle';
/** A nonce as oracle.mjs actionNonce makes it: act_<run>_<lane>_<n>. */
export const NONCE = /^act_[a-z0-9]+_[a-z0-9]+_\d+$/;

let runs = 0;
/** A tag of its own for every run of an action, so a second run of one nonce is a second doc (README "act writer"). */
export function actionTag(): string {
  runs += 1;
  return `${Date.now().toString(36)}${process.pid.toString(36)}${runs.toString(36)}${randomBytes(4).toString('hex')}`;
}

/** The nonce of a panel button id `act:<nonce>` (the act writer sends `--button` + `:` + nonce), or null. */
export function nonceOfButton(buttonId: string): string | null {
  const i = buttonId.indexOf(':');
  const n = i < 0 ? '' : buttonId.slice(i + 1);
  return NONCE.test(n) ? n : null;
}

/**
 * One run of an action: saves `<nonce>.<tag>.json` in module oracle of the guild and returns only once the store
 * holds it. Throws with a text that says whether anything may have been saved.
 */
export async function saveAction(guildId: string | null | undefined, nonce: string | null, kind: 'button' | 'invoke'): Promise<string> {
  if (!guildId) throw new Error('The oracle action needs a server; nothing was saved.');
  if (!nonce || !NONCE.test(nonce)) throw new Error('The oracle action needs a nonce of the form act_<run>_<lane>_<n>; nothing was saved.');
  const file = `${nonce}.${actionTag()}.json`;
  if (!saveModuleData(file, guildId, MODULE, { nonce, kind, at: new Date().toISOString() })) {
    throw new Error('The oracle action\'s save was not accepted; nothing was saved.');
  }
  const outcome = await confirmSaved(guildId, { category: MODULE });
  if (outcome === 'refused') throw new Error('The oracle action\'s save was refused; nothing was saved.');
  if (outcome !== 'ok') throw new Error(`Can't confirm the oracle action's save (${outcome}); it may have been saved.`);
  return file;
}
