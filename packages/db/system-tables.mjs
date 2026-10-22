// SPDX-License-Identifier: AGPL-3.0-only
/** Exhaustive system-table inventory, shared by the catalog check and lint rule. */
export const systemTables = [
  {
    "name": "gyms",
    "exportName": "gyms",
    "reason": "Hostname resolution and install configuration",
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
    "modules": [
      "infra/jobs/.*"
    ]
  },
  {
    "name": "auth_user",
    "exportName": "authUser",
    "reason": "Install-wide authentication state",
    "modules": [
      "infra/auth/.*"
    ]
  },
  {
    "name": "auth_session",
    "exportName": "authSession",
    "reason": "Install-wide authentication state",
    "modules": [
      "infra/auth/.*"
    ]
  },
  {
    "name": "auth_account",
    "exportName": "authAccount",
    "reason": "Install-wide authentication state",
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
    "modules": [
      "infra/auth/.*"
    ]
  },
  {
    "name": "auth_rate_limit",
    "exportName": "authRateLimit",
    "reason": "Install-wide authentication state",
    "modules": [
      "infra/auth/.*"
    ]
  },
  {
    "name": "backup_runs",
    "exportName": "backupRuns",
    "reason": "Install-wide snapshot history",
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
    "modules": [
      "areas/billing/webhooks/inbox[^/]*",
      "cli/replay[^/]*"
    ]
  }
];
