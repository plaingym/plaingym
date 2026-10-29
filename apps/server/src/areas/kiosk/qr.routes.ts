// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { kioskContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createQrCheckin, type QrCheckin, type QrCheckinOptions } from './qr.js';

let configured: QrCheckin | undefined;
export function configureQrCheckin(options: QrCheckinOptions) { configured = createQrCheckin(options); }
export function createQrCheckinRoutes(service?: QrCheckin) {
  const fallback = createQrCheckin(), contract = kioskContracts.checkinQr;
  return [route({ ...contract, request: { body: { required: true, content: { 'application/json': { schema: contract.body } } } },
    responses: { 200: { description: 'Check-in result without private standing information', content: { 'application/json': { schema: contract.response } } } },
  }, async (c) => {
    c.header('Cache-Control', 'no-store');
    const { gym, principal } = c.get('context');
    if (principal.kind !== 'kiosk' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Device not found');
    return c.json({ data: await (service ?? configured ?? fallback).checkin(gym.gymId, principal.deviceId, c.req.valid('json')) }, 200);
  })];
}
export const routes = createQrCheckinRoutes();
