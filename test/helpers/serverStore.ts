import type { FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { FakeStore, tokenFor } from './fakeStore';

// About a third of an 8 KiB page: past it Postgres refuses a btree index row with 54000.
export const INDEX_ROW_MAX = 2700;

/**
 * FakeStore emulating the server's answers to a flush: U+0000 in a text or key fails 22021, a null doc 23502, a key
 * past the btree index's row limit 54000, and text goes through UTF-8 (a lone surrogate becomes U+FFFD).
 */
export class ServerStore extends FakeStore {
  async flushGuild(guildId: string, batch: GuildFlushBatch, token: ReturnType<typeof tokenFor>): Promise<FlushOutcome> {
    for (const u of batch.upserts) if (typeof u.doc !== 'string') return { ok: false, reason: 'unavailable', code: '23502' };
    const keys = [...batch.upserts.map(u => u.key), ...batch.appends.map(a => a.key), ...batch.deletes];
    if (keys.some(k => Buffer.byteLength(k.module + k.filename, 'utf8') > INDEX_ROW_MAX)) return { ok: false, reason: 'unavailable', code: '54000' };
    const texts = [...batch.upserts.map(u => u.doc), ...batch.appends.map(a => a.chunk), ...keys.flatMap(k => [k.module, k.filename])];
    if (texts.some(t => typeof t !== 'string' || t.includes('\u0000'))) return { ok: false, reason: 'unavailable', code: '22021' };
    const utf8 = (s: string) => Buffer.from(s, 'utf8').toString('utf8');
    return super.flushGuild(guildId, {
      upserts: batch.upserts.map(u => ({ key: { module: utf8(u.key.module), filename: utf8(u.key.filename) }, doc: utf8(u.doc) })),
      deletes: batch.deletes.map(k => ({ module: utf8(k.module), filename: utf8(k.filename) })),
      appends: batch.appends.map(a => ({ key: { module: utf8(a.key.module), filename: utf8(a.key.filename) }, chunk: utf8(a.chunk) })),
    }, token);
  }
}
