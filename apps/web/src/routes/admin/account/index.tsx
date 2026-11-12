// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { useBootstrap } from '../../../app/context.js';
import { t } from '../../../lib/i18n.js';
import { Page } from '../../../components/ui/page.js';
import { LoadingState } from '../../../components/ui/states.js';
import { AccountPage } from '../../../features/account/page.js';

function AdminAccountPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={t('auth/account:loading')}/></Page>;
  if (!bootstrap.data?.session) return null;
  return <AccountPage login={bootstrap.data.login} userId={bootstrap.data.session.userId}/>;
}
export const Route = createFileRoute('/admin/account/')({ component: AdminAccountPage });
