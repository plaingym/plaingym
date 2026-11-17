// SPDX-License-Identifier: AGPL-3.0-only
const basic = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const extension = new Set(Array.from('\f^{}\\[~]|€'));
export const announcementStopLine = 'Reply STOP to opt out';
export function announcementSmsBody(gymName: string, body: string): string {
  return `${gymName}: ${body.trim()}\n${announcementStopLine}`;
}
/** GSM extension characters consume two septets; Unicode messages consume UTF-16 code units. */
export function smsSegments(body: string) {
  let units = 0, gsm = true;
  for (const character of body) {
    if (basic.has(character)) units++;
    else if (extension.has(character)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) units = body.length;
  const single = gsm ? 160 : 70, concatenated = gsm ? 153 : 67;
  let segments = units ? 1 : 0;
  if (units > single) {
    let used = 0;
    for (const character of body) {
      const width = gsm ? extension.has(character) ? 2 : 1 : character.length;
      if (used + width > concatenated) { segments++; used = 0; }
      used += width;
    }
  }
  return { encoding: gsm ? 'GSM-7' as const : 'UCS-2' as const, units,
    segments };
}
