import fs from 'fs';
import path from 'path';
import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../../src/cli/client';

// B03-1 (R1-J23, R9-J8): smdb bundle refuses a postgres-routed guild or a running bot, the export lands whole or not
// at all, and the import stages, verifies and swaps so a bad bundle never touches the live guild dir.
import * as di from '../../src/bot/internalSetup/utils/dataInterchange';
import { setBackendKind } from '../helpers/backendKind';

const root = process.env.DATA_DIR as string;
const G = '111222333';
const guildDir = path.join(root, G);
const out = path.join(root, 'out', 'b.dbex');
const api = di as any;

function seed(files: Record<string, string>): void {
  fs.rmSync(guildDir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(guildDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(guildDir, rel), body);
  }
}

function tree(dir: string): Record<string, string> {
  const res: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else res[r] = fs.readFileSync(path.join(dir, r), 'utf-8');
    }
  };
  walk('');
  return res;
}

afterEach(() => {
  setBackendKind(null);
  fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
  fs.rmSync(path.join(root, '_graveyard'), { recursive: true, force: true });
});

describe('the bundle refusal', () => {
  it('refuses a postgres-routed guild and names why', () => {
    setBackendKind('postgres');
    expect(api.bundleRefusal(G, 'no')).toMatch(/postgres/);
  });

  it('refuses while the bot answers, and when that cannot be confirmed', () => {
    expect(api.bundleRefusal(G, 'yes')).toMatch(/running/);
    expect(api.bundleRefusal(G, 'unknown')).toMatch(/confirm/);
  });

  it('refuses a guild id that is not a guild dir name', () => {
    expect(api.bundleRefusal('../x', 'no')).toMatch(/guild id/);
  });

  it('serves by the marker when one exists, not by DATA_BACKEND', () => {
    const marker = path.join(root, '.backend.json');
    setBackendKind('postgres');
    fs.writeFileSync(marker, JSON.stringify({ live: 'file', storeId: null, flippedAt: 1}));
    try {
      expect(api.bundleRefusal(G, 'no')).toBeNull();
      fs.writeFileSync(marker, JSON.stringify({ live: 'postgres', storeId: 's', flippedAt: 1}));
      expect(api.bundleRefusal(G, 'no')).toMatch(/postgres/);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });

  it('lets a file-routed guild with the bot stopped through', () => {
    expect(api.bundleRefusal(G, 'no')).toBeNull();
  });
});

describe('the export', () => {
  it('writes a verified bundle and leaves no partial file', async () => {
    seed({ 'a.json': '{"a":1}', 'sub/b.json': '{"b":2}' });
    const summary = await di.writeBundle(G, out);
    expect(summary.fileCount).toBe(2);
    expect(fs.readdirSync(path.dirname(out))).toEqual(['b.dbex']);
  });

  it('refuses a guild with no data dir and writes nothing', async () => {
    fs.rmSync(guildDir, { recursive: true, force: true });
    await expect(di.writeBundle(G, out)).rejects.toThrow(/no data/);
    expect(fs.existsSync(path.dirname(out)) ? fs.readdirSync(path.dirname(out)) : []).toEqual([]);
  });

  it('keeps an existing file at the target when the export fails after writing began', async () => {
    seed({ 'a.json': '{"a":1}', 'b.json': '{"b":2}' });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'previous');
    const real = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, mode?: any) => {
      if (mode === 'r' && String(p).endsWith('.dbex.partial')) throw new Error('read-back failed');
      if (mode === 'r' && path.resolve(String(p)) === path.resolve(out)) throw new Error('read-back failed');
      return real(p, mode);
    });
    try {
      await expect(di.writeBundle(G, out)).rejects.toThrow(/read-back failed/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(out, 'utf-8')).toBe('previous');
    expect(fs.readdirSync(path.dirname(out))).toEqual(['b.dbex']);
  });
});

