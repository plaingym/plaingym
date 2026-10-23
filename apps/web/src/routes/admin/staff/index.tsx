// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { useBootstrap } from '../../../app/context.js';
import { StaffManagement } from '../../../features/staff/management.js';

function StaffPage() {
  const bootstrap = useBootstrap();
  if (!bootstrap.data?.session) return null;
  return <StaffManagement roles={bootstrap.data.session.roles} passwordEnabled={bootstrap.data.login.password}/>;
}
export const Route = createFileRoute('/admin/staff/')({ component: StaffPage });
