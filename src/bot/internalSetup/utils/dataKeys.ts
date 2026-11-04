import * as path from 'path';

export class GuildKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuildKeyError';
  }
}

export interface GuildKey {
  module: string;
  filename: string;
}

/**
 * The one form of a guild key: category and filename joined with '/', normalized, then split at the first '/' (one
 * segment gives module ''). Throws GuildKeyError for a key that is empty, starts with '/', holds a backslash, ends in
 * '/' or leaves the guild folder.
 */
export function canonicalGuildKey(category: string | null | undefined, filename: string): GuildKey {
  const joined = category ? `${category}/${filename}` : filename;
  if (joined === '') throw new GuildKeyError('[Data] An empty guild key is refused');
  if (joined.startsWith('/')) throw new GuildKeyError(`[Data] The guild key "${joined}" starts with "/"; refused`);
  if (joined.includes('\\')) throw new GuildKeyError(`[Data] The guild key "${joined}" holds a backslash; refused`);
  if (joined.endsWith('/')) throw new GuildKeyError(`[Data] The guild key "${joined}" ends in "/"; refused`);
  const normal = path.posix.normalize(joined);
  if (normal === '.' || normal === '..' || normal.startsWith('../')) {
    throw new GuildKeyError(`[Data] The guild key "${joined}" leaves the guild folder; refused`);
  }
  const slash = normal.indexOf('/');
  return slash < 0 ? { module: '', filename: normal } : { module: normal.slice(0, slash), filename: normal.slice(slash + 1) };
}

export function isCanonicalGuildKey(module: string, filename: string): boolean {
  try {
    const c = canonicalGuildKey(module, filename);
    return c.module === module && c.filename === filename;
  } catch {
    return false;
  }
}
