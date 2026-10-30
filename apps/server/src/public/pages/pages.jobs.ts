// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { staffNoticeJob, type PublicStaffNotices } from './notifications.js';

let configured: PublicStaffNotices | undefined;
/** Composition supplies the queued staff notices before the worker starts. */
export function configurePublicStaffNotices(notices: PublicStaffNotices) { configured = notices; }
export function createPublicPagesJobs(read: () => PublicStaffNotices | undefined = () => configured): readonly JobRegistration[] {
  return [{ id: staffNoticeJob, async handler(payload, context) {
    const notices = read();
    if (!notices) throw new Error('Public staff notices are not configured');
    await notices.send(payload, context);
  } }];
}
export const jobs = createPublicPagesJobs();
