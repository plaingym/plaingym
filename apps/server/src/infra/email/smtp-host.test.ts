// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicAddress, machineFamilies, publicAddresses, SmtpHostRefusedError } from './smtp-host.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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
  it('checks address literals without a DNS query, and refuses the loopback name', async () => {
    const query4 = vi.spyOn(Resolver.prototype, 'resolve4'), query6 = vi.spyOn(Resolver.prototype, 'resolve6');
    await expect(publicAddresses('127.0.0.1')).rejects.toBeInstanceOf(SmtpHostRefusedError);
    await expect(publicAddresses('::1')).rejects.toBeInstanceOf(SmtpHostRefusedError);
    await expect(publicAddresses('93.184.216.34')).resolves.toEqual(['93.184.216.34']);
    await expect(publicAddresses(v6, { families: both })).resolves.toEqual([v6]);
    expect(query4).not.toHaveBeenCalled(); expect(query6).not.toHaveBeenCalled();
    query4.mockRejectedValue(Object.assign(new Error('no answer'), { code: 'ENOTFOUND' }));
    query6.mockRejectedValue(Object.assign(new Error('no answer'), { code: 'ENOTFOUND' }));
    await expect(publicAddresses('localhost')).rejects.toBeInstanceOf(SmtpHostRefusedError);
  });
  it('resolves both families using a cancellable resolver and checks all answers before choosing a family', async () => {
    const query4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue([v4]);
    const query6 = vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([v6]);
    const cancel = vi.spyOn(Resolver.prototype, 'cancel');
    await expect(publicAddresses('mail.example.test', { families: both })).resolves.toEqual([v4, v6]);
    expect(query4).toHaveBeenCalledWith('mail.example.test');
    expect(query6).toHaveBeenCalledWith('mail.example.test');
    expect(cancel).toHaveBeenCalledTimes(1);
    query6.mockResolvedValue(['fd00::1']);
    await expect(publicAddresses('mail.example.test', { families: () => new Set([4] as const) })).rejects.toBeInstanceOf(SmtpHostRefusedError);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(query4.mock.contexts[0]).toBe(query6.mock.contexts[0]);
    expect(query4.mock.contexts[1]).not.toBe(query4.mock.contexts[0]);
    expect(cancel.mock.contexts).toEqual(query4.mock.contexts);
  });
  it.each(['ENODATA', 'ENOTFOUND'])('accepts an absent address family (%s) but fails closed on other DNS errors', async (code) => {
    const query4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue([v4]);
    const query6 = vi.spyOn(Resolver.prototype, 'resolve6').mockRejectedValue(Object.assign(new Error('no answer'), { code }));
    await expect(publicAddresses('mail.example.test', { families: both })).resolves.toEqual([v4]);
    query4.mockRejectedValue(Object.assign(new Error('no answer'), { code })); query6.mockResolvedValue([v6]);
    await expect(publicAddresses('mail.example.test', { families: both })).resolves.toEqual([v6]);
    const failure = Object.assign(new Error('nameserver failed'), { code: 'ESERVFAIL' });
    query4.mockRejectedValue(failure);
    await expect(publicAddresses('mail.example.test', { families: both })).rejects.toBe(failure);
  });
  it('cancels both slow DNS queries by the deadline and leaves no pending resolver work', async () => {
    vi.useFakeTimers();
    const active = new Set<(error: Error) => void>();
    const pendingQuery = () => new Promise<never>((_resolve, reject) => { active.add(reject); });
    vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation(pendingQuery);
    vi.spyOn(Resolver.prototype, 'resolve6').mockImplementation(pendingQuery);
    const cancel = vi.spyOn(Resolver.prototype, 'cancel').mockImplementation(() => {
      for (const reject of active) reject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
      active.clear();
    });
    const result = expect(publicAddresses('slow.example.test')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(active.size).toBe(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a pending sibling query when the other family fails', async () => {
    const failure = Object.assign(new Error('nameserver failed'), { code: 'ESERVFAIL' });
    vi.spyOn(Resolver.prototype, 'resolve4').mockRejectedValue(failure);
    let reject6: (error: Error) => void = () => {};
    vi.spyOn(Resolver.prototype, 'resolve6').mockImplementation(() => new Promise<never>((_resolve, reject) => { reject6 = reject; }));
    const cancel = vi.spyOn(Resolver.prototype, 'cancel').mockImplementation(() => reject6(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' })));
    await expect(publicAddresses('mail.example.test')).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledTimes(1);
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
