// SPDX-License-Identifier: AGPL-3.0-only
import { performance } from 'node:perf_hooks';
import { passwordAdapter } from './password.js';

const started = performance.now();
const startRss = process.memoryUsage().rss;
const samples = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
  const start = performance.now();
  const hash = await passwordAdapter.hash('benchmark-password-' + index);
  if (!await passwordAdapter.verify({ hash, password: 'benchmark-password-' + index })) throw new Error('Password round trip failed');
  return Math.round(performance.now() - start);
}));
console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch,
  requests: samples.length, concurrency: 2, argonMemoryKiBPerSlot: 19456, elapsedMs: Math.round(performance.now() - started),
  slowestRoundTripMs: Math.max(...samples), startRssMiB: Math.round(startRss / 1024 / 1024),
  rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
}));
