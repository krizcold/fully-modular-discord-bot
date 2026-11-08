// What the bot process still holds, in the words every maintenance and migration text uses (NB13 decision 6). No
// imports, so the web UI process loads it as well.

export interface HeldCounts {
  /** Guilds holding writes not stored, less those holding only a save the database did not answer. */
  unsavedGuilds: number;
  unsavedFiles: number;
  /** Guilds holding a save the database did not answer, which may have landed. */
  unansweredGuilds: number;
  /** Files holding appended lines whose sync the disk did not confirm. */
  unconfirmedFiles: number;
  /** Guilds pending re-save on the database written next (NB5 decision 12). */
  resaveGuilds?: number;
  /** Shared keys holding a save the database did not answer, which may have landed, with no check on the wire (NB6 C6). */
  unansweredFiles?: number;
}

/** The clauses for the counts above 0, joined by "; ". */
export function heldClauses(counts: Partial<HeldCounts>): string {
  const guilds = counts.unsavedGuilds ?? 0;
  const files = counts.unsavedFiles ?? 0;
  const unanswered = counts.unansweredGuilds ?? 0;
  const unconfirmed = counts.unconfirmedFiles ?? 0;
  const resave = counts.resaveGuilds ?? 0;
  const unansweredFiles = counts.unansweredFiles ?? 0;
  const clauses: string[] = [];
  if (guilds > 0 || files > 0) clauses.push(`${guilds} guild(s) and ${files} file(s) hold changes that could not be saved`);
  if (resave > 0) clauses.push(`${resave} guild(s) are not re-saved yet on the bot's main database; their latest changes may exist only in the bot process`);
  if (unanswered > 0) clauses.push(`${unanswered} guild(s) hold a save the database did not answer, which may have landed`);
  if (unansweredFiles > 0) clauses.push(`${unansweredFiles} file(s) hold a save the database did not answer, which may have landed`);
  if (unconfirmed > 0) clauses.push(`${unconfirmed} file(s) hold appended lines the disk did not confirm; can't confirm whether they are stored`);
  return clauses.join('; ');
}
