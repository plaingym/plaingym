// SPDX-License-Identifier: AGPL-3.0-only
import { routes as demoRoutes } from '../demo/demo.routes.js';
import { jobs as demoJobs } from '../demo/demo.jobs.js';
import { templates as demoEmails } from '../emails/demo/demo.js';
import type { ServerContributions } from './registry.js';
import { routes as settingsRoutes } from '../areas/settings/routes.js';
import { jobs as settingsJobs } from '../areas/settings/jobs.js';
import { routes as staffRoutes } from '../areas/staff/routes.js';
import { jobs as staffJobs } from '../areas/staff/jobs.js';
import { routes as membersRoutes } from '../areas/members/routes.js';
import { jobs as membersJobs } from '../areas/members/jobs.js';
import { routes as ranksRoutes } from '../areas/ranks/routes.js';
import { jobs as ranksJobs } from '../areas/ranks/jobs.js';
import { routes as scheduleRoutes } from '../areas/schedule/routes.js';
import { jobs as scheduleJobs } from '../areas/schedule/jobs.js';
import { routes as bookingsRoutes } from '../areas/bookings/routes.js';
import { jobs as bookingsJobs } from '../areas/bookings/jobs.js';
import { routes as attendanceRoutes } from '../areas/attendance/routes.js';
import { jobs as attendanceJobs } from '../areas/attendance/jobs.js';
import { routes as kioskRoutes } from '../areas/kiosk/routes.js';
import { jobs as kioskJobs } from '../areas/kiosk/jobs.js';
import { routes as portalRoutes } from '../areas/portal/routes.js';
import { jobs as portalJobs } from '../areas/portal/jobs.js';
import { routes as importsRoutes } from '../areas/imports/routes.js';
import { jobs as importsJobs } from '../areas/imports/jobs.js';
import { routes as billingRoutes } from '../areas/billing/routes.js';
import { jobs as billingJobs } from '../areas/billing/jobs.js';
import { routes as waiversRoutes } from '../areas/waivers/routes.js';
import { jobs as waiversJobs } from '../areas/waivers/jobs.js';
import { routes as linksRoutes } from '../areas/links/routes.js';
import { jobs as linksJobs } from '../areas/links/jobs.js';
import { routes as dashboardRoutes } from '../areas/dashboard/routes.js';
import { jobs as dashboardJobs } from '../areas/dashboard/jobs.js';
import { routes as healthRoutes } from '../areas/health/routes.js';
import { jobs as healthJobs } from '../areas/health/jobs.js';
import { routes as setupRoutes } from '../areas/setup/routes.js';
import { jobs as setupJobs } from '../areas/setup/jobs.js';
import { routes as publicRoutes } from '../areas/public/routes.js';
import { jobs as publicJobs } from '../areas/public/jobs.js';
import { templates as email0 } from '../emails/settings/settings.js';
import { templates as email1 } from '../emails/settings/gym-delete.js';
import { templates as email2 } from '../emails/settings/go-live.js';
import { templates as email3 } from '../emails/staff/auth.js';
import { templates as email4 } from '../emails/staff/profiles.js';
import { templates as email5 } from '../emails/members/members.js';
import { templates as email6 } from '../emails/members/checkin-code.js';
import { templates as email7 } from '../emails/ranks/ranks.js';
import { templates as email8 } from '../emails/ranks/packs.js';
import { templates as email9 } from '../emails/schedule/schedule.js';
import { templates as email10 } from '../emails/bookings/bookings.js';
import { templates as email11 } from '../emails/attendance/attendance.js';
import { templates as email12 } from '../emails/kiosk/devices.js';
import { templates as email13 } from '../emails/kiosk/standing.js';
import { templates as email14 } from '../emails/kiosk/qr.js';
import { templates as email15 } from '../emails/portal/auth.js';
import { templates as email16 } from '../emails/portal/access.js';
import { templates as email17 } from '../emails/portal/bookings.js';
import { templates as email18 } from '../emails/portal/schedule.js';
import { templates as email19 } from '../emails/portal/checkin.js';
import { templates as email20 } from '../emails/portal/progress.js';
import { templates as email21 } from '../emails/portal/billing.js';
import { templates as email22 } from '../emails/portal/waivers.js';
import { templates as email23 } from '../emails/portal/household.js';
import { templates as email24 } from '../emails/imports/pipeline.js';
import { templates as email25 } from '../emails/imports/export.js';
import { templates as email26 } from '../emails/imports/people.js';
import { templates as email27 } from '../emails/imports/mat.js';
import { templates as email28 } from '../emails/imports/memberships.js';
import { templates as email29 } from '../emails/billing/catalog.js';
import { templates as email30 } from '../emails/billing/memberships.js';
import { templates as email31 } from '../emails/billing/invoicing.js';
import { templates as email32 } from '../emails/billing/inbox.js';
import { templates as email33 } from '../emails/billing/transitions.js';
import { templates as email34 } from '../emails/billing/runner.js';
import { templates as email35 } from '../emails/billing/handlers.js';
import { templates as email36 } from '../emails/billing/payments.js';
import { templates as email37 } from '../emails/billing/alerts.js';
import { templates as email38 } from '../emails/billing/kiosk-standing.js';
import { templates as email39 } from '../emails/waivers/waivers.js';
import { templates as email40 } from '../emails/links/service.js';
import { templates as email41 } from '../emails/links/campaigns.js';
import { templates as email42 } from '../emails/dashboard/dashboard.js';
import { templates as email43 } from '../emails/dashboard/billing.js';
import { templates as email44 } from '../emails/health/backups.js';
import { templates as email45 } from '../emails/health/restore.js';
import { templates as email46 } from '../emails/health/status.js';
import { templates as email47 } from '../emails/health/stripe.js';
import { templates as email48 } from '../emails/health/charge-run.js';
import { templates as email49 } from '../emails/health/auto-update.js';
import { templates as email50 } from '../emails/health/updates.js';
import { templates as email51 } from '../emails/setup/setup.js';
import { templates as email52 } from '../emails/setup/import-step.js';
import { templates as email53 } from '../emails/setup/stripe-step.js';
import { templates as email54 } from '../emails/public/pages.js';
import { templates as email55 } from '../emails/public/join.js';
import { templates as email56 } from '../emails/public/links.js';

