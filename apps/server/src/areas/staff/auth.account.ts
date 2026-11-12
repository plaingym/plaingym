// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
import { forGym, householdUsers, households, staffRoles } from '@plaingym/db';
import { AppError, createTranslator, staffRoles as validRoles, type Translator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { accountContracts, type AccountSummary } from '@plaingym/shared/contracts';
import type { Context } from 'hono';
import { jsx } from 'hono/jsx/jsx-runtime';
import { route } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { cspNonce } from '../../core/csp.js';
import { requestSession } from '../../infra/auth/middleware.js';
import { createEmailChangeService, emailChangePagePath, type EmailChangeMail, type EmailChangeService } from '../../infra/auth/email-change.js';

export interface AccountRouteOptions {
  readonly service: EmailChangeService;
  /** Whether the gym can send email (its own SMTP or the install's): the change needs its link delivered. */
  smtpConfigured(gymId: string): Promise<boolean>;
  /** The gym's mail and canonical origin, as for signed links. */
  readonly mail: EmailChangeMail;
  readonly scope?: typeof forGym;
}
let configured: AccountRouteOptions | undefined;
/** Runtime wiring supplies delivery; without it the page still shows the account, and changing the email is unavailable. */
export function configureAccount(options: AccountRouteOptions): void { configured = options; }

/** The request's own login in this gym, from its verified session; never from request input. */
function login(context: Context<RequestEnvironment>) {
  const { principal, gym } = context.get('context');
  if (principal.kind === 'staff' || principal.kind === 'member') {
    if ((principal.kind === 'staff' ? principal.gymId : principal.scope.gymId) !== gym.gymId) throw new AppError('forbidden', 'Authentication gym mismatch');
    return principal.userId;
  }
  throw new AppError('unauthenticated', 'Sign in to see your account');
}
const t = createTranslator(locales.en ?? {});
/** The page the emailed link opens. The token stays in the fragment and is posted as JSON; the markup never contains it. */
export function emailChangePage(text: Translator, nonce: string) {
  const script = `const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);const button=document.getElementById('confirm');const show=(id)=>{document.getElementById(id).hidden=false;};button.addEventListener('click',async()=>{button.disabled=true;for(const id of ['error','expired','other','taken'])document.getElementById(id).hidden=true;try{const response=await fetch('/api/account/email/confirm',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});if(response.ok){const body=await response.json();document.getElementById('address').textContent=body.data.email;button.hidden=true;show('success');return;}show(response.status===404?'expired':response.status===403?'other':response.status===409?'taken':'error');}catch{show('error');}finally{button.disabled=false;}});`;
  return jsx('html', { lang: 'en', children: [
    jsx('head', { children: [jsx('meta', { charset: 'utf-8' }), jsx('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }), jsx('meta', { name: 'referrer', content: 'no-referrer' }), jsx('title', { children: text('auth/account:confirmTitle') })] }),
    jsx('body', { children: [jsx('main', { children: [
      jsx('h1', { children: text('auth/account:confirmTitle') }), jsx('p', { children: text('auth/account:confirmDescription') }),
      jsx('button', { id: 'confirm', type: 'button', children: text('auth/account:confirmButton') }),
      jsx('p', { id: 'expired', role: 'alert', hidden: true, children: text('auth/account:confirmExpired') }),
      jsx('p', { id: 'other', role: 'alert', hidden: true, children: text('auth/account:confirmOtherLogin') }),
      jsx('p', { id: 'taken', role: 'alert', hidden: true, children: text('auth/account:confirmTaken') }),
      jsx('p', { id: 'error', role: 'alert', hidden: true, children: text('auth/account:confirmError') }),
      jsx('div', { id: 'success', role: 'status', hidden: true, children: [
        jsx('p', { children: [text('auth/account:confirmDone'), ' ', jsx('strong', { id: 'address' })] }),
        jsx('p', { children: [text('auth/account:confirmSessions'), ' ', jsx('a', { href: '/login', children: text('auth/account:signIn') })] }),
      ] }),
      jsx('noscript', { children: text('auth/account:javascriptRequired') }),
    ] }), jsx('footer', { children: jsx('a', { href: '/source', children: text('auth/account:source') }) }),
    jsx('script', { nonce, dangerouslySetInnerHTML: { __html: script } })] }),
  ] });
}

export function createAccountRoutes(options?: AccountRouteOptions) {
  const dependencies = () => options ?? configured;
  const scope = () => dependencies()?.scope ?? forGym;
  let fallback: EmailChangeService | undefined;
  // Unwired, the account still shows; the install's tenancy decides whether a change could apply (demo mode is `multi`).
  const service = () => dependencies()?.service ?? (fallback ??= createEmailChangeService({ config: { tenancy: process.env.TENANCY === 'multi' ? 'multi' : 'single' } }));
  const { get, requestEmailChange, confirmEmailChange } = accountContracts;
  return [route({
    method: get.method, path: get.path, permission: get.permission, description: get.description,
    responses: { 200: { description: 'The signed-in login\'s account', content: { 'application/json': { schema: get.response } } } },
  }, async (context) => {
    const userId = login(context), { gym, clock } = context.get('context');
    context.header('Cache-Control', 'no-store');
    const own = await service().summary(gym.gymId, userId, clock);
    // This gym's own records of the login: its roles and household links here, never another gym's.
    const access = await scope()(gym.gymId, async (tx) => ({
      roles: (await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, userId))).flatMap(({ role }) => validRoles.filter(value => value === role)),
      households: (await tx.select({ name: households.name, scope: householdUsers.scope }).from(householdUsers)
        .innerJoin(households, eq(households.id, householdUsers.householdId)).where(eq(householdUsers.userId, userId))
        .orderBy(asc(households.name), asc(households.id))).map(row => ({ name: row.name, scope: row.scope === 'member' ? 'member' as const : 'payer' as const })),
    }));
    const deps = dependencies();
    const emailChange: AccountSummary['emailChange'] = service().tenancy !== 'single' ? 'several_gyms'
      : deps && await deps.smtpConfigured(gym.gymId) ? 'available' : 'no_email';
    return context.json({ data: { ...own, ...access, emailChange } }, 200);
  }), route({
    method: requestEmailChange.method, path: requestEmailChange.path, permission: requestEmailChange.permission, description: requestEmailChange.description,
    request: { body: { required: true, content: { 'application/json': { schema: requestEmailChange.body } } } },
    responses: { 200: { description: 'Link sent to the new address', content: { 'application/json': { schema: requestEmailChange.response } } } },
  }, async (context) => {
    const userId = login(context), { gym, clock } = context.get('context');
    context.header('Cache-Control', 'no-store');
    const deps = dependencies();
    if (!deps || !await deps.smtpConfigured(gym.gymId)) throw new AppError('unavailable', 'This gym can\'t send email');
    const sent = await deps.service.request({ gymId: gym.gymId, userId, sessionId: requestSession(context.req.raw)?.sessionId ?? null,
      newEmail: context.req.valid('json').newEmail, clock, mail: deps.mail });
    return context.json({ data: { email: sent.email, expiresAt: sent.expiresAt } }, 200);
  }), route({
    method: confirmEmailChange.method, path: confirmEmailChange.path, permission: confirmEmailChange.permission, description: confirmEmailChange.description,
    request: { body: { required: true, content: { 'application/json': { schema: confirmEmailChange.body } } } },
    responses: { 200: { description: 'Sign-in email changed', content: { 'application/json': { schema: confirmEmailChange.response } } } },
  }, async (context) => {
    const { gym, clock, principal } = context.get('context');
    context.header('Cache-Control', 'no-store');
    const sessionUserId = principal.kind === 'staff' || principal.kind === 'member' ? login(context) : null;
    const deps = dependencies();
    const applied = await service().confirm({ gymId: gym.gymId, token: context.req.valid('json').token, sessionUserId, clock, ...deps ? { mail: deps.mail } : {} });
    return context.json({ data: { email: applied.to } }, 200);
  }),
  // The page the emailed link opens is server-rendered HTML, outside the JSON contracts, like the staff invitation page.
  route({ method: 'get', path: emailChangePagePath, permission: { kind: 'public' },
    responses: { 200: { description: 'Confirm a sign-in email change', content: { 'text/html': { schema: z.string() } } } } }, async (context) => {
    context.header('Cache-Control', 'no-store'); context.header('Referrer-Policy', 'no-referrer');
    return context.html(emailChangePage(t, cspNonce(context)).toString(), 200);
  })];
}
