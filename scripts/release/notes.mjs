// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { changelogSection } from './release.mjs';
console.log(changelogSection(readFileSync('CHANGELOG.md', 'utf8'), process.argv[2] ?? ''));
