// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { installContracts } from '@plaingym/shared/contracts';
import { cspReportPath, reportingEndpoints, contentSecurityPolicy } from './csp.js';
import { uploadDownloadPath } from '../infra/storage/runtime.js';
import { stripeProvisioner } from '../infra/payments/setup.js';
import { StripeFixtures } from '../infra/payments/stripe-fixtures.js';

it('uses install contract paths for reporting, downloads and registered Stripe endpoints', async () => {
  expect(cspReportPath).toBe(installContracts.cspReport.path);
  expect(reportingEndpoints).toContain(`"${installContracts.cspReport.path}"`);
  expect(contentSecurityPolicy({ nonce: 'nonce' })).toContain(`report-uri ${installContracts.cspReport.path}`);
  expect(uploadDownloadPath).toBe(installContracts.uploadDownload.path);
  const gymId = '00000000-0000-7000-8000-000000000001', origin = 'https://gym.invalid';
  const transport = new StripeFixtures(gymId);
  const registered = await stripeProvisioner(transport).register(gymId, origin, 1);
  const endpoint = await transport.request({ method: 'GET', path: '/v1/webhook_endpoints/' + registered.endpointId });
  expect(new URL(endpoint.url as string).pathname).toBe(installContracts.stripeWebhook.path);
});
