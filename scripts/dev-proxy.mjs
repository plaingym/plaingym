// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const certificate = join(root, 'data/dev-proxy/root.crt');
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 30_000 });

try {
  const action = process.argv[2];
  if (process.argv.length > 3 || (action && !['--export', '--remove'].includes(action))) {
    throw new Error('Usage: node scripts/dev-proxy.mjs [--export | --remove]');
  }
  if (action !== '--remove') {
    mkdirSync(dirname(certificate), { recursive: true });
    run('docker', ['compose', '-p', 'plaingym-dev-proxy', '-f', 'compose.dev-proxy.yaml', 'cp',
      'caddy:/data/caddy/pki/authorities/local/root.crt', certificate]);
    console.log(`Exported local CA to ${certificate}`);
  }
  if (action !== '--export') {
    const ca = new X509Certificate(readFileSync(certificate));
    const fingerprint = ca.fingerprint.replaceAll(':', '');
    const remove = action === '--remove';
    if (process.platform === 'win32') {
      run('certutil.exe', remove ? ['-delstore', '-user', 'Root', fingerprint] : ['-addstore', '-user', 'Root', certificate]);
    } else if (process.platform === 'darwin') {
      const keychain = join(homedir(), 'Library/Keychains/login.keychain-db');
      run('security', remove ? ['delete-certificate', '-t', '-Z', fingerprint, keychain] :
        ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, certificate]);
    } else if (process.platform === 'linux') {
      // Chromium uses the legacy NSS store when it exists, otherwise the newer path.
      const legacy = join(homedir(), '.pki/nssdb');
      const database = existsSync(legacy) ? legacy : join(homedir(), '.local/share/pki/nssdb');
      const dbArgs = ['-d', `sql:${database}`];
      if (!remove && !existsSync(join(database, 'cert9.db'))) {
        mkdirSync(database, { recursive: true });
        run('certutil', [...dbArgs, '-N', '--empty-password']);
      }
      const nickname = `PlainGym development CA ${fingerprint}`;
      run('certutil', [...dbArgs, ...(remove ? ['-D', '-n', nickname] :
        ['-A', '-t', 'C,,', '-n', nickname, '-i', certificate])]);
    } else {
      throw new Error('Import the exported CA into your user trust store manually.');
    }
    console.log(`Local CA ${remove ? 'removed' : 'trusted'}. Fully quit and restart Chrome.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
