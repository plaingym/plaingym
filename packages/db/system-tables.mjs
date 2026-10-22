// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Exhaustive system-table inventory, shared by the catalog check and lint rule.
 * access: 'gym' = a gym sees only its own rows, infrastructure uses system context;
 * 'gym-config' = a gym reads and updates its own row, only system context inserts or deletes;
 * 'system' = system context only. No context sees nothing.
 */
export const systemTables = [
  {
    "name": "gyms",
    "exportName": "gyms",
    "reason": "Hostname resolution and install configuration",
    "access": "gym-config",
    "modules": [
      "core/tenancy[^/]*",
      "areas/settings/.*",
      "cli/gyms[^/]*",
      "demo/.*",
      "areas/setup/.*",
      "areas/health/restore[^/]*",
      "cli/restore[^/]*"
    ]
  },
  {
    "name": "gym_domains",
    "exportName": "gymDomains",
    "reason": "Hostname lookup before gym context",
    "access": "gym",
    "modules": [
      "core/tenancy[^/]*",
      "areas/settings/.*",
      "cli/gyms[^/]*",
      "demo/.*",
      "areas/setup/.*"
    ]
  },
  {
    "name": "jobs",
    "exportName": "jobs",
    "reason": "Worker claims queued work before selecting gym context",
    "access": "gym",
    "modules": [
      "infra/jobs/.*"
    ]
  },
  {
    "name": "auth_user",
    "exportName": "authUser",
    "reason": "Install-wide authentication state",
    "access": "system",
    "modules": [
      "infra/auth/.*"
    ]
  },
  {
    "name": "auth_session",
    "exportName": "authSession",
    "reason": "Install-wide authentication state",
    "access": "gym",
    "modules": [
      "infra/auth/.*"
    ]
  },
  {
    "name": "auth_account",
    "exportName": "authAccount",
    "reason": "Install-wide authentication state",
    "access": "system",
    "modules": [
      "infra/auth/.*",
      "areas/health/restore[^/]*",
      "cli/restore[^/]*"
    ]
  },
  {
    "name": "auth_verification",
    "exportName": "authVerification",
    "reason": "Install-wide authentication state",
    "access": "system",
    "modules": [
      "infra/auth/.*"
    ]
  },
  {
    "name": "auth_rate_limit",
    "exportName": "authRateLimit",
    "reason": "Install-wide authentication state",
    "access": "system",
    "modules": [
      "infra/auth/.*"
    ]
  },
  {
    "name": "backup_runs",
    "exportName": "backupRuns",
    "reason": "Install-wide snapshot history",
    "access": "system",
    "modules": [
      "areas/health/backups[^/]*",
      "areas/health/restore[^/]*",
      "areas/health/status-backups[^/]*",
      "cli/restore[^/]*"
    ]
  },
  {
    "name": "stripe_events",
    "exportName": "stripeEvents",
    "reason": "Verified webhook inbox before gym dispatch",
    "access": "gym",
    "modules": [
      "areas/billing/webhooks/inbox[^/]*",
      "cli/replay[^/]*"
    ]
  }
];
