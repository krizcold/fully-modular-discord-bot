import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateRecognitionGuard, recognitionRefusal } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { closeGuildWrites, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

const root = process.env.DATA_DIR as string;
const marker = path.join(root, '.backend.json');
const G = '987654321098765';
const guildDir = path.join(root, G);

afterEach(() => {
  setBackendKind(null);
  fs.rmSync(marker, { force: true });
  fs.rmSync(guildDir, { recursive: true, force: true });
});

function seedGuild(): void {
  fs.mkdirSync(path.join(guildDir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'm', 'a.json'), '{"a":1}');
}

describe('the recognition guard', () => {
  it('refuses postgres with no marker while guild data lives in files', () => {
    seedGuild();
    setBackendKind('postgres');
    expect(recognitionRefusal()).toMatch(/lives in files/);
    const v = evaluateRecognitionGuard();
    expect(v.state).toBe('refused');
    expect(JSON.parse(fs.readFileSync(marker, 'utf-8')).live).toBe('file');
  });

  it('refuses file when the marker says the data lives in postgres', () => {
    fs.writeFileSync(marker, JSON.stringify({ live: 'postgres', storeId: 's', flippedAt: 1 }));
    setBackendKind('file');
    expect(recognitionRefusal()).toMatch(/lives in postgres/);
    expect(evaluateRecognitionGuard().state).toBe('refused');
  });

  it('boots postgres with no marker and no guild files, and records it', () => {
    setBackendKind('postgres');
    expect(recognitionRefusal()).toBeNull();
    expect(evaluateRecognitionGuard()).toEqual({ state: 'boot', live: 'postgres' });
    expect(JSON.parse(fs.readFileSync(marker, 'utf-8')).live).toBe('postgres');
  });

  it('boots file with guild files and no marker', () => {
    seedGuild();
    setBackendKind('file');
    expect(recognitionRefusal()).toBeNull();
  });
});

describe('closed guild writes', () => {
  it('refuses guild writes once the data layer refuses, and keeps global ones', () => {
    closeGuildWrites();
    expect(saveDataTracked('x.json', { guildId: G, category: 'm' }, { x: 1 })).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(fs.existsSync(path.join(guildDir, 'm', 'x.json'))).toBe(false);
    expect(saveDataTracked('x.json', { scope: 'global', category: 'm' } as any, { x: 1 }).outcome).not.toBe('refused');
  });
});
