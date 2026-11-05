// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PortalScheduleMember } from '@plaingym/shared/contracts';
import { Select } from '../../../components/ui/select.js';
import { usePortalContext, usePortalScope } from '../household/api.js';
import { portalClient, type PortalClient } from './client.js';

/**
 * The open household as the page reads it once, the login's role in it (the context every page shares) and the members it may
 * act for, all reloaded from the server and checked to be the open household's; never chosen by the browser.
 */
export function usePortalMembers(client: PortalClient = portalClient) {
  const scope = usePortalScope(), [chosen, setChosen] = useState('');
  const context = usePortalContext(scope, () => client.context());
  const members = useQuery({ queryKey: [...scope.key, 'act-for'], enabled: scope.ready, queryFn: async () => scope.own(await client.members()).data, staleTime: 0 });
  const memberId = members.data?.some(member => member.id === chosen) ? chosen : members.data?.[0]?.id ?? '';
  return { scope, context, members, memberId, member: members.data?.find(member => member.id === memberId), choose: setChosen };
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
