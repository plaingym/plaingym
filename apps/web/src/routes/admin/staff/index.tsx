// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { useBootstrap } from '../../../app/context.js';
import { t } from '../../../lib/i18n.js';
import { Page } from '../../../components/ui/page.js';
import { LoadingState } from '../../../components/ui/states.js';
import { StaffManagement } from '../../../features/staff/management.js';

function StaffPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={t('staff/profiles:loading')}/></Page>;
  if (!bootstrap.data?.session) return null;
  return <StaffManagement roles={bootstrap.data.session.roles} passwordEnabled={bootstrap.data.login.password}/>;
}
export const Route = createFileRoute('/admin/staff/')({ component: StaffPage });
