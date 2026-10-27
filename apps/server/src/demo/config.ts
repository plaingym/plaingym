// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { normalizeHostname } from '../core/tenancy.js';

export interface DemoConfig {
  enabled: boolean; domain: string; maxSandboxes: number;
  stripe?: { testKey: string; webhookSecret: string };
}
/** Run before constructing any payment, email, or upload provider. */
export function demoBootCheck(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  if (env.DEMO_MODE !== undefined && !['true', 'false'].includes(env.DEMO_MODE)) throw new Error('Invalid DEMO_MODE');
  const enabled = env.DEMO_MODE === 'true';
  if (!enabled) return { enabled, domain: '', maxSandboxes: 50 };
  if (env.TENANCY !== 'multi') throw new Error('DEMO_MODE requires TENANCY=multi');
  if (Object.values(env).some((value) => value && /(?:sk|rk|pk)_live_/i.test(value))) throw new Error('Demo mode refuses live Stripe keys');
  const testKey = env.DEMO_STRIPE_TEST_KEY;
  if (testKey && !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(testKey)) throw new Error('DEMO_STRIPE_TEST_KEY requires a Stripe test-mode secret or restricted key');
  if (testKey && !/^whsec_[A-Za-z0-9]+$/.test(env.DEMO_STRIPE_WEBHOOK_SECRET ?? '')) throw new Error('Set DEMO_STRIPE_WEBHOOK_SECRET for the shared test endpoint');
  const domain = normalizeHostname(env.DEMO_DOMAIN ?? '');
  if (!domain || domain !== env.DEMO_DOMAIN || domain.length > 200) throw new Error('Set a valid DEMO_DOMAIN');
  const maxSandboxes = Number(env.DEMO_MAX_SANDBOXES ?? 50);
  if (!Number.isSafeInteger(maxSandboxes) || maxSandboxes < 1 || maxSandboxes > 1000) throw new Error('Invalid DEMO_MAX_SANDBOXES');
  return { enabled, domain, maxSandboxes, ...(testKey ? { stripe: { testKey, webhookSecret: env.DEMO_STRIPE_WEBHOOK_SECRET! } } : {}) };
}
export function requireDemo(config: DemoConfig): void {
  if (!config.enabled) throw new AppError('not_found', 'Not found');
}
export interface SandboxSettings { sandbox: true; expiresAt: string; ready: boolean; }
export function sandboxSettings(value: unknown): SandboxSettings | null {
  if (!value || typeof value !== 'object') return null;
  const demo = (value as { demo?: unknown }).demo;
  if (!demo || typeof demo !== 'object') return null;
  const item = demo as Partial<SandboxSettings>;
  return item.sandbox === true && typeof item.expiresAt === 'string' && Number.isFinite(Date.parse(item.expiresAt)) && typeof item.ready === 'boolean'
    ? item as SandboxSettings : null;
}
