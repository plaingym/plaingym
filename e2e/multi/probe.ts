// SPDX-License-Identifier: AGPL-3.0-only
// What the cross-gym sweep aims at another gym: a gym's records, found by name, and requests built from the running
// OpenAPI document, so a route added to the application is swept without anyone widening a list by hand.
import { expect, missingId, type Document, type Operation, type RecordId, type Schema } from '../support.js';
import { signaturePng } from '../portal.js';
import type { Context } from './support.js';

export interface Route { method: string; path: string; operation: Operation; kind: string; purpose?: string }
export const routeKey = (route: Pick<Route, 'method' | 'path'>) => `${route.method} ${route.path}`;

/** Routes the multi-gym sweep leaves out, each for a stated reason. The sweep fails if one stops matching a route, so the list can't rot. */
export const outOfScope: { pattern: RegExp; reason: string }[] = [
  { pattern: /^\/api\/demo(\/|$)/, reason: 'sandbox routes exist only in demo mode' },
  { pattern: /^\/api\/setup(\/|$)/, reason: 'the first-run wizard of a single-gym install; a multi-gym install creates its gyms with the CLI' },
  { pattern: /^\/api\/health\/(update|auto-update)$/, reason: 'the install\'s own release state, not gym data' },
];

/** Every operation of the document, split into the ones the sweep covers (everything that isn't public) and the ones it leaves out. */
export function routesOf(document: Document) {
  const swept: Route[] = [], excluded: Route[] = [], open: Route[] = [];
  for (const [path, operations] of Object.entries(document.paths)) for (const [method, operation] of Object.entries(operations)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const route = { method: method.toUpperCase(), path, operation, kind: operation.permission.kind, purpose: operation.permission.purpose };
    if (route.kind === 'public') open.push(route);
    else if (outOfScope.some((entry) => entry.pattern.test(path))) excluded.push(route);
    else swept.push(route);
  }
  return { swept, excluded, open };
}

/** What one gym holds that no other gym may ever see: its resource IDs, names and addresses. */
export interface Target { ids: Record<string, string>; secrets: string[]; checkinCode: string }

export async function targetOf(gym: Context): Promise<Target> {
  const { owner } = gym;
  const roles = (await owner.json<{ data: (RecordId & { userId: string })[] }>('/api/staff/roles?limit=100')).data;
  const profiles = (await owner.json<{ data: RecordId[] }>('/api/staff/profiles?limit=100')).data;
  const householdUsers = (await owner.json<{ data: RecordId[] }>(`/api/households/${gym.householdId}/users?limit=100`)).data;
  // An invitation nobody has accepted, so revoking one is aimed at a real record too.
  await owner.json(`/api/households/${gym.householdId}/portal-invitations`, 'POST', { email: `pending@${gym.slug}.example.invalid`, delivery: 'print', scope: 'payer' });
  const invitations = (await owner.json<{ data: RecordId[] }>(`/api/households/${gym.householdId}/portal-invitations`)).data;
  // The member's QR check-in code, issued by the household (reading it shows no code until one is issued).
  const codePath = `/api/portal/members/${gym.student.id}/checkin-code`;
  const state = (await gym.household.json<{ data: { revision: number } }>(codePath)).data;
  const checkin = (await gym.household.json<{ data: { code: string } }>(codePath, 'POST', { revision: state.revision })).data;
  expect(checkin.code).toBeTruthy();
  const ids: Record<string, string> = { memberId: gym.student.id, householdId: gym.householdId, sessionId: gym.sessionId, bookingId: gym.bookingId,
    invoiceId: gym.invoiceId, signatureId: gym.signatureId, deviceId: gym.deviceId, tagId: gym.tagId, programId: gym.program.id, rankSystemId: gym.rankSystemId,
    rankId: gym.rankId, staffRoleId: roles.at(-1)?.id ?? missingId, userId: roles.at(-1)?.userId ?? missingId, staffProfileId: profiles[0]?.id ?? missingId,
    templateId: gym.templateId, planId: gym.planId, householdUserId: householdUsers[0]?.id ?? missingId, invitationId: invitations[0]?.id ?? missingId,
    chargeTypeId: gym.chargeTypeId, packId: gym.classPackId, taxRateId: gym.taxRateId, membershipId: gym.membershipId, paymentId: gym.paymentId, refundId: gym.refundId,
    paymentMethodId: gym.paymentMethodId, linkId: gym.linkId, campaignId: gym.campaignId, announcementId: gym.announcementId, attendanceId: gym.attendanceId, scheduleTemplateId: gym.scheduleTemplateId, classTagId: gym.classTagId,
    exportId: gym.exportId, importId: gym.importId, uploadId: gym.uploadId, paidInvoiceId: gym.paidInvoiceId };
  // Every kind of record exists in the gym's fixtures: an ID nothing holds would make a refusal prove nothing.
  for (const [name, id] of Object.entries(ids)) expect(id, `${gym.slug} fixture holds a ${name}`).toBeTruthy();
  const secrets = [...new Set([...Object.values(ids).filter((value) => value !== missingId), gym.gymId, gym.name, gym.student.lastName, gym.sessionName,
    `@${gym.slug}.example.invalid`, gym.kioskToken, checkin.code, gym.stripeKey])];
  return { ids, secrets, checkinCode: checkin.code };
}

