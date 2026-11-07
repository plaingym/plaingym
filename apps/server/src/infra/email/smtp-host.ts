// SPDX-License-Identifier: AGPL-3.0-only
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Every address a name resolves to, IPv4 first. Throws when it resolves to none. */
export type HostLookup = (host: string) => Promise<readonly string[]>;
export interface HostCheck {
  readonly lookup?: HostLookup;
  readonly isPublic?: (address: string) => boolean;
}

const lookupLimitMs = 10_000;
const systemLookup: HostLookup = async (host) => (await lookup(host, { all: true, order: 'ipv4first' })).map((found) => found.address);

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
 * Resolves `host` once and returns the address to connect to, refusing the name when any answer isn't public: a name
 * with one public and one private address would otherwise reach the private one on some connections. The caller
 * connects to the returned address itself, since a second lookup could get a different answer.
 */
export async function publicAddress(host: string, check: HostCheck = {}): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('SMTP host lookup timed out'), { code: 'ETIMEDOUT' })), lookupLimitMs);
  });
  try {
    const addresses = await Promise.race([(check.lookup ?? systemLookup)(host), timeout]);
    const allowed = check.isPublic ?? isPublicAddress;
    if (!addresses.length || !addresses.every(allowed)) throw new SmtpHostRefusedError();
    return addresses[0]!;
  } finally { clearTimeout(timer); }
}
