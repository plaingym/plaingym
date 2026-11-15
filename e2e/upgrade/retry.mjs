// SPDX-License-Identifier: AGPL-3.0-only
const changed = 'net::ERR_NETWORK_CHANGED';
const signIn = '/api/auth/sign-in/email';
export const retryableRequest = ({ method, path, error }) => error === changed
  && (method === 'GET' || (method === 'POST' && path === signIn));

/** Retry only the Docker network-generation error, including events delivered after evaluate rejects. */
export async function retryNetworkChange(operation, { method, path, failedRequests, errors,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  for (let attempt = 0; ; attempt++) {
    const firstFailure = failedRequests.length;
    try { return await operation(firstFailure); }
    catch (error) {
      // Let Playwright deliver requestfailed before classifying a generic fetch rejection.
      await pause(0);
      const failures = failedRequests.slice(firstFailure);
      const textMatches = String(error).includes(changed);
      if (attempt >= 2 || errors.length || !retryableRequest({ method, path, error: changed })
        || failures.some(failure => !retryableRequest(failure)) || (!textMatches && !failures.length)) throw error;
      // Navigation errors can carry the transport reason before the event is observed. Keep them in the report too.
      if (textMatches && !failures.length) failedRequests.push({ path, method, error: changed });
      await pause(500);
    }
  }
}