describe('the import', () => {
  it('replaces the live dir with exactly the bundle and graveyards the old copy', async () => {
    seed({ 'a.json': 'new-a', 'sub/b.json': 'new-b' });
    await di.writeBundle(G, out);
    seed({ 'a.json': 'old-a', 'stale.json': 'old' });
    const res = await api.importBundle(out);
    expect(res).toMatchObject({ guildId: G, fileCount: 2 });
    expect(tree(guildDir)).toEqual({ 'a.json': 'new-a', 'sub/b.json': 'new-b' });
    const graves = fs.readdirSync(path.join(root, '_graveyard'));
    expect(graves).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, '_graveyard', graves[0], 'stale.json'), 'utf-8')).toBe('old');
    expect(fs.readdirSync(root).filter(n => n.startsWith('.bundle-import'))).toEqual([]);
  });

  it('a corrupt bundle leaves the live dir untouched', async () => {
    seed({ 'a.json': 'aaaa', 'b.json': 'bbbb' });
    await di.writeBundle(G, out);
    const buf = fs.readFileSync(out);
    const at = buf.lastIndexOf(Buffer.from('bbbb'));
    buf[at] = 'x'.charCodeAt(0);
    fs.writeFileSync(out, buf);
    seed({ 'a.json': 'live' });
    await expect(api.importBundle(out)).rejects.toThrow();
    expect(tree(guildDir)).toEqual({ 'a.json': 'live' });
    expect(fs.readdirSync(root).filter(n => n.startsWith('.bundle-import'))).toEqual([]);
  });

  it('a truncated bundle (no summary) leaves the live dir untouched', async () => {
    seed({ 'a.json': 'aaaa' });
    await di.writeBundle(G, out);
    const buf = fs.readFileSync(out);
    fs.writeFileSync(out, buf.subarray(0, buf.lastIndexOf(Buffer.from('{"t"')) - 4));
    seed({ 'a.json': 'live' });
    await expect(api.importBundle(out)).rejects.toThrow();
    expect(tree(guildDir)).toEqual({ 'a.json': 'live' });
  });

  it('refuses a bundle whose guild id is not a guild dir name', async () => {
    seed({ 'a.json': 'aaaa' });
    await di.writeBundle(G, out);
    const buf = fs.readFileSync(out);
    const s = buf.toString('latin1').replace(`"g":"${G}"`, '"g":"../evil"');
    const fixed = Buffer.from(s, 'latin1');
    fixed.writeUInt32BE(fixed.readUInt32BE(6) + ('../evil'.length - G.length), 6);
    fs.writeFileSync(out, fixed);
    await expect(api.importBundle(out)).rejects.toThrow(/guild id/);
    expect(fs.existsSync(path.join(root, '..', 'evil'))).toBe(false);
  });

  it('imports into a guild with no live dir', async () => {
    seed({ 'a.json': 'aaaa' });
    await di.writeBundle(G, out);
    fs.rmSync(guildDir, { recursive: true, force: true });
    await api.importBundle(out);
    expect(tree(guildDir)).toEqual({ 'a.json': 'aaaa' });
  });
});

describe('the running-bot probe', () => {
  async function probe(status: number, body: string): Promise<string> {
    const server = http.createServer((req, res) => {
      if (req.url !== '/api/bot/status') return res.writeHead(200).end('<html>panel</html>');
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      return await new Client({ host: '127.0.0.1', port }).botAnswers();
    } finally {
      await new Promise(r => server.close(r));
    }
  }

  it('asks the panel for the bot child, not whether the panel answers', async () => {
    expect(await probe(200, JSON.stringify({ success: true, status: { running: false } }))).toBe('no');
    expect(await probe(200, JSON.stringify({ success: true, status: { running: true } }))).toBe('yes');
  });

  it('nothing listening on the port is unknown, never stopped', async () => {
    const server = http.createServer();
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    await new Promise(r => server.close(r));
    expect(await new Client({ host: '127.0.0.1', port }).botAnswers()).toBe('unknown');
  });

  it('any other reply is unknown', async () => {
    expect(await probe(401, '{"error":"auth"}')).toBe('unknown');
    expect(await probe(200, 'not json')).toBe('unknown');
  });
});

describe('a failed first rename of the live dir', () => {
  it('says the live dir was not touched', async () => {
    seed({ 'a.json': 'new' });
    await di.writeBundle(G, out);
    seed({ 'a.json': 'old' });
    const real = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(from)) === path.resolve(guildDir)) throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' });
      return real(from, to);
    });
    try {
      await expect(api.importBundle(out)).rejects.toThrow(/live guild dir was not touched/);
    } finally {
      spy.mockRestore();
    }
    expect(tree(guildDir)).toEqual({ 'a.json': 'old' });
  });
});
