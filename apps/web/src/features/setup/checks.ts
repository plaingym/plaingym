// SPDX-License-Identifier: AGPL-3.0-only
import { currencySchema, googleClientValueSchema, setupGymDetailsSchema, setupOwnerRequestSchema, setupS3CredentialsSchema,
  setupSmtpRequestSchema, setupTimezoneSchema, setupWebsiteRequestSchema } from '@plaingym/shared/contracts';
import type { FieldCheck } from './field.js';

/** Any shared Zod schema: checked as the server checks the request. */
interface Schema { safeParse(value: unknown): { success: boolean } }
/** A check against the same shared schema the server uses for that request; `problem` names the message to show. */
export function schemaCheck(schema: Schema, problem: string, convert: (value: string) => unknown = (value) => value): FieldCheck {
  return (value) => schema.safeParse(convert(value)).success ? null : problem;
}

const owner = setupOwnerRequestSchema.shape, gym = setupGymDetailsSchema.shape, storage = setupS3CredentialsSchema.shape;
const smtp = setupSmtpRequestSchema.options[1].shape, website = setupWebsiteRequestSchema.options[1].shape;
/**
 * Splits Cloudflare R2's per-bucket "S3 API" address (`https://<account>.r2.cloudflarestorage.com/<bucket>`) into the
 * service endpoint and the bucket it points at. Only an `https:` URL with exactly one path segment and no query,
 * fragment or user info is an S3 API address; anything else, including a segment that can't be decoded, returns null.
 */
export function splitBucketAddress(address: string): { endpoint: string; bucket: string } | null {
  const trimmed = address.trim();
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const segment = segments[0];
  if (segments.length !== 1 || segment === undefined) return null;
  try { return { endpoint: url.origin, bucket: decodeURIComponent(segment) }; } catch { return null; }
}
const lastPathSegment = (address: string) => URL.canParse(address) ? new URL(address).pathname.split('/').filter(Boolean).at(-1) : undefined;
const fieldValue = (form: HTMLFormElement | null, name: string) => {
  const input = form?.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input.value.trim() : '';
};
const endpointCheck: FieldCheck = (value, form) => {
  const trimmed = value.trim();
  if (!storage.endpoint.safeParse(trimmed).success) return 'check.url';
  const named = fieldValue(form, 'bucket');
  if (named && lastPathSegment(trimmed) === named) return 'check.bucketPath';
  return splitBucketAddress(trimmed) !== null && named !== '' ? 'check.bucketPath' : null;
};
/** Each wizard field's format check, from the same shared schema its request uses. */
export const fieldChecks: Readonly<Record<string, FieldCheck>> = {
  ownerName: schemaCheck(owner.name, 'check.required'),
  email: schemaCheck(owner.email, 'check.email'),
  password: schemaCheck(owner.password, 'check.password'),
  gymName: schemaCheck(gym.name, 'check.required'),
  timezone: schemaCheck(setupTimezoneSchema, 'check.timezone', (value) => value.trim()),
  // The wizard sends the code in capitals.
  currency: schemaCheck(currencySchema, 'check.currency', (value) => value.trim().toUpperCase()),
  existingSiteUrl: schemaCheck(website.existingSiteUrl, 'check.url', (value) => value.trim()),
  host: schemaCheck(smtp.host, 'check.required'),
  port: schemaCheck(smtp.port, 'check.port', Number),
  username: schemaCheck(smtp.username, 'check.required'),
  smtpPassword: schemaCheck(smtp.password, 'check.required'),
  from: schemaCheck(smtp.from, 'check.email', (value) => value.trim()),
  testTo: schemaCheck(smtp.testTo, 'check.email', (value) => value.trim()),
  endpoint: endpointCheck,
  region: schemaCheck(storage.region, 'check.required'),
  bucket: schemaCheck(storage.bucket, 'check.required'),
  accessKeyId: schemaCheck(storage.accessKeyId, 'check.required'),
  secretAccessKey: schemaCheck(storage.secretAccessKey, 'check.required'),
  clientId: schemaCheck(googleClientValueSchema, 'check.googleValue'),
  clientSecret: schemaCheck(googleClientValueSchema, 'check.googleValue'),
};
