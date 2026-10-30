// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../../lib/i18n.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { useDemoLogin, useDemoMode } from './notice.js';

const roles = ['owner', 'coach', 'student'] as const;
/** Stripe's documented test card; sandboxes only ever use the shared test-mode account. */
export const demoTestCard = '4242 4242 4242 4242';
const link = 'inline-flex min-h-11 items-center underline';

export function DemoPage() {
  const mode = useDemoMode(), entry = mode === 'entry';
  if (mode === 'sandbox') return <SandboxLanding />;
  return <main id="main-content" className="flex-1 p-4 sm:p-6">
    <Page className="max-w-4xl">
      <PageHeader title={t(entry ? 'demo/demo:rolesTitle' : 'demo/demo:inactiveTitle')}
        {...(!entry ? { description: t('demo/demo:inactiveHelp') } : {})} />
      {entry ? <><div className="grid gap-4 md:grid-cols-3">{roles.map((role) => <Card key={role} className="p-4 sm:p-6">
        <PageSection title={t(`demo/demo:${role}Label`)}><p>{t(`demo/demo:${role}Help`)}</p></PageSection>
      </Card>)}</div><p className="text-sm text-muted-foreground">{t('demo/demo:banner')}</p></>
      : <a className={link} href="/login">{t('demo/demo:signIn')}</a>}
    </Page>
  </main>;
}

/** A sandbox's start page: one-click roles, the public join with the test card, and the kiosk. The banner reports sign-in failures. */
function SandboxLanding() {
  const { login, pending } = useDemoLogin();
  return <main id="main-content" className="flex-1 p-4 sm:p-6">
    <Page className="max-w-4xl">
      <PageHeader title={t('demo/landing:title')} description={t('demo/landing:intro')} />
      <PageSection title={t('demo/landing:rolesTitle')}>
        <div className="grid gap-4 md:grid-cols-3">{roles.map((role) => <Card key={role} className="flex flex-col gap-3 p-4 sm:p-6">
          <h3 className="text-lg font-semibold">{t(`demo/demo:${role}Label`)}</h3>
          <p className="flex-1">{t(role === 'student' ? 'demo/landing:studentHelp' : `demo/demo:${role}Help`)}</p>
          <Button type="button" variant="outline" disabled={pending} onClick={() => { void login(role); }}>{t(`demo/demo:${role}`)}</Button>
        </Card>)}</div>
      </PageSection>
      <Card className="p-4 sm:p-6">
        <PageSection title={t('demo/landing:joinTitle')} description={t('demo/landing:joinNeedsStripe')}>
          <ol className="list-decimal space-y-3 pl-5">
            <li className="space-y-1"><p>{t('demo/landing:joinStepPlan')}</p><a className={link} href="/join">{t('demo/landing:joinOpen')}</a></li>
            <li className="space-y-2"><p>{t('demo/landing:joinStepPay')}</p>
              <p className="w-fit rounded-md border border-border bg-muted px-3 py-2 font-mono text-lg whitespace-nowrap">
                <span className="sr-only">{t('demo/landing:testCard')}: </span>{demoTestCard}</p></li>
            <li className="space-y-1"><p>{t('demo/landing:joinStepSignIn')}</p>
              <Button type="button" variant="outline" disabled={pending} onClick={() => { void login('owner', '/admin/outbox'); }}>{t('demo/landing:outboxOpen')}</Button></li>
          </ol>
        </PageSection>
      </Card>
      <Card className="p-4 sm:p-6">
        <PageSection title={t('demo/landing:kioskTitle')}>
          <p>{t('demo/landing:kioskHelp')}</p><a className={link} href="/kiosk">{t('demo/landing:kioskOpen')}</a>
        </PageSection>
      </Card>
    </Page>
  </main>;
}
