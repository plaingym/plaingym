// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { isPublicAddress, machineFamilies, publicAddresses, SmtpHostRefusedError } from './smtp-host.js';

describe('isPublicAddress', () => {
  it.each(['93.184.216.34', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '192.167.0.1', '223.255.255.255',
    '2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4001:81b::200e'])('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
  it.each([
    ['private', '10.0.0.1'], ['private', '172.16.0.1'], ['private', '172.31.255.255'], ['private', '192.168.1.1'],
    ['loopback', '127.0.0.1'], ['loopback', '127.255.255.254'], ['loopback', '::1'],
    ['link-local', '169.254.169.254'], ['link-local', 'fe80::1'], ['link-local', 'febf::1'],
    ['unique local', 'fc00::1'], ['unique local', 'fd12:3456:789a::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'], ['IPv4-mapped private', '::ffff:10.0.0.1'], ['IPv4-mapped link-local', '::ffff:169.254.169.254'],
    ['IPv4-mapped in hex', '::ffff:7f00:1'], ['IPv4-mapped public', '::ffff:93.184.216.34'],
    ['IPv4-compatible', '::127.0.0.1'], ['NAT64', '64:ff9b::a00:1'], ['6to4', '2002:a00:1::1'], ['Teredo', '2001:0:a00:1::1'], ['IPv6 documentation', '2001:db8::1'],
    ['unspecified', '0.0.0.0'], ['unspecified', '::'], ['shared', '100.64.0.1'], ['benchmark', '198.18.0.1'], ['documentation', '203.0.113.5'],
    ['multicast', '224.0.0.1'], ['multicast', 'ff02::1'], ['reserved', '240.0.0.1'], ['broadcast', '255.255.255.255'],
    ['a scoped address', '2606:2800:220:1::1%eth0'], ['a name', 'mail.example.test'], ['nothing', ''],
  ])('refuses %s: %s', (_kind, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('publicAddresses', () => {
  const v4 = '93.184.216.34', v6 = '2606:2800:220:1:248:1893:25c8:1946', both = () => new Set([4, 6] as const);
  it('resolves once and returns every address, in the lookup\'s order, when every one is public', async () => {
    const lookup = vi.fn(async () => [v4, '93.184.216.35', v6]);
    await expect(publicAddresses('mail.example.test', { lookup, families: both })).resolves.toEqual([v4, '93.184.216.35', v6]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('mail.example.test');
  });
  it('leaves out a family the machine has no interface for, unless that would leave nothing', async () => {
    await expect(publicAddresses('mail.example.test', { lookup: async () => [v4, v6], families: () => new Set([6] as const) })).resolves.toEqual([v6]);
    await expect(publicAddresses('mail.example.test', { lookup: async () => [v4, v6], families: () => new Set([4] as const) })).resolves.toEqual([v4]);
    await expect(publicAddresses('mail.example.test', { lookup: async () => [v6], families: () => new Set([4] as const) })).resolves.toEqual([v6]);
    // A family's absence never lets an unchecked or private answer through.
    await expect(publicAddresses('mail.example.test', { lookup: async () => [v4, 'fd00::1'], families: () => new Set([4] as const) }))
      .rejects.toBeInstanceOf(SmtpHostRefusedError);
  });
  it('reads the machine\'s families from its interfaces, without loopback', () => {
    for (const family of machineFamilies()) expect([4, 6]).toContain(family);
  });
  it('refuses a name when any address is not public, wherever it comes in the answer', async () => {
    for (const addresses of [['93.184.216.34', '10.0.0.1'], ['10.0.0.1', '93.184.216.34'], ['93.184.216.34', '::ffff:127.0.0.1']])
      await expect(publicAddresses('mail.example.test', { lookup: async () => addresses })).rejects.toBeInstanceOf(SmtpHostRefusedError);
  });
  it('refuses a name with no addresses, and passes on a failed lookup', async () => {
    await expect(publicAddresses('mail.example.test', { lookup: async () => [] })).rejects.toBeInstanceOf(SmtpHostRefusedError);
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    await expect(publicAddresses('mail.example.test', { lookup: async () => { throw failure; } })).rejects.toBe(failure);
  });
  it('checks an address given as the host through the real lookup, and the loopback name', async () => {
    await expect(publicAddresses('127.0.0.1')).rejects.toBeInstanceOf(SmtpHostRefusedError);
    await expect(publicAddresses('localhost')).rejects.toBeInstanceOf(SmtpHostRefusedError);
    await expect(publicAddresses('93.184.216.34')).resolves.toEqual(['93.184.216.34']);
  });
  it('stops waiting for a lookup that never answers', async () => {
    vi.useFakeTimers();
    try {
      const pending = publicAddresses('mail.example.test', { lookup: () => new Promise(() => {}) });
      const outcome = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;
    } finally { vi.useRealTimers(); }
  });
});
