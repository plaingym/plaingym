// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';

/** The production smoke test on `previousImage`, started on a database `image` migrated first. */
export function smokePreviousImage(previousImage, image) {
  const configuration = JSON.parse(execFileSync('docker', ['image', 'inspect', previousImage], { encoding: 'utf8' }))[0];
  const variable = (key) => configuration.Config.Env.find((entry) => entry.startsWith(key + '='))?.slice(key.length + 1);
  execFileSync(process.execPath, ['deploy/test/smoke.mjs', previousImage], { stdio: 'inherit', timeout: 900_000,
    env: { ...process.env, SMOKE_MIGRATE_IMAGE: image, VERSION: variable('APP_VERSION'), SOURCE_URL: variable('SOURCE_URL') } });
}
