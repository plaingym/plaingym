// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { AppError } from '@plaingym/shared';
import { setupContracts } from '@plaingym/shared/contracts';
import { restoreStagingDirectory } from '../../core/maintenance-credentials.js';
import { route } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { setupService, type createSetupService } from './setup.js';
import { defaultSetupRestore, type createSetupRestore } from './setup.restore.js';
import { importStep, type ImportStep } from './import-step.js';

type Service = ReturnType<typeof createSetupService>;
function owner(c: Context<RequestEnvironment>): MutationContext {
  const { gym, principal } = c.get('context');
  if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
  if (!principal.roles.includes('owner')) throw new AppError('forbidden', 'Owner access required');
  return { gymId: gym.gymId, actor: { kind: 'user', userId: principal.userId } };
}
/** Finishing (step 8) goes through the import step, which hands fresh starts back to the setup service. */
export function createSetupRoutes(getService: () => Service = setupService,
  providedRestore?: () => ReturnType<typeof createSetupRestore>, getImportStep: () => ImportStep = importStep) {
  let restore: ReturnType<typeof createSetupRestore> | undefined;
  const getRestore = () => providedRestore?.() ?? (restore ??= defaultSetupRestore(getService()));
  const recover = async () => { if (providedRestore || restoreStagingDirectory()) await getRestore().recover(); };
  const { status, start, owner: account, restore: begin, restoreStatus } = setupContracts;
  const response = <T>(schema: T) => ({ 200: { description: 'Setup result', content: { 'application/json': { schema } } } });
  const body = <T>(schema: T) => ({ body: { required: true as const, content: { 'application/json': { schema } } } });
  return [
    route({ ...status, responses: response(status.response) }, async (c) => { await recover(); return c.json({ data: await getService().status() }, 200); }),
    route({ ...start, request: body(start.body), responses: response(start.response) }, async (c) => { await recover(); return c.json({ data: await getService().start() }, 200); }),
    route({ ...account, request: body(account.body), responses: response(account.response) }, async (c) => { await recover(); return c.json({ data: await getService().owner(c.req.valid('json')) }, 200); }),
    route({ ...begin, request: body(begin.body), responses: response(begin.response) }, async (c) => c.json({ data: await getRestore().start(c.req.valid('json')) }, 200)),
    route({ ...restoreStatus, request: { params: restoreStatus.params }, responses: response(restoreStatus.response) }, async (c) => c.json({ data: await getRestore().status(c.req.valid('param').jobId) }, 200)),
    ...(['gym', 'packs', 'website', 'smtp', 'stripe', 'backups', 'confirmBackupKey', 'finish'] as const).map((name) => {
      const contract = setupContracts[name];
      return route({ ...contract, request: body(contract.body), responses: response(contract.response) }, async (c) => {
        const context = owner(c), input = c.req.valid('json');
        const service = getService();
        switch (name) {
          case 'gym': return c.json({ data: await service.gym(context, setupContracts.gym.body.parse(input)) }, 200);
          case 'packs': return c.json({ data: await service.packs(context, setupContracts.packs.body.parse(input)) }, 200);
          case 'website': return c.json({ data: await service.website(context, setupContracts.website.body.parse(input)) }, 200);
          case 'smtp': return c.json({ data: await service.smtp(context, setupContracts.smtp.body.parse(input)) }, 200);
          case 'stripe': return c.json({ data: await service.stripe(context, setupContracts.stripe.body.parse(input)) }, 200);
          case 'backups': return c.json({ data: await service.backups(context, setupContracts.backups.body.parse(input)) }, 200);
          case 'confirmBackupKey': return c.json({ data: await service.confirmBackupKey(context, setupContracts.confirmBackupKey.body.parse(input)) }, 200);
          case 'finish': return c.json({ data: await getImportStep().finish(service, context, setupContracts.finish.body.parse(input)) }, 200);
        }
      });
    }),
  ];
}
export const routes = createSetupRoutes();
