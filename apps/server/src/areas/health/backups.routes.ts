// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { backupControlContracts } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import { createBackupControl } from './restore.backup-control.js';
import type { RequestContext } from '../../core/context.js';

const t = createTranslator(locales.en ?? {});

export function createBackupControlRoutes(control = createBackupControl()): readonly RouteRegistration[] {
  const { get, now, confirm } = backupControlContracts;
  const response = { 200: { description: 'Backup request and restore pruning hold', content: { 'application/json': { schema: get.response } } } };
  const actor = (context: RequestContext) => {
    if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) throw new AppError('not_found', t('health/backups:notFound'));
    return { gymId: context.gym.gymId, userId: context.principal.userId };
  };
  return [
    route({ ...get, responses: response }, async c => {
      const who = actor(c.get('context'));
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await control.get(who.gymId) }, 200);
    }),
    route({ ...now, request: { body: { required: true, content: { 'application/json': { schema: now.body } } } }, responses: response }, async c => {
      const who = actor(c.get('context'));
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await control.request(who, c.req.valid('json').requestId) }, 200);
    }),
    route({ ...confirm, request: { body: { required: true, content: { 'application/json': { schema: confirm.body } } } }, responses: response }, async c => {
      const who = actor(c.get('context'));
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await control.confirm(who, c.req.valid('json').revision) }, 200);
    }),
  ];
}
export const routes = createBackupControlRoutes();
