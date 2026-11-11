// SPDX-License-Identifier: AGPL-3.0-only
import * as c from '@plaingym/shared/contracts';
import { billingMutation, billingRoute } from '../catalog.routes.js';
import { createCreditLedgerService, type CreditLedgerService } from './ledger.service.js';

export function createCreditLedgerRoutes(service: CreditLedgerService = createCreditLedgerService()) {
  return [
    billingRoute(c.billingContracts.adjustClassCredits, (ctx, _p, _q, body) => service.adjust(billingMutation(ctx), body)),
    billingRoute(c.billingContracts.getClassCreditLedger, (ctx, p, query) => service.read(ctx.gym.gymId, p.memberId!, query)),
  ];
}
