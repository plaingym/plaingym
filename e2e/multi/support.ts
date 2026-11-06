// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client, cached, createClass, expect, missingId, type ClassSession, type Person, type Program, type RecordId } from '../support.js';
import { claimPortal, signaturePng, stripeOrigin, stripeSecret, deliverStripeEvent } from '../portal.js';

/** The two gyms of the multi-gym install, each on its own hostname. */
export const gyms = [
  { slug: 'alpha', name: 'Alpha Academy', origin: 'https://alpha.multi.localhost', ownerEmail: 'owner@alpha.example.invalid' },
  { slug: 'beta', name: 'Beta Barbell', origin: 'https://beta.multi.localhost', ownerEmail: 'owner@beta.example.invalid' },
] as const;
export type Slug = (typeof gyms)[number]['slug'];
export const mailOrigin = 'https://mail.localhost';
/** A gym's own restricted test key. The fake Stripe keeps one account per key, so no two gyms ever share objects. */
export const stripeKeyOf = (slug: Slug) => 'rk_test_' + createHash('sha256').update(`${stripeSecret('E2E_STRIPE_RESTRICTED_KEY')}:${slug}`).digest('hex').slice(0, 32);
/** The fake Stripe API as the account of one key. */
export const stripeAs = (key: string) => new Client(stripeOrigin, { authorization: 'Bearer ' + key });

export { signStripeEvent, deliverStripeEvent, postStripeEvent } from '../portal.js';