/** The ID in `target` that a path parameter names. A bare `id` is the resource its route is about. */
export function idFor(route: Route, name: string, target: Target) {
  const { ids } = target;
  // A receipt exists for a paid invoice only.
  if (name === 'invoiceId' && route.path.endsWith('/receipt')) return ids.paidInvoiceId ?? missingId;
  if (name !== 'id') return ids[name] ?? missingId;
  const kinds: [RegExp, string][] = [[/^\/api\/(portal\/)?bookings(\/|$)|\/bookings\/\{id\}/, 'bookingId'], [/^\/api\/attendance/, 'attendanceId'],[/^\/api\/programs/, 'programId'], [/^\/api\/rank-systems/, 'rankSystemId'],
    [/^\/api\/ranks/, 'rankId'], [/^\/api\/schedule\/sessions/, 'sessionId'], [/^\/api\/schedule\/templates/, 'scheduleTemplateId'], [/^\/api\/schedule\/tags/, 'classTagId'],
    [/^\/api\/kiosk\/devices/, 'deviceId'], [/^\/api\/exports/, 'exportId'], [/^\/api\/imports/, 'importId']];
  const kind = kinds.find(([pattern]) => pattern.test(route.path));
  return (kind && ids[kind[1]]) ?? missingId;
}
export const pathFor = (route: Route, target: Target) => route.path.replace(/\{(\w+)\}/g, (_, name: string) => idFor(route, name, target));
export const pathParams = (route: Route) => [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);

/** A record ID property's own kind, where its name doesn't say it. */
const idAliases: Record<string, string> = { coachId: 'userId', dropInChargeTypeId: 'chargeTypeId', tagIds: 'classTagId', programIds: 'programId', taxRateIds: 'taxRateId',
  memberIds: 'memberId', householdIds: 'householdId' };
const idNamed = (name: string, target: Target) => target.ids[idAliases[name] ?? name] ?? target.ids[name.replace(/Ids$/, 'Id')];

/** What the PNG a photo or logo body carries, as base64. */
const imageBase64 = () => signaturePng().toString('base64');
const patterns: [string, string][] = [['{2}$', 'US'], ['#[0-9a-fA-F]', '#aabbcc'], ['2[0-3]', '12:00'], ['\\S+', 'leaked'], ['{3}$', 'USD'], ['{64}', 'a'.repeat(64)],
  ['[a-z][a-z0-9-]*', 'leaked'], ['{4,12}', '9999'], ['{4,8}', '9999'], ['utc|', 'UTC'], ['rk_', 'rk_test_leaked'], ['AGE-SECRET', 'AGE-SECRET-KEY-1LEAKED'],
  ['(0|[1-9][0-9]*)', '0'], ['A-Za-z0-9+/]', imageBase64()]]; // the last is the base64 patterns

export interface Aim { target: Target; /** The revision a record's body must carry, by route; 1 when unknown. */ revision?: number; /** Also fill optional properties that name a record. */ optionalIds: boolean }

function stringOf(schema: Schema, name: string, aim: Aim) {
  if (schema.format === 'uuid') return idNamed(name, aim.target) ?? missingId;
  if (schema.format === 'date') return new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  if (schema.format === 'date-time') return new Date(Date.now() + 2 * 86_400_000).toISOString();
  if (schema.format === 'email') return 'leak@example.invalid';
  if (schema.format === 'uri') return 'https://example.invalid/leak';
  if (schema.pattern) return patterns.find(([part]) => schema.pattern!.includes(part))?.[1] ?? 'leaked';
  return 'Leaked'.padEnd(schema.minLength ?? 0, 'x');
}
const namesRecord = (name: string, schema: Schema) => (schema.format === 'uuid' || schema.items?.format === 'uuid') && /Ids?$/.test(name);
const hasIdProperty = (schema: Schema): boolean => Object.entries(schema.properties ?? {}).some(([name, property]) => namesRecord(name, property)
  || (property.type === 'object' && hasIdProperty(property)) || (property.type === 'array' && !!property.items && hasIdProperty(property.items)));

