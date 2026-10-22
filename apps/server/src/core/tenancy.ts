// SPDX-License-Identifier: AGPL-3.0-only
import { domainToASCII } from 'node:url';
import { eq } from 'drizzle-orm';
import { forSystem, gymDomains, gyms } from '@plaingym/db';
import type { MiddlewareHandler } from 'hono';
import { enabledModules } from './modules.js';
import type { RequestEnvironment, GymContext } from './context.js';
export type TenancyMode = 'single' | 'multi';
export function tenancyMode(value = process.env.TENANCY ?? 'single'): TenancyMode {
  if (value !== 'single' && value !== 'multi') throw new Error('Invalid TENANCY mode');
  return value;
}
/** A Host authority, never a forwarded header or URL supplied in request data. */
export function normalizeHostname(authority: string): string | null {
  if (!authority || /[\s/@\\?#,%]/.test(authority)) return null;
  const match = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!match || (match[2] && Number(match[2]) > 65535)) return null;
  const hostname = domainToASCII(match[1]!.toLowerCase().replace(/\.$/, ''));
  if (!hostname || hostname.length > 253 || hostname.split('.').some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return hostname;
}
export function createTenantResolver(options: { mode?: TenancyMode; system?: typeof forSystem } = {}): MiddlewareHandler<RequestEnvironment> {
  const mode = options.mode ?? tenancyMode(), system = options.system ?? forSystem;
  return async (context, next) => {
    const hostname = normalizeHostname(context.req.header('host') ?? new URL(context.req.url).host);
    if (!hostname) return context.notFound();
    const gym = await system(async (tx) => {
      if (mode === 'single') {
        const rows = await tx.select({ id: gyms.id, timezone: gyms.timezone, websiteEnabled: gyms.websiteEnabled, status: gyms.status }).from(gyms).limit(2);
        return rows.length === 1 ? rows[0] : undefined;
      }
      const [row] = await tx.select({ id: gyms.id, timezone: gyms.timezone, websiteEnabled: gyms.websiteEnabled, status: gyms.status })
        .from(gymDomains).innerJoin(gyms, eq(gymDomains.gymId, gyms.id)).where(eq(gymDomains.hostname, hostname)).limit(1);
      return row;
    });
    if (!gym || gym.status !== 'active') return context.notFound();
    const resolved: GymContext = { gymId: gym.id, timezone: gym.timezone, enabledModules: enabledModules(gym) };
    context.set('context', { ...context.get('context'), gym: resolved });
    await next();
  };
}
export const resolveGym = createTenantResolver();
