// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: [
  'apps/server/src/infra/payments/*.test.ts', 'apps/web/src/features/setup/stripe-step.test.tsx',
], testTimeout: process.env.STRIPE_CONTRACT_MODE === 'test-api' ? 120_000 : 30_000 } });
