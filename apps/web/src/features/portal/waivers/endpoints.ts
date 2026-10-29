// SPDX-License-Identifier: AGPL-3.0-only
import { portalContracts as contracts } from '@plaingym/shared/contracts';

/** Payers use the household routes, which cover every current member including themselves; adult members use their own. */
export function portalWaiverEndpoints(payer: boolean) {
  return payer
    ? { pending: contracts.pendingHouseholdWaivers, signed: contracts.signedHouseholdWaivers, sign: contracts.signHouseholdWaiver, pdf: contracts.householdWaiverPdf, upload: contracts.uploadHouseholdSignature }
    : { pending: contracts.pendingWaivers, signed: contracts.signedWaivers, sign: contracts.signWaiver, pdf: contracts.waiverPdf, upload: contracts.uploadSignature };
}
export type PortalWaiverEndpoints = ReturnType<typeof portalWaiverEndpoints>;
