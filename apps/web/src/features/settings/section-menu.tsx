// SPDX-License-Identifier: AGPL-3.0-only
import type { SettingsSection } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';

const order = ['settingsSections.settings.general', 'settingsSections.settings.billing', 'settingsSections.settings.drop-in',
  'settingsSections.settings.integrations', 'settingsSections.settings.auth', 'settingsSections.website',
  'settingsSections.kiosk.devices', 'settingsSections.settings.updates', 'settingsSections.settings.go-live'];
export function orderSettingsSections(sections: SettingsSection[]) {
  const position = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
  return [...sections].sort((a, b) => position(a.id) - position(b.id));
}
const alwaysListed = () => true;
function SectionLink({ entry }: { entry: SettingsSection }) {
  const useListed = entry.listed ?? alwaysListed;
  if (!useListed()) return null;
  return <a href={'#' + entry.id} className="inline-flex min-h-11 min-w-0 items-center rounded-md px-3 py-2 text-sm underline underline-offset-4 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]">{t(entry.labelKey)}</a>;
}
export function SettingsSectionMenu({ sections }: { sections: SettingsSection[] }) {
  return <nav aria-label={t('settings/settings:sections')} className="hidden flex-wrap gap-1 rounded-xl border border-border p-2 has-[a]:flex">
    {sections.map((entry) => <SectionLink key={entry.id} entry={entry}/>)}
  </nav>;
}
