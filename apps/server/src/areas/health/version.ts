// SPDX-License-Identifier: AGPL-3.0-only
import { buildInfo } from '../../../../../scripts/release/version.mjs';

declare const __BUILD_INFO__: { version: string; commit: string };
// esbuild replaces this branch at build time. tsx development computes it from the checkout once.
const built = typeof __BUILD_INFO__ === 'undefined' ? buildInfo() : __BUILD_INFO__;
export function runningVersion(env: NodeJS.ProcessEnv = process.env) {
  return { version: env.APP_VERSION || built.version, commit: env.APP_REVISION || built.commit };
}
