// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { createRegistries } from '../../../lib/registries.js';
import { t } from '../../../lib/i18n.js';
export function SettingsPage() {
  return <main className="mx-auto max-w-3xl space-y-8 p-6">
    <h1 className="text-2xl font-semibold">{t('settings/settings:title')}</h1>
    {createRegistries().settingsSections.all().filter((entry) => entry.enabled).map((entry) => {
      const Component = entry.component;
      return <section key={entry.id} aria-label={t(entry.labelKey)}><Component/></section>;
    })}
  </main>;
}
export const Route = createFileRoute('/admin/settings/')({ component: SettingsPage });
