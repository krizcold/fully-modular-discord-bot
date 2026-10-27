export function discordTimestamp(dateInput: string | number | Date | undefined | null): string | null {
  if (dateInput == null || dateInput === '') return null;
  const ms = new Date(dateInput).getTime();
  if (isNaN(ms)) return null;
  const unix = Math.floor(ms / 1000);
  return `<t:${unix}:f> (<t:${unix}:R>)`;
}
