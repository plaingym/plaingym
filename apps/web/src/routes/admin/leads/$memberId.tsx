// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { LeadPage } from '../../../features/leads/lead.js';
export const Route = createFileRoute('/admin/leads/$memberId')({ component: Lead });
function Lead() { const { memberId } = Route.useParams(); return <LeadPage memberId={memberId} />; }
