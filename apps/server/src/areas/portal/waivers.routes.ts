// SPDX-License-Identifier: AGPL-3.0-only
import { bodyLimit } from 'hono/body-limit';
import { AppError } from '@plaingym/shared';
import { portalContracts as contracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { rateLimit } from '../../core/rate-limit.js';
import { portalIdentity } from './auth.permissions.js';
import { ok } from './household.js';
import { createPortalWaiverService, type PortalWaiverScope, type PortalWaiverService } from './waivers.js';
import type { WaiversService } from '../waivers/waivers.js';

let configured: WaiversService | undefined;
/** Runtime passes the waiver service it composes with the gym's file storage. */
export function configurePortalWaivers(waivers: WaiversService) { configured = waivers; }
const limit = () => bodyLimit({ maxSize: 400_000, onError: () => { throw new AppError('invalid_request', 'Request too large'); } });

export function createPortalWaiverRoutes(service: PortalWaiverService = createPortalWaiverService({ waivers: () => configured
  ?? (() => { throw new AppError('unavailable', 'Waivers are not configured'); })() })) {
  const scoped = (kind: PortalWaiverScope, names: { pending: 'pendingWaivers' | 'pendingHouseholdWaivers'; signed: 'signedWaivers' | 'signedHouseholdWaivers';
    sign: 'signWaiver' | 'signHouseholdWaiver'; pdf: 'waiverPdf' | 'householdWaiverPdf'; upload: 'uploadSignature' | 'uploadHouseholdSignature' }) => {
    const pending = contracts[names.pending], signed = contracts[names.signed], sign = contracts[names.sign], pdf = contracts[names.pdf];
    const upload = contracts[names.upload];
    return [
      route({ ...pending, request: { query: pending.query }, responses: ok('Unsigned current waivers', pending.response) }, async c => {
        c.header('Cache-Control', 'no-store');
        return c.json(await service.pending(portalIdentity(c.get('context')), kind, c.req.valid('query')), 200);
      }),
      route({ ...signed, request: { query: signed.query }, responses: ok('Signed waivers', signed.response) }, async c => {
        c.header('Cache-Control', 'no-store');
        return c.json(await service.signed(portalIdentity(c.get('context')), kind, c.req.valid('query')), 200);
      }),
      route({ ...upload, middleware: [limit(), rateLimit({ limit: 30 })], request: { body: { required: true, content: { 'application/json': { schema: upload.body } } } }, responses: ok('Uploaded signature image', upload.response) }, async c => {
        const input = c.req.valid('json'), context = c.get('context');
        c.header('Cache-Control', 'no-store');
        return c.json({ data: await service.upload(portalIdentity(context), kind, input.memberId, Buffer.from(input.pngBase64, 'base64'), context.gym.timezone) }, 200);
      }),
      route({ ...sign, middleware: [limit(), rateLimit({ limit: 30 })], request: { body: { required: true, content: { 'application/json': { schema: sign.body } } } }, responses: ok('Signed waiver', sign.response) }, async c => {
        const context = c.get('context');
        c.header('Cache-Control', 'no-store');
        return c.json({ data: await service.sign(portalIdentity(context), kind, c.req.valid('json'), { timezone: context.gym.timezone, ipAddress: context.clientIp ?? 'unknown' }) }, 200);
      }),
      route({ ...pdf, middleware: rateLimit({ limit: 10 }), request: { params: pdf.params }, responses: ok('Signed waiver PDF link', pdf.response) }, async c => {
        c.header('Cache-Control', 'no-store');
        return c.json(await service.pdf(portalIdentity(c.get('context')), kind, c.req.valid('param').signatureId), 200);
      }),
    ];
  };
  return [
    ...scoped('self', { pending: 'pendingWaivers', signed: 'signedWaivers', sign: 'signWaiver', pdf: 'waiverPdf', upload: 'uploadSignature' }),
    ...scoped('household', { pending: 'pendingHouseholdWaivers', signed: 'signedHouseholdWaivers', sign: 'signHouseholdWaiver', pdf: 'householdWaiverPdf', upload: 'uploadHouseholdSignature' }),
  ];
}
export const routes = createPortalWaiverRoutes();
