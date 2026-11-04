// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PortalScheduleMember } from '@plaingym/shared/contracts';
import { Select } from '../../../components/ui/select.js';
import { portalReady, usePortalKey } from '../household/api.js';
import { portalClient, type PortalClient } from './client.js';

/** The login's role and the members it may act for, both reloaded from the server; never chosen by the browser. */
export function usePortalMembers(client: PortalClient = portalClient) {
  const key = usePortalKey(), ready = portalReady(key), [chosen, setChosen] = useState('');
  const context = useQuery({ queryKey: [...key, 'act-for-context'], enabled: ready, queryFn: () => client.context(), staleTime: 0 });
  const members = useQuery({ queryKey: [...key, 'act-for'], enabled: ready, queryFn: () => client.members(), staleTime: 0 });
  const memberId = members.data?.some(member => member.id === chosen) ? chosen : members.data?.[0]?.id ?? '';
  return { key, ready, context, members, memberId, member: members.data?.find(member => member.id === memberId), choose: setChosen };
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
