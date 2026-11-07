// SPDX-License-Identifier: AGPL-3.0-only
import type { MutationContext } from '../../core/interfaces/common.js';
import { logError } from '../../core/log.js';
import type { createGoLiveService } from '../../areas/settings/go-live.js';

/** Log restoration separately, returning its failure so a seed's original error retains precedence. */
export async function restoreSeedBilling(switches: ReturnType<typeof createGoLiveService>, actor: MutationContext, event: string) {
  try {
    const current = await switches.checklist(actor.gymId);
    await switches.update(actor, { revision: current.revision, billingEnabled: false });
    return undefined;
  } catch (error) {
    logError(event, { gymId: actor.gymId }, error);
    return { error };
  }
}
