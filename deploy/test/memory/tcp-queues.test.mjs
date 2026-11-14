// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tcpQueues } from './tcp-queues.mjs';

test('TCP queues distinguish proxy legs on IPv4 and IPv6 and ignore listeners and unrelated sockets', () => {
  const tables = ['header\n0: 0100007F:01BB 0200007F:ABCD 01 00000100:00000002\n1: 0100007F:0001 0200007F:0BB8 01 00000003:00001000\n2: 00000000:01BB 00000000:0000 0A 00000000:00000000',
    'header\n0: 00000000000000000000000000000000:01BB 00000000000000000000000000000001:ABCD 01 00000200:00000004\n1: 00:1234 00:5678 01 00000001:00000001'];
  assert.deepEqual(tcpQueues(tables), {
    downstream: { sockets: 2, sendBytes: 768, receiveBytes: 6 }, upstream: { sockets: 1, sendBytes: 3, receiveBytes: 4096 },
  });
  assert.deepEqual(tcpQueues(['header']), { downstream: { sockets: 0, sendBytes: 0, receiveBytes: 0 }, upstream: { sockets: 0, sendBytes: 0, receiveBytes: 0 } });
});
