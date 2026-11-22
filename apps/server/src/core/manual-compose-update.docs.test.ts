// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function between(markdown: string, from: string, to: string): string {
  const start = markdown.indexOf(from);
  const end = markdown.indexOf(to, start + from.length);
  expect(start, `${from} is missing`).toBeGreaterThanOrEqual(0);
  expect(end, `${to} is missing after ${from}`).toBeGreaterThan(start);
  return markdown.slice(start, end);
}

describe('manual Compose install and update guide', () => {
  const install = read('docs/install-reference.md');
  const update = read('docs/update-by-hand.md');
  const route3 = between(install, '## Route 3: Docker Compose by hand', '## Behind a proxy or a fork');
  const timer = between(install, '### Adding the update timer', '## Behind a proxy or a fork');
  const beforeUpdate = between(update, '## Before you update', '## Update\n');

  it('copies the release signing public key into the install directory with update.sh', () => {
    const [copy = ''] = [...route3.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]!);
    const command = copy.replaceAll(/\\\n\s*/g, ' ');
    expect(command).toMatch(/cp\b[^\n]*deploy\/release-signing\.pem[^\n]*\/opt\/plaingym\//);
    expect(route3).toMatch(/`update\.sh`[^.]*`lib\.sh`[^.]*`release-signing\.pem`[^.]*beside it/s);
  });

  it('uses the key from step 1 when installing the optional timer', () => {
    expect(route3).toContain('[optional update timer]');
    expect(timer).toMatch(/release-signing\.pem[^.]*step 1|step 1[^.]*release-signing\.pem/s);
    expect(timer).not.toMatch(/when your copy[^.]*has one/i);
    expect(timer).toContain('plaingym-update.service plaingym-update.timer');
  });

  it('tells a hand install where the key must be before a manual update', () => {
    expect(beforeUpdate).toContain('/opt/plaingym/release-signing.pem');
    expect(beforeUpdate).toMatch(/copy the trusted `release-signing\.pem`[^.]*`\/opt\/plaingym\/release-signing\.pem`/s);
    expect(beforeUpdate).toMatch(/deployment files/i);
    expect(beforeUpdate).toContain('update-reference.md#the-release-signing-key');
    expect(beforeUpdate).toMatch(/fork/i);
  });
});
