// The module's user gate for the acting user of a panel (P1): the open, and every button, dropdown and modal.

import type { PanelContext, PanelOptions } from '../../../types/panelTypes';
import { DISCORD_EPHEMERAL_FLAG } from '../../../constants';
import { getModuleRegistry } from '../moduleRegistry';
import { getPremiumManager } from '../premiumManager';
import { isDiscordId } from '../premiumHolder';

/**
 * The userBlocked text when the acting user is below the module's user gate; null otherwise. A system panel, the
 * server's settings panels (`settings_<module>`, `settings_global_<module>`) and a user id that is not a Discord id
 * (the dev page's 'web-ui-owner') are not gated. Premium is read only for a module with a user gate, and a throw
 * lets the panel run.
 */
export function userGateText(panel: PanelOptions, context: Pick<PanelContext, 'userId'>): string | null {
  if (panel.panelScope === 'system' || panel.id.startsWith('settings_') || !isDiscordId(context.userId)) return null;
  const moduleName = (panel as any)._moduleName;
  if (typeof moduleName !== 'string' || !moduleName) return null;
  try {
    const gate = getModuleRegistry().getModule(moduleName)?.manifest?.tierRequirement?.user;
    if (!gate || typeof gate.minPriority !== 'number') return null;
    const pm = getPremiumManager();
    if (pm.hasUserFeatureAccess(context.userId, gate.minPriority)) return null;
    return pm.getMessages().userBlocked;
  } catch {
    return null;
  }
}

/**
 * On a shared (persistent) panel the refusal goes to the acting user alone, before anything defers or updates the
 * shared message. True when the user was refused.
 */
export async function refusedOnSharedPanel(panel: PanelOptions | undefined, context: PanelContext, interaction: any): Promise<boolean> {
  if (!panel?.persistent) return false;
  const text = userGateText(panel, context);
  if (text === null) return false;
  const reply = { content: text, flags: DISCORD_EPHEMERAL_FLAG };
  if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
  else await interaction.reply(reply);
  return true;
}
