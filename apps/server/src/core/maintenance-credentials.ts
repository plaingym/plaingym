// SPDX-License-Identifier: AGPL-3.0-only
import { tenancyMode } from './tenancy.js';

/** Variables that grant the `maintenance` role, which bypasses row-level security. */
export const maintenanceVariables = ['MAINTENANCE_PASSWORD', 'MAINTENANCE_DATABASE_URL'] as const;

/**
 * In production `multi` mode the app process never holds the `maintenance` role: with it, one compromised
 * process would reach every gym despite forced row-level security. Migrations run first as a separate
 * one-shot step (`gym-app migrate`). A single-gym install keeps the role for its in-process backups and
 * restore, and local development (no `NODE_ENV=production`) shares one `.env` with `pnpm db:migrate`.
 * The error names the variable, never its value.
 */
export function assertMaintenanceCredentials(env: NodeJS.ProcessEnv = process.env): void {
  if (tenancyMode(env.TENANCY ?? 'single') !== 'multi' || env.NODE_ENV !== 'production') return;
  const present = maintenanceVariables.find((name) => env[name]);
  if (present) throw new Error(`${present} must not be set when TENANCY=multi; run migrations as a separate step (gym-app migrate)`);
}

/**
 * The restore staging directory, beside which the restore gate keeps its state. Only a single-gym app has one:
 * restore runs as the `maintenance` role and nothing reopens a closed gate without the entrypoint's resume step,
 * so in `multi` mode a `BACKUP_STAGING_DIR` set by hand is ignored and setup's restore answers that it isn't configured.
 */
export function restoreStagingDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return tenancyMode(env.TENANCY ?? 'single') === 'single' && env.BACKUP_STAGING_DIR ? env.BACKUP_STAGING_DIR : undefined;
}
