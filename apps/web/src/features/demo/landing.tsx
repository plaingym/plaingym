// SPDX-License-Identifier: AGPL-3.0-only
import { demoTestCard } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { DemoMenuLink, useDemoJoin, useDemoLogin, useDemoMenu, useDemoMode } from './notice.js';

const roles = ['owner', 'coach', 'student'] as const;

export function DemoPage() {
  const mode = useDemoMode(), entry = mode === 'entry';
  if (mode === 'sandbox' || mode === 'showcase') return <SandboxLanding />;
  return <main id="main-content" className="flex-1 p-4 sm:p-6">
    <Page className="max-w-4xl">
      <PageHeader title={t(entry ? 'demo/demo:rolesTitle' : 'demo/demo:inactiveTitle')}
        {...(!entry ? { description: t('demo/demo:inactiveHelp') } : {})} />
      {entry ? <><div className="grid gap-4 md:grid-cols-3">{roles.map((role) => <Card key={role} className="p-4 sm:p-6">
        <PageSection title={t(`demo/demo:${role}Label`)}><p>{t(`demo/demo:${role}Help`)}</p></PageSection>
      </Card>)}</div><p className="text-sm text-muted-foreground">{t('demo/demo:banner')}</p></>
      : <div className="sm:max-w-sm"><DemoMenuLink href="/login">{t('demo/demo:signIn')}</DemoMenuLink></div>}
    </Page>
  </main>;
}

/** A sandbox's start page: one-click roles and joined members, the public join with the test card, and the kiosk.
 * Navigation is a menu link and signing in is a button, as in the demo menu. The bar reports sign-in failures. */
function SandboxLanding() {
  const { login, pending } = useDemoLogin(), join = useDemoJoin(), members = useDemoMenu().data?.members ?? [];
  return <main id="main-content" className="flex-1 p-4 sm:p-6">
    <Page className="max-w-4xl">
      <PageHeader title={t('demo/landing:title')} description={t(join ? 'demo/landing:intro' : 'demo/landing:introWithoutJoin')} />
      <PageSection title={t('demo/landing:rolesTitle')}>
        <div className="grid gap-4 md:grid-cols-3">{roles.map((role) => <Card key={role} className="flex flex-col gap-3 p-4 sm:p-6">
          <h3 className="text-lg font-semibold">{t(`demo/demo:${role}Label`)}</h3>
          <p className="flex-1">{t(role === 'student' ? 'demo/landing:studentHelp' : `demo/demo:${role}Help`)}</p>
          <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => { void login(role); }}>{t(`demo/demo:${role}`)}</Button>
        </Card>)}</div>
        {members.length > 0 && <Card className="space-y-3 p-4 sm:p-6">
          <h3 className="text-lg font-semibold">{t('demo/landing:joinedTitle')}</h3><p>{t('demo/landing:joinedHelp')}</p>
          <div className="grid gap-2 sm:grid-cols-2">{members.map((member) => <Button key={member.id} type="button" variant="outline" className="w-full"
            disabled={pending} onClick={() => { void login({ member: member.id }); }}>
            <span className="min-w-0 truncate">{t('demo/demo:member', { name: member.name })}</span></Button>)}</div>
        </Card>}
      </PageSection>
      <Card className="p-4 sm:p-6">
        <PageSection title={t('demo/landing:joinTitle')} {...(join ? {} : { description: t('demo/landing:joinUnavailable') })}>
          {join && <ol className="list-decimal space-y-4 pl-5">
            <li className="space-y-2"><p>{t('demo/landing:joinStepPlan')}</p><DemoMenuLink href="/join">{t('demo/landing:joinOpen')}</DemoMenuLink></li>
            <li className="space-y-2"><p>{t('demo/landing:joinStepPay')}</p>
              <p className="w-fit rounded-md border border-border bg-muted px-3 py-2 font-mono text-lg whitespace-nowrap">
                <span className="sr-only">{t('demo/landing:testCard')}: </span>{demoTestCard}</p></li>
            <li className="space-y-2"><p>{t('demo/landing:joinStepSignIn')}</p>
              <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => { void login('owner', '/admin/outbox'); }}>{t('demo/landing:outboxOpen')}</Button></li>
          </ol>}
        </PageSection>
      </Card>
      <Card className="p-4 sm:p-6">
        <PageSection title={t('demo/landing:kioskTitle')}>
          <p>{t('demo/landing:kioskHelp')}</p><DemoMenuLink href="/kiosk">{t('demo/landing:kioskOpen')}</DemoMenuLink>
        </PageSection>
      </Card>
    </Page>
  </main>;
}