interface Mail { ID: string; To: { Address: string }[]; Created: string }
/** The IDs of every message the mail catcher holds. */
export async function mailIds() {
  const mail = await new Client(mailOrigin).json<{ messages: Mail[] }>('/api/v1/messages?limit=500');
  return new Set(mail.messages.map((message) => message.ID));
}
/** The newest link to `recipient` that arrived after `before` and whose path matches. Emailed links are bearer credentials. */
export async function mailLink(recipient: string, path: RegExp, before: Set<string>) {
  const mail = new Client(mailOrigin);
  let link: URL | undefined;
  await expect.poll(async () => {
    const list = await mail.json<{ messages: Mail[] }>('/api/v1/messages?limit=500');
    const fresh = list.messages.filter((message) => !before.has(message.ID) && message.To.some((to) => to.Address.toLowerCase() === recipient))
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
    for (const message of fresh) {
      const body = await mail.json<{ Text: string }>('/api/v1/message/' + message.ID);
      for (const match of body.Text.matchAll(/https:\/\/[^\s<>"]+/g)) {
        const url = new URL(match[0]);
        if (path.test(url.pathname)) { link = url; return true; }
      }
    }
    return false;
  }, { timeout: 30_000, message: 'A link reaches the mail catcher' }).toBe(true);
  return link!;
}
const cookieOf = (cookies: string[]) => cookies.map((value) => value.split(';')[0]).join('; ');

/** Verifies an emailed sign-in link on its own gym's hostname and returns the session cookie. */
export async function verifyLink(origin: string, link: URL) {
  expect(link.origin).toBe(origin);
  const response = await new Client(origin).request(link.pathname + link.search);
  expect([302, 303], response.text).toContain(response.status);
  const cookie = cookieOf(response.cookies);
  expect(cookie).toContain('session_token=');
  return cookie;
}
/** Asks for a magic link as the sign-in page does, and follows the emailed link. */
export async function signIn(origin: string, email: string) {
  const before = await mailIds();
  const asked = await new Client(origin).request('/api/auth/sign-in/magic-link', 'POST', { email });
  expect(asked.status, asked.text).toBe(200);
  return verifyLink(origin, await mailLink(email, /^\/api\/auth\//, before));
}
export const withCookie = (origin: string, cookie: string, headers: Record<string, string> = {}) =>
  Object.assign(new Client(origin, headers), { cookie });

/** One gym's fixtures: staff sessions, a household with a portal login, and a record of every kind the staff API holds. */
export interface GymFixture {
  slug: Slug; name: string; origin: string; gymId: string; ownerEmail: string; coachEmail: string; stripeKey: string;
  cookies: { owner: string; coach: string; household: string };
  program: Program; rankSystemId: string; rankId: string;
  student: Person & { fullName: string }; householdId: string; pin: string;
  /** The gym's class: created through `createClass`, so its start is clear of local midnight at any hour. */
  session: ClassSession; sessionId: string; sessionName: string; bookingId: string;
  invoiceId: string; signatureId: string; deviceId: string; kioskToken: string; planId: string; templateId: string; tagId: string;
  /** Billing: a second invoice paid at the desk, that payment and its refund, a charge type, a tax rate and a membership. */
  paidInvoiceId: string; paymentId: string; refundId: string; chargeTypeId: string; taxRateId: string; membershipId: string;
  /** A card saved through hosted Checkout and the signed setup webhook. */
  paymentMethodId: string;
  /** A signed link, and a campaign that sent one. */
  linkId: string; campaignId: string;
  /** A weekly schedule template, a class tag, a data export, and an import run (dry run) with its CSV upload. */
  scheduleTemplateId: string; classTagId: string; exportId: string; importId: string; uploadId: string;
}
export interface Context extends GymFixture {
  owner: Client; coach: Client; household: Client; device: Client;
}
export const contextOf = (fixture: GymFixture): Context => ({ ...fixture,
  owner: withCookie(fixture.origin, fixture.cookies.owner), coach: withCookie(fixture.origin, fixture.cookies.coach),
  household: withCookie(fixture.origin, fixture.cookies.household, { 'X-Portal-Household': fixture.householdId }), device: new Client(fixture.origin, { authorization: 'Bearer ' + fixture.kioskToken }) });

/** A multipart/form-data body with one file part, as a browser upload sends it. */
export function multipart(field: string, filename: string, type: string, content: Buffer) {
  const boundary = '----plaingym' + randomBytes(8).toString('hex');
  const head = Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${field}"; filename="${filename}"\r\ncontent-type: ${type}\r\n\r\n`);
  return { body: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } };
}

/** The gym's fixture is built in named steps, each saved with its writes as they succeed, so a run that fails halfway resumes where it stopped:
 * the next worker neither creates the gym again (and fails on "Account is already staff") nor hides the first failure. */
export async function createGym(gym: (typeof gyms)[number], afterWrite: (step: 'coach' | 'ranks') => void = () => {}): Promise<GymFixture> {
  const step = <T>(name: string, create: () => Promise<T>) => cached(`multi:${gym.slug}:${name}`, create);
  const stripeKey = stripeKeyOf(gym.slug);

  // The supported CLI creates the gym and emails its owner a login link.
  const opened = await step('gym', async () => {
    const before = await mailIds();
    let created: { stdout: string };
    try {
      created = await promisify(execFile)('docker', ['compose', '--project-name', process.env.E2E_COMPOSE_PROJECT!, '--file', 'compose.yaml',
        'exec', '-T', 'multi', 'gym-app', 'gyms', 'create', gym.slug, new URL(gym.origin).hostname, gym.ownerEmail, gym.name, 'UTC', 'USD'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 60_000 });
    } catch (error) {
      // A gym that already exists (the run stopped after creating it) is reused: its owner signs in by email. Only the CLI's own
      // refusal leads here, so a failure of the first build after the gym was created (its owner link, say) still fails the run.
      const known = await new Client(gym.origin).request('/api/public/config');
      if (known.status !== 200) throw error;
      const ownerCookie = await signIn(gym.origin, gym.ownerEmail);
      const bootstrap = await withCookie(gym.origin, ownerCookie).json<{ data: { gym: { id: string } } }>('/api/auth/bootstrap');
      return { gymId: bootstrap.data.gym.id, ownerCookie };
    }
    const result = JSON.parse(created.stdout.trim().split('\n').at(-1)!) as { gymId: string; delivery: string };
    expect(result.delivery).toBe('email');
    return { gymId: result.gymId, ownerCookie: await verifyLink(gym.origin, await mailLink(gym.ownerEmail, /^\/api\/auth\//, before)) };
  });
  const ownerCookie = opened.ownerCookie;
  const owner = withCookie(gym.origin, ownerCookie), guest = new Client(gym.origin);

  // A coach, invited by the owner. The install has no passwords, so the invitee signs in by email.
  const coachEmail = `coach@${gym.slug}.example.invalid`;
  const coachCookie = await step('coach', async () => {
    const invite = await step('write:staff-invitations', () => owner.json<{ data: { invitationUrl: string } }>('/api/staff/invitations', 'POST', { email: coachEmail, role: 'coach', delivery: 'print' }));
    // Every link a gym hands out names its own hostname.
    expect(new URL(invite.data.invitationUrl).origin).toBe(gym.origin);
    await step('write:staff-invitations-accept', () => guest.json('/api/staff/invitations/accept', 'POST', { token: new URL(invite.data.invitationUrl).hash.slice(1), name: `${gym.name} coach` }));
    afterWrite('coach');
    return signIn(gym.origin, coachEmail);
  });

  // Gym data: a rank system with a program, a household with a member who has a PIN, a class and a booking.
  const ranks = await step('ranks', async () => {
    const system = (await step('write:rank-systems', () => owner.json<{ data: RecordId }>('/api/rank-systems', 'POST', { name: gym.name + ' belts' }))).data;
    const rank = (await step('write:ranks', () => owner.json<{ data: RecordId }>('/api/ranks', 'POST', { rankSystemId: system.id, name: gym.name + ' white', position: 0, subRanks: [], criteria: [] }))).data;
    const program = (await step('write:programs', () => owner.json<{ data: Program }>('/api/programs', 'POST', { name: gym.name + ' fundamentals', rankSystemId: system.id, active: true }))).data;
    afterWrite('ranks');
    return { systemId: system.id, rankId: rank.id, program };
  });
  const pin = gym.slug === 'alpha' ? '2468' : '1357';
  const people = await step('people', async () => {
    const home = (await step('write:households', () => owner.json<{ data: RecordId }>('/api/households', 'POST', { name: `${gym.name} family`, email: `family@${gym.slug}.example.invalid` }))).data;
    const lastName = gym.slug[0]!.toUpperCase() + gym.slug.slice(1) + 'Student';
    const student = (await step('write:members', () => owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Casey', lastName, dateOfBirth: '2014-03-04', status: 'active' }))).data;
    const current = await owner.json<{ data: RecordId }>('/api/households/' + home.id);
    await step('write:households-home-id-pin', () => owner.json(`/api/households/${home.id}/pin`, 'PUT', { revision: current.data.revision, pin }));
    return { householdId: home.id, student };
  });
  const { householdId, student } = people;
  // The class starts a day or so ahead, on a 5-minute mark clear of the gym's midnight, whatever time the run starts.
  const klass = await step('class', async () => {
    const session = await step('write:class', () => createClass(owner, `${gym.name} open mat`, { capacity: 10, programId: ranks.program.id }));
    const booking = (await step('write:bookings', () => owner.json<{ data: RecordId }>('/api/bookings', 'POST', { memberId: student.id, sessionId: session.id, allowWaitlist: false }))).data;
    return { session, bookingId: booking.id };
  });
  const tag = await step('member-tag', async () => (await step('write:member-tags', () => owner.json<{ data: RecordId }>('/api/member-tags', 'POST', { name: gym.name + ' tag' }))).data);
  const device = await step('device', async () => (await step('write:kiosk-devices', () => owner.json<{ data: { token: string; device: RecordId } }>('/api/kiosk/devices', 'POST', { name: gym.name + ' tablet' }))).data);

  // Billing: the gym's own (fake) Stripe key, one plan, one current waiver, and an invoice for the household.
  const billing = await step('billing', async () => {
    const integrations = await owner.json<{ data: { revision: number } }>('/api/settings/integrations');
    await step('write:settings-integrations-stripe', () => owner.json('/api/settings/integrations/stripe', 'PUT', { revision: integrations.data.revision, restrictedKey: stripeKey }));
    const plan = (await step('write:billing-plans', () => owner.json<{ data: RecordId }>('/api/billing/plans', 'POST', { name: gym.name + ' monthly', amountCents: 9000, currency: 'USD', interval: 'monthly' }))).data;
    const template = (await step('write:waivers-templates', () => owner.json<{ data: RecordId }>('/api/waivers/templates', 'POST', { name: gym.name + ' liability waiver', kind: 'waiver',
      body: `I understand that training at ${gym.name} carries a risk of injury and I accept it.` }))).data;
    const switches = await owner.json<{ data: { revision: number } }>('/api/settings/go-live');
    await step('write:settings-go-live', () => owner.json('/api/settings/go-live', 'PATCH', { revision: switches.data.revision, billingEnabled: true, memberEmailsEnabled: true }));
    const dueOn = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const oneOff = (description: string) => step('write:invoice:' + description, () => owner.json<{ data: RecordId }>('/api/billing/invoices/one-off', 'POST', { householdId, dueOn,
      source: 'custom', description, currency: 'USD', amountCents: 2500, taxRateIds: [] }));
    const invoice = (await oneOff(gym.name + ' gear')).data, paidInvoice = (await oneOff(gym.name + ' towels')).data;
    return { planId: plan.id, templateId: template.id, invoiceId: invoice.id, paidInvoiceId: paidInvoice.id };
  });
  // The records the billing API holds besides plans and invoices: a payment (recorded at the desk) and its refund, a charge type,
  // a tax rate and a membership.
  const payment = await step('payment', async () => {
    const recorded = (await step('write:billing-invoices-billing-paidInvoiceId-payments', () => owner.json<{ data: RecordId }>(`/api/billing/invoices/${billing.paidInvoiceId}/payments`, 'POST',
      { amountCents: 2500, currency: 'USD', method: 'cash', reference: null, paidAt: new Date().toISOString() }))).data;
    const payments = (await owner.json<{ data: { id: string; invoiceId: string }[] }>('/api/billing/payments?limit=100')).data;
    const paymentId = payments.find((row) => row.invoiceId === billing.paidInvoiceId)?.id ?? recorded.id;
    return { paymentId, refundId: (await step('write:billing-payments-paymentId-refunds', () => owner.json<{ data: RecordId }>(`/api/billing/payments/${paymentId}/refunds`, 'POST',
      { amountCents: 500, currency: 'USD', reason: gym.name + ' refund' }))).data.id };
  });
  const taxes = await step('taxes', async () => {
    const taxRate = (await step('write:billing-tax-rates', () => owner.json<{ data: RecordId }>('/api/billing/tax-rates', 'POST', { name: gym.name + ' sales tax', rateMillionths: 50_000, inclusive: false }))).data;
    const chargeType = (await step('write:billing-charge-types', () => owner.json<{ data: RecordId }>('/api/billing/charge-types', 'POST', { name: gym.name + ' drop-in', amountCents: 2000, currency: 'USD', taxRateIds: [taxRate.id] }))).data;
    return { taxRateId: taxRate.id, chargeTypeId: chargeType.id };
  });
  const membershipId = await step('membership', async () => {
    // A household with no live membership bills from its join date, so the first due date is the start date: a week out, so no
    // charge run issues its invoice while the run is going (a run near midnight would otherwise change the gym's invoice list).
    const startsOn = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    return (await step('write:billing-memberships', () => owner.json<{ data: RecordId }>('/api/billing/memberships', 'POST', { householdId, memberId: student.id, planId: billing.planId,
      startsOn, nextDueOn: startsOn, firstPeriod: 'next_billing_date' }))).data.id;
  });
  const ledger = { ...payment, ...taxes, membershipId };

  // The household's portal login, claimed from its emailed invitation.
  const portalCookie = await step('portal', async () => {
    const invitation = await step('write:households-householdId-portal-invitations', () => owner.json<{ data: { invitationUrl: string } }>(`/api/households/${householdId}/portal-invitations`, 'POST',
      { email: `family@${gym.slug}.example.invalid`, delivery: 'print', scope: 'payer' }));
    expect(new URL(invitation.data.invitationUrl).origin).toBe(gym.origin);
    const beforePortal = new Set(await step('portal:mail-before', async () => [...await mailIds()]));
    const accepted = await step('write:portal-invitations-accept', () => guest.json<{ data: { status: string } }>('/api/portal/invitations/accept', 'POST', { token: new URL(invitation.data.invitationUrl).hash.slice(1) }));
    expect(accepted.data.status).toBe('email_sent');
    const portalLink = new URL(await step('portal:link', async () => (await mailLink(`family@${gym.slug}.example.invalid`, /^\/api\/auth\//, beforePortal)).href));
    expect(portalLink.origin).toBe(gym.origin);
    return (await claimPortal(gym.origin, portalLink, step)).cookie;
  });
  const portal = withCookie(gym.origin, portalCookie, { 'X-Portal-Household': householdId });

  // The member signs the gym's current waiver through the household login, as the kiosk requires.
  const signatureId = await step('signature', async () => {
    const image = await step('write:portal-household-waivers-signature-images', () => portal.json<{ data: { signatureImageKey: string; signatureImageHash: string } }>('/api/portal/household/waivers/signature-images', 'POST',
      { memberId: student.id, pngBase64: signaturePng().toString('base64') }));
    const signed = await step('write:portal-household-waivers', () => portal.json<{ data: RecordId }>('/api/portal/household/waivers', 'POST', { memberId: student.id, templateId: billing.templateId, templateVersion: 1,
      signer: { kind: 'guardian', name: gym.name + ' parent', relationship: 'Parent' }, ...image.data, consent: true }));
    return signed.data.id;
  });

  // A card saved the way a household saves one: hosted Checkout in setup mode, then the gym's signed webhook.
  const paymentMethodId = await step('payment-method', async () => {
    const started = await step('write:portal-payment-methods-checkout', () => portal.json<{ data: { url: string } }>('/api/portal/payment-methods/checkout', 'POST', {}));
    const sessionId = new URL(started.data.url).pathname.split('/').pop()!;
    await step('write:checkout-paid', async () => {
      const paid = await new Client(stripeOrigin).request('/pay/' + sessionId, 'POST', Buffer.from('card=4242424242424242'));
      expect(paid.status, paid.text).toBe(303); // Before the checkpoint: a failed payment isn't saved as done.
      return paid;
    });
    const session = await stripeAs(stripeKey).json<Record<string, unknown>>('/v1/checkout/sessions/' + sessionId);
    expect(session).toMatchObject({ status: 'complete', mode: 'setup', metadata: { gym_id: opened.gymId } });
    await step('write:checkout-webhook', () => deliverStripeEvent('checkout.session.completed', session, { origin: gym.origin, stripeKey }));
    let found: string | undefined;
    await expect.poll(async () => {
      const methods = await owner.json<{ data: { id: string }[] }>(`/api/billing/households/${householdId}/payment-methods?limit=100`);
      found = methods.data[0]?.id;
      return found;
    }, { timeout: 30_000, message: 'The signed setup webhook saves the household card' }).toBeTruthy();
    return found!;
  });

  // Signed links and a campaign that sent one, a schedule template and a class tag, an export, and an import run.
  const extras = await step('extras', async () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const campaign = (await step('write:link-campaigns', () => owner.json<{ data: { campaign: RecordId } }>('/api/link-campaigns', 'POST', { name: gym.name + ' cards', purpose: 'update_card', expiresAt,
      reminderSchedule: [], recipients: [{ householdId }] }))).data.campaign;
    const link = (await step('write:links', () => owner.json<{ data: { link: RecordId } }>('/api/links', 'POST', { purpose: 'onboarding', householdId, expiresAt }))).data.link;
    const scheduleTemplate = (await step('write:schedule-templates', () => owner.json<{ data: RecordId }>('/api/schedule/templates', 'POST', { name: gym.name + ' weekly', weekday: 3, localStartTime: '12:00',
      durationMinutes: 60, coachId: null, capacity: 10, notes: null, kind: 'class', programIds: [ranks.program.id], tagIds: [] }))).data;
    const classTag = (await step('write:schedule-tags', () => owner.json<{ data: RecordId }>('/api/schedule/tags', 'POST', { name: gym.name + ' gi' }))).data;
    const exported = (await step('write:exports', () => owner.json<{ data: RecordId }>('/api/exports', 'POST', { format: 'csv' }))).data;
    const csv = Buffer.from(`First,Last\r\nPlaced,${gym.slug[0]!.toUpperCase() + gym.slug.slice(1)}Import\r\n`);
    const file = multipart('file', 'people.csv', 'text/csv', csv);
    const upload = (await step('write:imports-uploads', () => owner.json<{ data: { id: string } }>('/api/imports/uploads', 'POST', file.body, file.headers))).data;
    const imported = (await step('write:imports', () => owner.json<{ data: RecordId }>('/api/imports', 'POST', { uploadId: upload.id, mapper: 'people', duplicatePolicy: 'skip', dryRun: true,
      mapping: [{ sourceColumn: 'First', targetField: 'firstName' }, { sourceColumn: 'Last', targetField: 'lastName' }] }))).data;
    return { campaignId: campaign.id, linkId: link.id, scheduleTemplateId: scheduleTemplate.id, classTagId: classTag.id, exportId: exported.id, importId: imported.id, uploadId: upload.id };
  });

  return { slug: gym.slug, name: gym.name, origin: gym.origin, gymId: opened.gymId, ownerEmail: gym.ownerEmail, coachEmail, stripeKey,
    cookies: { owner: ownerCookie, coach: coachCookie, household: portalCookie }, program: ranks.program, rankSystemId: ranks.systemId, rankId: ranks.rankId,
    student: { ...student, fullName: `${student.firstName} ${student.lastName}` }, householdId, pin, session: klass.session, sessionId: klass.session.id,
    sessionName: klass.session.name, bookingId: klass.bookingId, invoiceId: billing.invoiceId, signatureId, deviceId: device.device.id, kioskToken: device.token,
    planId: billing.planId, templateId: billing.templateId, tagId: tag.id, paidInvoiceId: billing.paidInvoiceId, ...ledger, paymentMethodId, ...extras };
}

let built: Promise<GymFixture[]> | undefined;
/** Both gyms, created once per run. Composite steps preserve their individual write checkpoints when a worker resumes. */
export async function multiGyms(): Promise<[Context, Context]> {
  built ??= (async () => {
    const created: GymFixture[] = [];
    for (const gym of gyms) created.push(await createGym(gym));
    return created;
  })();
  try {
    const fixtures = await built;
    return [contextOf(fixtures[0]!), contextOf(fixtures[1]!)];
  } catch (error) { built = undefined; throw error; }
}
export { missingId };
