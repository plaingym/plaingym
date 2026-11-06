// SPDX-License-Identifier: AGPL-3.0-only
/** Provider shortcuts shared by setup and Settings. Credentials are always entered by the owner. */
export const smtpPresets = [
  ['smtp.postmarkapp.com', 'Postmark'], ['smtp-relay.brevo.com', 'Brevo'],
  ['email-smtp.us-east-1.amazonaws.com', 'Amazon SES'], ['smtp.gmail.com', 'Gmail'],
] as const;

export function downloadBackupKey(privateKey: string): void {
  const url = URL.createObjectURL(new Blob([privateKey + '\n'], { type: 'text/plain' }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'plaingym-backup-key.txt';
    anchor.click();
  } finally { URL.revokeObjectURL(url); }
}
