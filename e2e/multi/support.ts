// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client, cached, expect, missingId, type Person, type Program, type RecordId } from '../support.js';
import { claimPortal, retryLimited, signaturePng } from '../portal.js';

/** The two gyms of the multi-gym install, each on its own hostname. */
export const gyms = [
  { slug: 'alpha', name: 'Alpha Academy', origin: 'https://alpha.multi.localhost', ownerEmail: 'owner@alpha.example.invalid' },
  { slug: 'beta', name: 'Beta Barbell', origin: 'https://beta.multi.localhost', ownerEmail: 'owner@beta.example.invalid' },
] as const;
export type Slug = (typeof gyms)[number]['slug'];
export const mailOrigin = 'https://mail.localhost';
export const stripeRestrictedKey = () => {
  const value = process.env.E2E_STRIPE_RESTRICTED_KEY;
  if (!value) throw new Error('Run through pnpm --dir e2e test to configure the fake Stripe');
  return value;
};

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
  const response = await retryLimited(() => new Client(origin).request(link.pathname + link.search));
  expect([302, 303], response.text).toContain(response.status);
  const cookie = cookieOf(response.cookies);
  expect(cookie).toContain('session_token=');
  return cookie;
}
/** Asks for a magic link as the sign-in page does, and follows the emailed link. */
export async function signIn(origin: string, email: string) {
  const before = await mailIds();
  const asked = await retryLimited(() => new Client(origin).request('/api/auth/sign-in/magic-link', 'POST', { email }));
  expect(asked.status, asked.text).toBe(200);
  return verifyLink(origin, await mailLink(email, /^\/api\/auth\//, before));
}
export const withCookie = (origin: string, cookie: string, headers: Record<string, string> = {}) =>
  Object.assign(new Client(origin, headers), { cookie });

/** One gym's fixtures: staff sessions, a household with a portal login, a class, and a kiosk device. */
export interface GymFixture {
  slug: Slug; name: string; origin: string; gymId: string; ownerEmail: string; coachEmail: string;
  cookies: { owner: string; coach: string; household: string };
  program: Program; rankSystemId: string; rankId: string;
  student: Person & { fullName: string }; householdId: string; pin: string;
  sessionId: string; sessionName: string; bookingId: string; invoiceId: string; signatureId: string;
  deviceId: string; kioskToken: string; planId: string; templateId: string; tagId: string;
}
export interface Context extends GymFixture {
  owner: Client; coach: Client; household: Client; device: Client;
}
export const contextOf = (fixture: GymFixture): Context => ({ ...fixture,
  owner: withCookie(fixture.origin, fixture.cookies.owner), coach: withCookie(fixture.origin, fixture.cookies.coach),
  household: withCookie(fixture.origin, fixture.cookies.household), device: new Client(fixture.origin, { authorization: 'Bearer ' + fixture.kioskToken }) });

async function createGym(gym: (typeof gyms)[number]): Promise<GymFixture> {
  // The supported CLI creates the gym and emails its owner a login link.
  const before = await mailIds();
  const created = await promisify(execFile)('docker', ['compose', '--project-name', process.env.E2E_COMPOSE_PROJECT!, '--file', 'compose.yaml',
    'exec', '-T', 'multi', 'gym-app', 'gyms', 'create', gym.slug, new URL(gym.origin).hostname, gym.ownerEmail, gym.name, 'UTC', 'USD'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 60_000 });
  const result = JSON.parse(created.stdout.trim().split('\n').at(-1)!) as { gymId: string; delivery: string };
  expect(result.delivery).toBe('email');
  const ownerCookie = await verifyLink(gym.origin, await mailLink(gym.ownerEmail, /^\/api\/auth\//, before));
  const owner = withCookie(gym.origin, ownerCookie), guest = new Client(gym.origin);

  // A coach, invited by the owner. The install has no passwords, so the invitee signs in by email.
  const coachEmail = `coach@${gym.slug}.example.invalid`;
  const invite = await owner.json<{ data: { invitationUrl: string } }>('/api/staff/invitations', 'POST', { email: coachEmail, role: 'coach', delivery: 'print' });
  // Every link a gym hands out names its own hostname.
  expect(new URL(invite.data.invitationUrl).origin).toBe(gym.origin);
  await guest.json('/api/staff/invitations/accept', 'POST', { token: new URL(invite.data.invitationUrl).hash.slice(1), name: `${gym.name} coach` });
  const coachCookie = await signIn(gym.origin, coachEmail);

  // Gym data: a rank system with a program, a household with a member who has a PIN, a class and a booking.
  const system = (await owner.json<{ data: RecordId }>('/api/rank-systems', 'POST', { name: gym.name + ' belts' })).data;
  const rank = (await owner.json<{ data: RecordId }>('/api/ranks', 'POST', { rankSystemId: system.id, name: gym.name + ' white', position: 0, subRanks: [], criteria: [] })).data;
  const program = (await owner.json<{ data: Program }>('/api/programs', 'POST', { name: gym.name + ' fundamentals', rankSystemId: system.id, active: true })).data;
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: `${gym.name} family`, email: `family@${gym.slug}.example.invalid` })).data;
  const lastName = gym.slug[0]!.toUpperCase() + gym.slug.slice(1) + 'Student';
  const student = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Casey', lastName, dateOfBirth: '2014-03-04', status: 'active' })).data;
  const pin = gym.slug === 'alpha' ? '2468' : '1357';
  const current = await owner.json<{ data: RecordId }>('/api/households/' + home.id);
  await owner.json(`/api/households/${home.id}/pin`, 'PUT', { revision: current.data.revision, pin });
  const minute = 60_000, start = Math.ceil(Date.now() / (5 * minute)) * 5 * minute + 6 * 60 * minute;
  const sessionName = `${gym.name} open mat`;
  const session = (await owner.json<{ data: RecordId }>('/api/schedule/sessions', 'POST', { name: sessionName, startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 60 * minute).toISOString(), coachId: null, capacity: 10, notes: null, kind: 'class', programIds: [program.id], tagIds: [] })).data;
  const booking = (await owner.json<{ data: RecordId }>('/api/bookings', 'POST', { memberId: student.id, sessionId: session.id, allowWaitlist: false })).data;
  const tag = (await owner.json<{ data: RecordId }>('/api/member-tags', 'POST', { name: gym.name + ' tag' })).data;
  const device = (await owner.json<{ data: { token: string; device: RecordId } }>('/api/kiosk/devices', 'POST', { name: gym.name + ' tablet' })).data;

  // Billing: the gym's own (fake) Stripe key, one plan, one current waiver, and an invoice for the household.
  const integrations = await owner.json<{ data: { revision: number } }>('/api/settings/integrations');
  await owner.json('/api/settings/integrations/stripe', 'PUT', { revision: integrations.data.revision, restrictedKey: stripeRestrictedKey() });
  const plan = (await owner.json<{ data: RecordId }>('/api/billing/plans', 'POST', { name: gym.name + ' monthly', amountCents: 9000, currency: 'USD', interval: 'monthly' })).data;
  const template = (await owner.json<{ data: RecordId }>('/api/waivers/templates', 'POST', { name: gym.name + ' liability waiver', kind: 'waiver',
    body: `I understand that training at ${gym.name} carries a risk of injury and I accept it.` })).data;
  const switches = await owner.json<{ data: { revision: number } }>('/api/settings/go-live');
  await owner.json('/api/settings/go-live', 'PATCH', { revision: switches.data.revision, billingEnabled: true, memberEmailsEnabled: true });
  const invoice = (await owner.json<{ data: RecordId }>('/api/billing/invoices/one-off', 'POST', { householdId: home.id, dueOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    source: 'custom', description: gym.name + ' gear', currency: 'USD', amountCents: 2500, taxRateIds: [] })).data;

  // The household's portal login, claimed from its emailed invitation.
  const invitation = await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${home.id}/portal-invitations`, 'POST',
    { email: `family@${gym.slug}.example.invalid`, delivery: 'print', scope: 'payer' });
  expect(new URL(invitation.data.invitationUrl).origin).toBe(gym.origin);
  const beforePortal = await mailIds();
  const accepted = await guest.json<{ data: { status: string } }>('/api/portal/invitations/accept', 'POST', { token: new URL(invitation.data.invitationUrl).hash.slice(1) });
  expect(accepted.data.status).toBe('email_sent');
  const portalLink = await mailLink(`family@${gym.slug}.example.invalid`, /^\/api\/auth\//, beforePortal);
  expect(portalLink.origin).toBe(gym.origin);
  const portal = await claimPortal(gym.origin, portalLink);

  // The member signs the gym's current waiver through the household login, as the kiosk requires.
  const image = await portal.json<{ data: { signatureImageKey: string; signatureImageHash: string } }>('/api/portal/household/waivers/signature-images', 'POST',
    { memberId: student.id, pngBase64: signaturePng().toString('base64') });
  const signed = await portal.json<{ data: RecordId }>('/api/portal/household/waivers', 'POST', { memberId: student.id, templateId: template.id, templateVersion: 1,
    signer: { kind: 'guardian', name: gym.name + ' parent', relationship: 'Parent' }, ...image.data, consent: true });

  return { slug: gym.slug, name: gym.name, origin: gym.origin, gymId: result.gymId, ownerEmail: gym.ownerEmail, coachEmail,
    cookies: { owner: ownerCookie, coach: coachCookie, household: portal.cookie }, program, rankSystemId: system.id, rankId: rank.id,
    student: { ...student, fullName: `${student.firstName} ${student.lastName}` }, householdId: home.id, pin, sessionId: session.id, sessionName,
    bookingId: booking.id, invoiceId: invoice.id, signatureId: signed.data.id, deviceId: device.device.id, kioskToken: device.token, planId: plan.id, templateId: template.id, tagId: tag.id };
}

/** Both gyms, created once per run. */
export async function multiGyms(): Promise<[Context, Context]> {
  const fixtures = await cached('multi-gyms', async () => {
    const created: GymFixture[] = [];
    for (const gym of gyms) created.push(await createGym(gym));
    return created;
  });
  return [contextOf(fixtures[0]!), contextOf(fixtures[1]!)];
}
export { missingId };
