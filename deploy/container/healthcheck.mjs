// SPDX-License-Identifier: AGPL-3.0-only
try {
  const response = await fetch('http://127.0.0.1:3000/healthz', {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok || (await response.json()).status !== 'ok') process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