export const areaContributions = {
  routes: [
    ...demoRoutes,
    ...settingsRoutes,
    ...staffRoutes,
    ...membersRoutes,
    ...ranksRoutes,
    ...scheduleRoutes,
    ...bookingsRoutes,
    ...attendanceRoutes,
    ...kioskRoutes,
    ...portalRoutes,
    ...importsRoutes,
    ...billingRoutes,
    ...waiversRoutes,
    ...linksRoutes,
    ...dashboardRoutes,
    ...healthRoutes,
    ...setupRoutes,
    ...publicRoutes,
  ],
  jobs: [
    ...demoJobs,
    ...settingsJobs,
    ...staffJobs,
    ...membersJobs,
    ...ranksJobs,
    ...scheduleJobs,
    ...bookingsJobs,
    ...attendanceJobs,
    ...kioskJobs,
    ...portalJobs,
    ...importsJobs,
    ...billingJobs,
    ...waiversJobs,
    ...linksJobs,
    ...dashboardJobs,
    ...healthJobs,
    ...setupJobs,
    ...publicJobs,
  ],
  emails: [
    ...demoEmails,
    ...email0,
    ...email1,
    ...email2,
    ...email3,
    ...email4,
    ...email5,
    ...email6,
    ...email7,
    ...email8,
    ...email9,
    ...email10,
    ...email11,
    ...email12,
    ...email13,
    ...email14,
    ...email15,
    ...email16,
    ...email17,
    ...email18,
    ...email19,
    ...email20,
    ...email21,
    ...email22,
    ...email23,
    ...email24,
    ...email25,
    ...email26,
    ...email27,
    ...email28,
    ...email29,
    ...email30,
    ...email31,
    ...email32,
    ...email33,
    ...email34,
    ...email35,
    ...email36,
    ...email37,
    ...email38,
    ...email39,
    ...email40,
    ...email41,
    ...email42,
    ...email43,
    ...email44,
    ...email45,
    ...email46,
    ...email47,
    ...email48,
    ...email49,
    ...email50,
    ...email51,
    ...email52,
    ...email53,
    ...email54,
    ...email55,
    ...email56,
  ],
} satisfies ServerContributions;
