import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { KEPT, scrubbed, scrubEnv } from '../helpers/env';

// The env scrub (helpers/env.ts) against what src reads: every key it reads
// from process.env, and every uppercase prefix it checks keys against (how
// envLoader copies the payment providers' keys), must be scrubbed or kept on
// purpose, so a new configuration key cannot reach tests unnoticed.

const src = path.join(__dirname, '..', '..', 'src');
const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : /\.(ts|js|cjs|mjs)$/.test(entry.name) ? [path.join(dir, entry.name)] : []);

describe('the env scrub', () => {
  const texts = filesUnder(src).map(file => fs.readFileSync(file, 'utf8'));
  const found = (pattern: RegExp) => [...new Set(texts.flatMap(text => [...text.matchAll(pattern)].map(m => m[1] ?? m[2])))].sort();

  it('covers every key src reads from process.env', () => {
    const keys = found(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g);
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter(key => !scrubbed(key) && !KEPT.includes(key))).toEqual([]);
  });

  it('covers every uppercase prefix src checks keys against', () => {
    const prefixes = found(/startsWith\(\s*['"]([A-Z][A-Z0-9]*_)['"]\s*\)/g);
    expect(prefixes).toEqual(expect.arrayContaining(['PATREON_', 'PAYPAL_', 'STRIPE_']));
    expect(prefixes.filter(prefix => !scrubbed(`${prefix}ANY`))).toEqual([]);
  });

  it('takes those keys out and leaves the rest, the active mutant included', () => {
    const env = scrubEnv({ DISCORD_TOKEN: 't', STRIPE_SECRET_KEY: 's', SESSION_SECRET: 'x', FLEET_CONFIRM_TAKEOVER: '1', DATA_BACKEND_URL: 'u', PATH: 'p', __STRYKER_ACTIVE_MUTANT__: '7', NODE_ENV: 'test' });
    expect(env).toEqual({ PATH: 'p', __STRYKER_ACTIVE_MUTANT__: '7', NODE_ENV: 'test' });
  });
});
