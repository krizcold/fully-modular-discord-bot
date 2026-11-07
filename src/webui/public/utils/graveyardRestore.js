// The Config tab's graveyard restore: what follows an answer of POST /api/data/graveyard/restore, and its done text.

// A thrown error with no numeric status is an answer that never came (fetch rejected, or a gateway's non-JSON page).
function restoreNextStep(status, body) {
  if (typeof status !== 'number') return 'no-answer';
  if (typeof status === 'number' && status >= 200 && status < 300) return 'done';
  if (status === 409 && body && body.refusal === 'live-data' && typeof body.retiredAt === 'number') return 'confirm-replace';
  return 'error';
}

function restoreDoneText(deletedAt, body) {
  const date = (ms) => new Date(ms).toLocaleString();
  const kept = date(body.keptUntil);
  const parts = [`Restored the data deleted on ${date(deletedAt)}; that entry stays in this list until ${kept}.`];
  const replaced = body.replaced;
  if (replaced && typeof replaced.retiredAt === 'number') {
    const noReason = typeof replaced.reason === 'string' ? '' : ' (listed without a reason: its note could not be written)';
    parts.push(`The data it replaced is the entry of ${date(replaced.retiredAt)} in this list${noReason}.`);
  }
  parts.push(`A module that kept the server's data in memory may save it again over the restored data; if that happens, restore this entry again with Replace before ${kept}.`);
  return parts.join(' ');
}

// The sheet's ENDING, worded as dataManager.ts's restoreNoAnswerEnding: x is the entry asked for, n the newest entry listed.
function restoreNoAnswerEnding(guildId, x, n, replace) {
  const main = 'The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.';
  const tail = x === undefined
    ? `The entry it restored, if any, stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${guildId} <its retiredAt> --replace is then safe: it copies that entry in and moves whatever the server holds into a new entry, so nothing is lost.`
    : `Entry ${x} stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${guildId} ${x} --replace is then safe: it copies entry ${x} in and moves whatever the server holds into a new entry, so nothing is lost.`;
  if (!replace) return `The outcome is fixed within a minute. ${tail} ${main}`;
  const which = x === undefined
    ? 'whose reason starts with replaced-by-restore- or is empty'
    : `${n === undefined ? '' : `newer than ${n} `}whose reason is replaced-by-restore-${x} or empty`;
  return `Within a minute the outcome is fixed (if the bot stopped mid-step, once it has started again). If \`smdb graveyard list\` then lists an entry for this server ${which}, the replace moved the server's data from before into that entry (an empty reason means its note could not be written). If not, either the server had no data or nothing changed. ${tail} ${main}`;
}

function restoreNoAnswerText(guildId, x, n, replace, message) {
  return `can't confirm whether server ${guildId} was restored: the web panel got no answer (${message}). ${restoreNoAnswerEnding(guildId, x, n, replace)}`;
}

if (typeof module !== 'undefined') module.exports = { restoreNextStep, restoreDoneText, restoreNoAnswerEnding, restoreNoAnswerText };
