// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { canStaff } from '@plaingym/shared';
import { useBootstrap } from '../../../app/context.js';
import { createRegistries } from '../../../lib/registries.js';
import { t } from '../../../lib/i18n.js';
import { Page, PageHeader } from '../../../components/ui/page.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
export function SettingsPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={t('settings/settings:loading')}/></Page>;
  if (bootstrap.isError) return <Page><ErrorState message={t('settings/settings:error')} onRetry={() => void bootstrap.refetch()}/></Page>;
  const roles = bootstrap.data?.session?.roles ?? [], modules = new Set(bootstrap.data?.gym.enabledModules ?? []);
  // Presentation only: each section's API enforces its own permission.
  const sections = createRegistries().settingsSections.forModules(modules)
    .filter((entry) => entry.enabled && entry.permission.kind === 'staff' && canStaff(roles, entry.permission.capability));
  return <Page className="max-w-3xl">
    <PageHeader title={t('settings/settings:title')}/>
    {!sections.length && <EmptyState title={t('settings/settings:noSections')} description={t('settings/settings:noSectionsHelp')}/>}
    {sections.map((entry) => {
      const Component = entry.component;
      return <section key={entry.id} aria-label={t(entry.labelKey)} className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6"><Component/></section>;
    })}
  </Page>;
}
export const Route = createFileRoute('/admin/settings/')({ component: SettingsPage });
