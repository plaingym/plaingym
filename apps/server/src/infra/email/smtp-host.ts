// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/** Every address a name resolves to, IPv4 first. Throws when it resolves to none. */
export type HostLookup = (host: string) => Promise<readonly string[]>;
export interface HostCheck {
  readonly lookup?: HostLookup;
  readonly isPublic?: (address: string) => boolean;
  /** The address families this machine can connect with (`machineFamilies`); tests supply their own. */
  readonly families?: () => ReadonlySet<4 | 6>;
}

const lookupLimitMs = 10_000;
/** Query both families without getaddrinfo's shared worker pool; an absent family is allowed, a failed query isn't. */
async function resolveAddresses(host: string, resolver: Resolver): Promise<readonly string[]> {
  const optional = (query: Promise<string[]>) => query.catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) return [];
    throw error;
  });
  const [v4, v6] = await Promise.all([optional(resolver.resolve4(host)), optional(resolver.resolve6(host))]);
  return [...v4, ...v6];
}

/** The only IPv6 addresses routed globally. IPv4-mapped, loopback, link-local and unique-local addresses are all outside it. */
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');
/** Private, shared, loopback, link-local, documentation, multicast and reserved ranges; for IPv6, those inside global unicast. */
const notPublic = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) notPublic.addSubnet(network, prefix, 'ipv4');
// Teredo and other IETF assignments, documentation (twice) and 6to4, which can carry a private IPv4 address.
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) notPublic.addSubnet(network, prefix, 'ipv6');

/** True only for an address on the public internet. Anything it can't read, such as a scoped IPv6 address, isn't. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !notPublic.check(address, 'ipv4');
  return family === 6 && !address.includes('%') && globalUnicast.check(address, 'ipv6') && !notPublic.check(address, 'ipv6');
}

/** The name resolved to something that isn't on the public internet, so no connection was made. */
export class SmtpHostRefusedError extends Error {
  readonly code = 'EHOSTREFUSED';
  constructor() { super('SMTP host is not a public address'); }
}

/**
 * The address families this machine has a usable interface for, as Nodemailer decides before it connects: any
 * interface that isn't loopback, though for IPv6 not a link-local address, which never reaches another network.
 */
export function machineFamilies(): ReadonlySet<4 | 6> {
  const families = new Set<4 | 6>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4') families.add(4);
      else if (entry.family === 'IPv6' && !/^fe[89ab]/i.test(entry.address)) families.add(6);
    }
  }
  return families;
}

/**
 * Resolves `host` once and returns the addresses to connect to, in the lookup's order (IPv4 first), refusing the name
 * when any answer isn't public: a name with one public and one private address would otherwise reach the private one
 * on some connections. Addresses of a family this machine has no interface for are left out, unless that leaves none.
 * The caller connects to these addresses itself, trying the next when one fails, since a second lookup could get a
 * different answer.
 */
export async function publicAddresses(host: string, check: HostCheck = {}): Promise<readonly string[]> {
  // Only gym-named servers in multi mode use this check. Single mode keeps Nodemailer's system lookup.
  const literal = isIP(host) !== 0;
  const resolver = literal || check.lookup ? undefined : new Resolver({ timeout: lookupLimitMs, tries: 1 });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('SMTP host lookup timed out'), { code: 'ETIMEDOUT' })), lookupLimitMs);
  });
  try {
    const addresses = await Promise.race([literal ? Promise.resolve([host])
      : check.lookup ? check.lookup(host) : resolveAddresses(host, resolver!), timeout]);
    const allowed = check.isPublic ?? isPublicAddress;
    if (!addresses.length || !addresses.every(allowed)) throw new SmtpHostRefusedError();
    const families = (check.families ?? machineFamilies)();
    const reachable = addresses.filter((address) => families.has(isIP(address) as 4 | 6));
    return reachable.length ? reachable : addresses;
  } finally {
    clearTimeout(timer);
    // Cancel the queries themselves, including a sibling still pending after one family failed.
    resolver?.cancel();
  }
}
