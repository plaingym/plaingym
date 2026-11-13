// SPDX-License-Identifier: AGPL-3.0-only
export const leadMemberStatuses = ['prospect', 'trial'] as const;
export function isLeadMember(status: string): boolean {
  return (leadMemberStatuses as readonly string[]).includes(status);
}
export const openLeadStages = ['new', 'contacted', 'trial_booked', 'trial_attended'] as const;
