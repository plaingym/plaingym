// SPDX-License-Identifier: AGPL-3.0-only
/** Values are versioned encrypted envelopes. Hashes and public keys are excluded. */
export const encryptedFields = [
  { table: 'gyms', column: 'stripe_config_encrypted', secretClass: 'stripe_config' },
  { table: 'gyms', column: 'smtp_config_encrypted', secretClass: 'smtp_config' },
  { table: 'gyms', column: 's3_config_encrypted', secretClass: 's3_config' },
  { table: 'gyms', column: 'qr_key_encrypted', secretClass: 'qr_key' },
  { table: 'gyms', column: 'backup_blob_key_encrypted', secretClass: 'backup_blob_key' },
  { table: 'auth_account', column: 'access_token', secretClass: 'oauth_access_token' },
  { table: 'auth_account', column: 'refresh_token', secretClass: 'oauth_refresh_token' },
  { table: 'auth_account', column: 'id_token', secretClass: 'oauth_id_token' },
] as const;
export function encryptedFieldFor(secretClass: string) {
  const field = encryptedFields.find((entry) => entry.secretClass === secretClass);
  if (!field) throw new Error('Unregistered encrypted field class');
  return field;
}
