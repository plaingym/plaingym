// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { canStaff } from '@plaingym/shared';
import { useBootstrap } from '../../../app/context.js';
import { createRegistries, type SettingsSection } from '../../../lib/registries.js';
import { t } from '../../../lib/i18n.js';
import { Page, PageHeader } from '../../../components/ui/page.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { orderSettingsSections, SettingsSectionMenu } from '../../../features/settings/section-menu.js';
const alwaysListed = () => true;
function Section({ entry }: { entry: SettingsSection }) {
  const useListed = entry.listed ?? alwaysListed;
  const listed = useListed();
  if (!listed) return null;
  const Component = entry.component;
  return <section id={entry.id} tabIndex={-1} aria-label={t(entry.labelKey)} className="min-w-0 scroll-mt-4 rounded-xl border border-border bg-card p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:p-6"><Component/></section>;
}
export function SettingsPage() {
  const bootstrap = useBootstrap();
  const roles = bootstrap.data?.session?.roles ?? [], modules = new Set(bootstrap.data?.gym.enabledModules ?? []);
  if (bootstrap.isPending) return <Page><LoadingState label={t('settings/settings:loading')}/></Page>;
  if (bootstrap.isError) return <Page><ErrorState message={t('settings/settings:error')} onRetry={() => void bootstrap.refetch()}/></Page>;
  // Presentation only: each section's API enforces its own permission.
  const sections = orderSettingsSections(createRegistries().settingsSections.forModules(modules)
    .filter((entry) => entry.enabled && entry.permission.kind === 'staff' && canStaff(roles, entry.permission.capability)));
  return <Page className="max-w-3xl">
    <PageHeader title={t('settings/settings:title')}/>
    <SettingsSectionMenu sections={sections}/>
    <div className="space-y-6">
      {/* Only rendered sections count: a hook returning false contributes no sibling. First, so it never takes the last-child slot from a section. */}
      <div className="hidden only:block"><EmptyState title={t('settings/settings:noSections')} description={t('settings/settings:noSectionsHelp')}/></div>
      {sections.map((entry) => <Section key={entry.id} entry={entry}/>)}
    </div>
  </Page>;
}
export const Route = createFileRoute('/admin/settings/')({ component: SettingsPage });
