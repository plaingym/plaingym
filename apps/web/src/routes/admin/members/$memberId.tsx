// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { MemberProfile } from '../../../features/members/profile.js';
export const Route = createFileRoute('/admin/members/$memberId')({ component: Profile });
function Profile() { const { memberId } = Route.useParams(); return <MemberProfile memberId={memberId}/>; }
