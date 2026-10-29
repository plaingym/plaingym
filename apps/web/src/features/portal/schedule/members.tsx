// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PortalScheduleMember } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { Select } from '../../../components/ui/select.js';
import { portalClient, type PortalClient } from './client.js';

/** Query keys are scoped to the gym and signed-in user; the shell discards them when the household changes. */
export function usePortalKey() {
  const bootstrap = useBootstrap();
  return ['portal', bootstrap.data?.gym.id, bootstrap.data?.session?.userId] as const;
}
/** The login's role and the members it may act for, both reloaded from the server; never chosen by the browser. */
export function usePortalMembers(client: PortalClient = portalClient) {
  const key = usePortalKey(), [chosen, setChosen] = useState('');
  const context = useQuery({ queryKey: [...key, 'context'], queryFn: () => client.context(), staleTime: 0 });
  const members = useQuery({ queryKey: [...key, 'act-for'], queryFn: () => client.members(), staleTime: 0 });
  const memberId = members.data?.some(member => member.id === chosen) ? chosen : members.data?.[0]?.id ?? '';
  return { key, context, members, memberId, member: members.data?.find(member => member.id === memberId), choose: setChosen };
}
export function MemberPicker({ label, members, value, onChange }: { label: string; members: readonly PortalScheduleMember[]; value: string; onChange(id: string): void }) {
  if (members.length < 2) return null;
  return <label className="block max-w-sm space-y-1 text-sm font-medium">
    <span>{label}</span>
    <Select value={value} onChange={event => onChange(event.target.value)}>
      {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
    </Select>
  </label>;
}
