import vm from 'vm';
import { transformSync } from '@babel/core';
import presetReact from '@babel/preset-react';
import { describe, expect, it } from 'vitest';
import { readSourceText } from '../helpers/sourceText';

// NB6 test 49's install job rows (decision 61; part 26): the App Store tab shows the answer a job carries in `message`
// (T7, T8, T9, T18, T30, T37) in place of its own install text; a job without one keeps today's texts.

function panel(): Record<string, any> {
  const code = transformSync(readSourceText(__dirname, '../../src/webui/public/components/AppStorePanel.jsx'), {
    presets: [[presetReact, { runtime: 'classic' }]], babelrc: false, configFile: false,
  })!.code!;
  const ctx: Record<string, any> = { React: { useState: () => [], useEffect: () => {}, useRef: () => ({}) }, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

describe("the install toast of a job that carries the bot's answer", () => {
  it('shows the message, as a warning when the module did not load', () => {
    const text = "m 1.0.0 was installed. This machine's bot is not running, so it applies the module when it next starts normally.";
    expect(panel().appStoreInstallToast({ moduleName: 'm', loaded: false, message: text })).toEqual({ text, kind: 'warning' });
  });

  it('a job without one keeps the install text (guard)', () => {
    expect(panel().appStoreInstallToast({ moduleName: 'm', loaded: true })).toEqual({ text: 'm installed.', kind: 'success' });
  });
});
