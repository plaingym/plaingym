// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryableRequest, retryNetworkChange } from './retry.mjs';

const failure = (path = '/api/members') => ({ path, method: 'GET', error: 'net::ERR_NETWORK_CHANGED' });
function state(extra = {}) {
  return { method: 'GET', path: '/api/members', failedRequests: [], errors: [], pause: async () => {}, ...extra };
}
test('retries navigation errors without waiting for a requestfailed event', async () => {
  const options = state({ path: '/healthz' });
  let calls = 0;
  assert.equal(await retryNetworkChange(async () => {
    if (++calls === 1) throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
    return 'ok';
  }, options), 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(options.failedRequests, [failure('/healthz')]);
});
test('retries fetch when its transport event arrives after evaluate rejects', async () => {
  let calls = 0;
  const options = state({ pause: async ms => { if (ms === 0 && calls === 1) options.failedRequests.push(failure()); } });
  assert.equal(await retryNetworkChange(async () => {
    if (++calls === 1) throw new TypeError('Failed to fetch');
    return 200;
  }, options), 200);
  assert.equal(calls, 2);
});
test('sign-in is the only POST eligible for a network-change retry and recovery', async () => {
  for (const path of ['/api/auth/sign-in/email', '/api/members']) {
    let calls = 0;
    const options = state({ method: 'POST', path });
    const operation = async () => {
      if (++calls === 1) {
        options.failedRequests.push({ ...failure(path), method: 'POST' });
        throw new TypeError('Failed to fetch');
      }
      return 200;
    };
    assert.equal(retryableRequest({ ...failure(path), method: 'POST' }), path === '/api/auth/sign-in/email');
    if (path === '/api/auth/sign-in/email') assert.equal(await retryNetworkChange(operation, options), 200);
    else await assert.rejects(retryNetworkChange(operation, options), /Failed to fetch/);
    assert.equal(calls, path === '/api/auth/sign-in/email' ? 2 : 1);
  }
});
test('page loads retry only when every failed request is eligible', async () => {
  let calls = 0;
  const options = state();
  await retryNetworkChange(async () => {
    if (++calls === 1) {
      options.failedRequests.push(failure('/api/dashboard'), failure('/api/health'));
      throw new Error('page assertion timed out');
    }
  }, options);
  assert.equal(calls, 2);
});
for (const [name, failures, errors, message] of [
  ['HTTP error', [{ path: '/api/health', status: 500 }], [], 'HTTP 500'],
  ['timeout', [], [], 'Timeout 15000ms exceeded'],
  ['another transport error', [{ ...failure(), error: 'net::ERR_CONNECTION_RESET' }], [], 'Failed to fetch'],
  ['browser exception', [failure()], ['Uncaught TypeError'], 'net::ERR_NETWORK_CHANGED'],
  ['mixed HTTP and network failures', [failure(), { path: '/api/health', status: 500 }], [], 'net::ERR_NETWORK_CHANGED'],
  ['mixed transport failures', [failure(), { ...failure(), error: 'net::ERR_ABORTED' }], [], 'net::ERR_NETWORK_CHANGED'],
]) test(`does not retry ${name}`, async () => {
  let calls = 0;
  const options = state({ errors });
  const error = new Error(message);
  await assert.rejects(retryNetworkChange(async () => {
    calls++;
    options.failedRequests.push(...failures);
    throw error;
  }, options), actual => actual === error);
  assert.equal(calls, 1);
});
test('network change retries stop after three attempts', async () => {
  let calls = 0;
  const options = state();
  await assert.rejects(retryNetworkChange(async () => {
    calls++;
    options.failedRequests.push(failure());
    throw new Error('net::ERR_NETWORK_CHANGED');
  }, options), /ERR_NETWORK_CHANGED/);
  assert.equal(calls, 3);
});
