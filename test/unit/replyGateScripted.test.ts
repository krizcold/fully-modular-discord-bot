import fs from 'fs';
import os from 'os';
import path from 'path';
import { InteractionResponseType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

// BT-3 rows that script the store's confirm answers or the raw file layer, so they run in their own file: a held
// answer that changes while a slower confirm finishes, two answers that are not ok, and the raw paths' documents.
type Rule = { match: (ticket: { kind: string; guildId?: string }) => boolean; answer: (deadlineMs: number) => Promise<string> };
const script = vi.hoisted(() => ({ rules: [] as Rule[], refuseOnce: new Set<string>() }));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    confirmWrite: async (...args: Parameters<typeof real.confirmWrite>) => {
      const rule = script.rules.find(r => r.match(args[0] as never));
      return rule ? (rule.answer(args[1]) as never) : real.confirmWrite(...args);
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return { ...real, writeRawAtomic: (absPath: string, contents: string) => (script.refuseOnce.delete(absPath) ? false : real.writeRawAtomic(absPath, contents)) };
});

import { deleteRawAtomic, saveData, writeRawAtomic } from '../../src/bot/internalSetup/utils/dataManager';
import { flushAll as flushFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { setBackendKind } from '../helpers/backendKind';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { ACK_MS, answerWrites, truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { tokenFor } from '../helpers/fakeStore';
import { callbackType, EPHEMERAL, freshGuild, rawCommand, rig, storeGuild, textOf, tick } from '../helpers/gateRig';

/** A second postgres-routed guild on the same working set and store as the last storeGuild(). */
async function secondGuild() {
  const guildId = freshGuild();
  setBackendKind('postgres');
  expect(await getWorkingSet()!.hydrate(guildId, tokenFor())).toBe('ready');
  return { guildId, category: 'm' };
}

const forGuild = (guildId: string) => (ticket: { kind: string; guildId?: string }) => ticket.kind === 'ws' && ticket.guildId === guildId;

describe('a held answer while a slower confirm finishes', () => {
  it('a held write that lands before the verdict is sent counts as saved', async () => {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    const other = await secondGuild();
    let heldLanded = false;
    script.rules = [
      { match: forGuild(options.guildId), answer: async ms => (ms === 0 ? (heldLanded ? 'ok' : 'pending') : 'held') },
      { match: forGuild(other.guildId), answer: async () => { await tick(30); heldLanded = true; return 'ok'; } },
    ];
    try {
      await emit(rawCommand('s1'), async i => {
        saveData('x.json', options, { v: 1 });
        saveData('y.json', other, { v: 1 });
        await i.reply({ content: 'Saved!' });
      });
    } finally {
      script.rules = [];
    }
    expect(wire.map(textOf)).toEqual(['Saved!']);
  });

  it('a held write dropped meanwhile is named by what it became', async () => {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    const other = await secondGuild();
    let dropped = false;
    script.rules = [
      { match: forGuild(options.guildId), answer: async ms => (ms === 0 ? (dropped ? 'deposed' : 'pending') : 'held') },
      { match: forGuild(other.guildId), answer: async () => { await tick(30); dropped = true; return 'ok'; } },
    ];
    try {
      await emit(rawCommand('s2'), async i => {
        saveData('x.json', options, { v: 1 });
        saveData('y.json', other, { v: 1 });
        await i.reply({ content: 'Saved!' });
      });
    } finally {
      script.rules = [];
    }
    expect(wire.map(textOf)).toEqual([truthText('deposed', true)]);
  });
});

describe('two answers that are not ok', () => {
  it('the worse one names the text, whichever came first', async () => {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    const other = await secondGuild();
    script.rules = [
      { match: forGuild(options.guildId), answer: async ms => (ms === 0 ? 'pending' : 'held') },
      { match: forGuild(other.guildId), answer: async () => 'deposed' },
    ];
    try {
      await emit(rawCommand('s3'), async i => {
        saveData('x.json', options, { v: 1 });
        saveData('y.json', other, { v: 1 });
        await i.reply({ content: 'Saved!' });
      });
    } finally {
      script.rules = [];
    }
    expect(wire.map(textOf)).toEqual([truthText('deposed', false)]);
  });
});

describe('answerWrites on a command past the deadline', () => {
  it('acknowledges by an ephemeral deferral before true when the confirm is in at once, and leaves no intent raised', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    script.rules = [{ match: forGuild(options.guildId), answer: async () => 'ok' }];
    let answered: boolean | undefined;
    let flags: boolean[] = [];
    try {
      await emit(rawCommand('s7'), async i => {
        saveData('x.json', options, { v: 1 });
        vi.advanceTimersByTime(ACK_MS + 100);
        answered = await answerWrites(i);
        flags = [i.deferred, i.replied];
      });
    } finally {
      script.rules = [];
      vi.useRealTimers();
    }
    expect(answered).toBe(true);
    expect(flags).toEqual([true, false]);
    expect(wire.map(callbackType)).toEqual([InteractionResponseType.DeferredChannelMessageWithSource]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
  });
});

describe('the raw paths name their documents by file', () => {
  it('a refused raw write is not answered for by another file, and is made unconfirmable by a rewrite or delete of its own', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-raw-'));
    try {
      const [a, b, c] = ['a.json', 'b.json', 'c.json'].map(name => path.join(dir, name));
      fs.writeFileSync(c, '{}');
      const { wire, emit } = rig();
      await emit(rawCommand('s4'), async i => {
        script.refuseOnce.add(a);
        expect(writeRawAtomic(a, '{}')).toBe(false);
        expect(writeRawAtomic(b, '{}')).toBe(true);
        await i.reply({ content: 'Saved!' });
      });
      await emit(rawCommand('s5'), async i => {
        script.refuseOnce.add(a);
        expect(writeRawAtomic(a, '{}')).toBe(false);
        expect(writeRawAtomic(a, '{"v":2}')).toBe(true);
        await i.reply({ content: 'Saved!' });
      });
      await emit(rawCommand('s6'), async i => {
        script.refuseOnce.add(c);
        expect(writeRawAtomic(c, '{"v":2}')).toBe(false);
        expect(deleteRawAtomic(c)).toBe(true);
        await i.reply({ content: 'Deleted!' });
      });
      expect(wire.map(textOf)).toEqual([truthText('io', true), truthText('unavailable', true), truthText('unavailable', true)]);
    } finally {
      await flushFiles();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
