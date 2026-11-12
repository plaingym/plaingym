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
 * A backup endpoint must be the service's address, not a bucket's: Cloudflare R2 shows a per-bucket "S3 API" address
 * (`https://<account>.r2.cloudflarestorage.com/<bucket>`), and with path-style requests every call then went to
 * `/<bucket>/<bucket>/…`. Refused when the path's last segment is the bucket typed in the same form.
 */
const lastPathSegment = (address: string) => URL.canParse(address) ? new URL(address).pathname.split('/').filter(Boolean).at(-1) : undefined;
const fieldValue = (form: HTMLFormElement | null, name: string) => {
  const input = form?.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input.value.trim() : '';
};
const endpointCheck: FieldCheck = (value, form) => {
  if (!storage.endpoint.safeParse(value.trim()).success) return 'check.url';
  const named = fieldValue(form, 'bucket');
  return named && lastPathSegment(value.trim()) === named ? 'check.bucketPath' : null;
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
  bucket: (value, form) => {
    if (!storage.bucket.safeParse(value).success) return 'check.required';
    return lastPathSegment(fieldValue(form, 'endpoint')) === value.trim() ? 'check.bucketInEndpoint' : null;
  },
  accessKeyId: schemaCheck(storage.accessKeyId, 'check.required'),
  secretAccessKey: schemaCheck(storage.secretAccessKey, 'check.required'),
  clientId: schemaCheck(googleClientValueSchema, 'check.googleValue'),
  clientSecret: schemaCheck(googleClientValueSchema, 'check.googleValue'),
};
