// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { InvoicePage } from '../../../../features/billing/invoices/page.js';
export const Route = createFileRoute('/admin/billing/invoices/$invoiceId')({ component: DetailPage });
function DetailPage() { return <InvoicePage invoiceId={Route.useParams().invoiceId}/>; }
