// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { staffNoticeJob, type PublicStaffNotices } from './notifications.js';
import { dropInCleanupJob, type createDropInCleanup } from './pages.cleanup.js';

let configured: PublicStaffNotices | undefined;
let cleanup: ReturnType<typeof createDropInCleanup> | undefined;
export function configureDropInCleanup(service: ReturnType<typeof createDropInCleanup> | undefined) { cleanup = service; }
/** Composition supplies the queued staff notices before the worker starts. */
export function configurePublicStaffNotices(notices: PublicStaffNotices) { configured = notices; }
export function createPublicPagesJobs(read: () => PublicStaffNotices | undefined = () => configured): readonly JobRegistration[] {
  return [{ id: staffNoticeJob, async handler(payload, context) {
    const notices = read();
    if (!notices) throw new Error('Public staff notices are not configured');
    await notices.send(payload, context);
  } }, { id: dropInCleanupJob, cron: '41 3 * * *', lane: 'batch', async handler(_payload, context) {
    if (!cleanup) throw new Error('Drop-in cleanup is not configured');
    await cleanup.run(context.gymId);
  } }];
}
export const jobs = createPublicPagesJobs();
