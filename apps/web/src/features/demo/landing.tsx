// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../../lib/i18n.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { Card } from '../../components/ui/card.js';
import { useDemoMode } from './notice.js';

export function DemoPage() {
  const entry = useDemoMode() === 'entry';
  return <main id="main-content" className="flex-1 p-4 sm:p-6">
    <Page className="max-w-4xl">
      <PageHeader title={t(entry ? 'demo/demo:rolesTitle' : 'demo/demo:inactiveTitle')}
        {...(!entry ? { description: t('demo/demo:inactiveHelp') } : {})} />
      {entry ? <><div className="grid gap-4 md:grid-cols-3">{(['owner', 'coach', 'student'] as const).map((role) => <Card key={role} className="p-4 sm:p-6">
        <PageSection title={t(`demo/demo:${role}Label`)}><p>{t(`demo/demo:${role}Help`)}</p></PageSection>
      </Card>)}</div><p className="text-sm text-muted-foreground">{t('demo/demo:banner')}</p></>
      : <a className="inline-flex min-h-11 items-center underline" href="/login">{t('demo/demo:signIn')}</a>}
    </Page>
  </main>;
}