/** A valid value for `schema`: required properties, and the optional ones that name a record when `aim.optionalIds`. */
export function valueOf(schema: Schema, name: string, aim: Aim): unknown {
  const options = schema.anyOf ?? schema.oneOf;
  if (options?.length) return valueOf(options.find((option) => option.type !== 'null') ?? options[0]!, name, aim);
  // The image bodies carry a PNG, so a type the PNG doesn't match is not what stops them.
  if (schema.enum) return name === 'contentType' && schema.enum.includes('image/png') ? 'image/png' : schema.enum[0];
  switch (schema.type) {
    case 'string': return stringOf(schema, name, aim);
    case 'integer': case 'number': return name === 'revision' ? aim.revision ?? 1 : typeof schema.minimum === 'number' ? schema.minimum + (schema.exclusiveMinimum ? 1 : 0) || 1 : 1;
    case 'boolean': return false;
    case 'array': {
      const item = schema.items;
      if (!item) return [];
      if (item.format === 'uuid') { const id = idNamed(name, aim.target); return id ? [id] : (schema.minItems ?? 0) > 0 ? [missingId] : []; }
      return (schema.minItems ?? 0) > 0 || (item.type === 'object' && hasIdProperty(item)) ? [valueOf(item, name, aim)] : [];
    }
    case 'object': {
      const out: Record<string, unknown> = {}, required = new Set(schema.required ?? []);
      for (const [key, property] of Object.entries(schema.properties ?? {}))
        if (required.has(key) || (aim.optionalIds && namesRecord(key, property))) out[key] = valueOf(property, key, aim);
      // An update that changes nothing is refused for its shape, so one that carries only a revision changes the first plain field.
      if (Object.keys(out).every((key) => key === 'revision') && 'revision' in out) {
        const plain = Object.entries(schema.properties ?? {}).find(([key, property]) => key !== 'revision' && ['string', 'number'].includes(property.type ?? '') && !property.format);
        if (plain) out[plain[0]] = valueOf(plain[1], plain[0], aim);
      }
      // A class or window that ends after it starts.
      if (typeof out.startsAt === 'string' && typeof out.endsAt === 'string') out.endsAt = new Date(Date.parse(out.startsAt) + 3_600_000).toISOString();
      return out;
    }
    default: return null;
  }
}

/** The JSON bodies a route takes, one per alternative the schema offers (a link request has one per purpose). */
export function bodiesOf(route: Route, aim: Aim): unknown[] {
  const schema = route.operation.requestBody?.content['application/json']?.schema;
  if (!schema) return [];
  const alternatives = schema.anyOf ?? schema.oneOf;
  return (alternatives ?? [schema]).map((alternative) => valueOf(alternative, '', aim));
}
export const hasJsonBody = (route: Route) => !!route.operation.requestBody?.content['application/json'];
/** Whether a body or query holds any of the target's record IDs, so the route is aimed at the target even with no ID in its path. */
export function namesTarget(value: unknown, target: Target): boolean {
  const ids = new Set(Object.values(target.ids).filter((id) => id !== missingId));
  const walk = (node: unknown): boolean => typeof node === 'string' ? ids.has(node) : Array.isArray(node) ? node.some(walk)
    : node && typeof node === 'object' ? Object.values(node).some(walk) : false;
  return walk(value);
}

/** The query string of a request: every required parameter, and (when `aim.optionalIds`) the optional ones that filter by a record,
 * aimed at `aim.target`. Without them a list shows everything the gym holds. */
export function queryOf(route: Route, aim: Aim) {
  const query = new URLSearchParams();
  const known: Record<string, string> = { from: new Date(Date.now() - 7 * 86_400_000).toISOString(), until: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    to: new Date(Date.now() + 14 * 86_400_000).toISOString(), limit: '100', offset: '0' };
  for (const parameter of route.operation.parameters ?? []) {
    if (parameter.in !== 'query') continue;
    // A `tagId` filter names a class tag, apart from the member list's, which names a member tag.
    const name = parameter.name === 'tagId' && !/^\/api\/members(\/|$)/.test(route.path) ? 'classTagId' : parameter.name;
    const schema = parameter.schema ?? {}, id = schema.format === 'uuid' && (aim.optionalIds || parameter.required) ? idNamed(name, aim.target) : undefined;
    if (parameter.name in known && parameter.required) query.set(parameter.name, known[parameter.name]!);
    else if (id) query.set(parameter.name, id);
    else if (parameter.required) query.set(parameter.name, String(valueOf(schema, parameter.name, aim)));
  }
  const text = query.toString();
  return text ? '?' + text : '';
}

/** Records a gym's lists hold, as ID and (for records staff edit) revision: what a request aimed at the gym must leave as it was. */
export async function snapshot(gym: Context, target: Target, routes: Route[]) {
  const stable = /^\/api\/(members|households|programs|ranks|rank-systems|schedule|member-tags|staff|kiosk\/devices|waivers\/templates|billing\/(plans|tax-rates|charge-types|class-packs))(\/|$)/;
  const own: Aim = { target, optionalIds: false };
  const lists = routes.filter((route) => route.method === 'GET' && route.kind === 'staff' && !route.path.includes('{') && !/^\/api\/(dashboard|health)/.test(route.path));
  const rows: Record<string, unknown> = {};
  for (const route of lists) {
    const response = await gym.owner.request<{ data?: unknown }>(route.path + queryOf(route, own));
    if (response.status !== 200 || !Array.isArray(response.body?.data)) continue;
    const list = (response.body.data as { id?: unknown; revision?: unknown }[]).filter((row) => typeof row?.id === 'string');
    rows[route.path] = list.map((row) => stable.test(route.path) ? [row.id, row.revision] : [row.id]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }
  return rows;
}
