// The panel dispatchers' custom-id rules, kept free of the panel graph so the reply gate's sweep can name a panel.

/**
 * Parse panel button customId: panel_{panelId}_btn_{buttonId}
 */
export function parseButtonCustomId(customId: string): { panelId: string; buttonId: string } | null {
  const parts = customId.split('_');
  if (parts.length < 4 || parts[0] !== 'panel') {
    console.log(`[PanelButtonHandler] Invalid panel button format: ${customId}`);
    return null;
  }

  const btnIndex = parts.indexOf('btn');
  if (btnIndex === -1 || btnIndex === parts.length - 1) {
    console.log(`[PanelButtonHandler] No 'btn' found or no button ID after 'btn': ${customId}`);
    return null;
  }

  const panelId = parts.slice(1, btnIndex).join('_');
  const buttonId = parts.slice(btnIndex + 1).join('_');

  return { panelId, buttonId };
}

/**
 * Parse panel dropdown customId: panel_{panelId}_dropdown_{dropdownId}
 */
export function parseDropdownCustomId(customId: string): { panelId: string; dropdownId: string } | null {
  const parts = customId.split('_');
  if (parts.length < 4 || parts[0] !== 'panel') {
    console.log(`[PanelDropdownHandler] Invalid panel dropdown format: ${customId}`);
    return null;
  }

  // Find the 'dropdown' part in the array
  const dropdownIndex = parts.indexOf('dropdown');
  if (dropdownIndex === -1 || dropdownIndex === parts.length - 1) {
    console.log(`[PanelDropdownHandler] No 'dropdown' found or no dropdown ID after 'dropdown': ${customId}`);
    return null;
  }

  // Everything between 'panel' and 'dropdown' is the panel ID
  const panelId = parts.slice(1, dropdownIndex).join('_');
  // Everything after 'dropdown' is the dropdown ID
  const dropdownId = parts.slice(dropdownIndex + 1).join('_');

  return { panelId, dropdownId };
}

/**
 * Parse panel modal customId: panel_{panelId}_modal_{modalId}
 */
export function parseModalCustomId(customId: string): { panelId: string; modalId: string } | null {
  const parts = customId.split('_');
  if (parts.length < 4 || parts[0] !== 'panel') {
    console.log(`[PanelModalHandler] Invalid panel modal format: ${customId}`);
    return null;
  }

  // Find the 'modal' part in the array
  const modalIndex = parts.indexOf('modal');
  if (modalIndex === -1 || modalIndex === parts.length - 1) {
    console.log(`[PanelModalHandler] No 'modal' found or no modal ID after 'modal': ${customId}`);
    return null;
  }

  // Everything between 'panel' and 'modal' is the panel ID
  const panelId = parts.slice(1, modalIndex).join('_');
  // Everything after 'modal' is the modal ID
  const modalId = parts.slice(modalIndex + 1).join('_');

  return { panelId, modalId };
}
