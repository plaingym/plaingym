// SPDX-License-Identifier: AGPL-3.0-only
export const root: string;
export const releasePattern: RegExp;
export function git(args: string[], cwd?: string): string;
export function buildInfo(cwd?: string, env?: NodeJS.ProcessEnv): { version: string; commit: string };
