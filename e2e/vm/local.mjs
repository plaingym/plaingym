// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = fileURLToPath(new URL('./', import.meta.url));
const directory = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '../coverage/vm-local-' + Date.now());
await mkdir(directory, { recursive: true });
const previousFile = resolve(directory, 'config.json');
const previous = existsSync(previousFile) ? JSON.parse(await readFile(previousFile, 'utf8')) : undefined;
const savedEnvironment = existsSync(resolve(directory,'compose.env'))
  ? Object.fromEntries((await readFile(resolve(directory,'compose.env'),'utf8')).split(/\r?\n/).filter(Boolean).map((line)=>{const separator=line.indexOf('=');return [line.slice(0,separator),line.slice(separator+1)];})) : {};
function command(binary, args, options = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(binary, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.on('error', fail);
    child.on('exit', (code) => code === 0 ? ok() : fail(new Error(binary + ' exited ' + code)));
  });
}
const key = resolve(directory, 'id_ed25519');
if (!existsSync(key)) await command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
const publicKey = (await readFile(key + '.pub', 'utf8')).trim();
// Local DNS + ACME substitute. install.sh still verifies HTTPS without curl -k.
const trust = [
  '#!/bin/sh', 'set -eu', "printf '127.0.0.1 gym.localhost\\n' >> /etc/hosts",
  'while :; do',
  '  id=$(docker ps -q --filter label=com.docker.compose.service=caddy 2>/dev/null || true)',
  '  if [ -n "$id" ] && docker cp "$id:/data/caddy/pki/authorities/local/root.crt" /usr/local/share/ca-certificates/qa-caddy.crt 2>/dev/null; then',
  '    update-ca-certificates; exit', '  fi', '  sleep 2', 'done', '',
].join('\n');
for (const name of ['source', 'restore']) {
  const seed = resolve(directory, name);
  await mkdir(seed, { recursive: true });
  if (existsSync(resolve(seed,'user-data')) && existsSync(resolve(seed,'meta-data'))) continue;
  await writeFile(resolve(seed, 'user-data'), [
    '#cloud-config', '# SPDX-License-Identifier: AGPL-3.0-only',
    'ssh_pwauth: false', 'disable_root: false', 'users:', '  - name: root',
    '    ssh_authorized_keys: [' + JSON.stringify(publicKey) + ']',
    'write_files:', '  - path: /root/qa-trust.sh', "    permissions: '0700'", '    content: |',
    ...trust.trimEnd().split('\n').map((line) => '      ' + line),
    'runcmd:', "  - [sh, -c, 'nohup sh /root/qa-trust.sh >/root/qa-trust.log 2>&1 &']", '',
  ].join('\n'));
  await writeFile(resolve(seed, 'meta-data'), 'instance-id: qa-' + name + '-' + Date.now() + '\nlocal-hostname: qa-' + name + '\n');
}
const env = { ...savedEnvironment, ...process.env, VM_SEEDS: directory.replaceAll('\\', '/'),
  VM_S3_USER: previous?.s3.accessKeyId ?? 'qa' + randomBytes(8).toString('hex'), VM_S3_PASSWORD: previous?.s3.secretAccessKey ?? randomBytes(24).toString('hex') };
const sourceSsh = Number(env.VM_SOURCE_SSH_PORT ?? 2241), restoreSsh = Number(env.VM_RESTORE_SSH_PORT ?? 2242);
const sourceHttps = Number(env.VM_SOURCE_HTTPS_PORT ?? 443), restoreHttps = Number(env.VM_RESTORE_HTTPS_PORT ?? 443);
const project = process.argv[3] ?? 'plaingym-vm-' + randomBytes(4).toString('hex');
if (previous?.project && previous.project !== project) throw new Error('The retained disks belong to a different fixture project');
const compose = ['compose', '-p', project, '-f', resolve(here, 'compose.local.yaml')];
await command('docker',['volume','create',env.VM_CACHE_VOLUME ?? 'plaingym-vm-cloud-images']);
await command('docker', [...compose, 'up', '-d', '--build'], { env });
await command('docker', [...compose, 'exec', '-T', 's3', 'python', '-c',
  "import boto3,time; time.sleep(2); boto3.client('s3', endpoint_url='http://127.0.0.1:9000', aws_access_key_id='qa', aws_secret_access_key='qa', region_name='us-east-1').create_bucket(Bucket='qa-backups')"], { env });
// ssh-keyscan is confined to the newly created loopback guests. Remote runs
// require a host key already trusted by the operator.
const knownHosts = resolve(directory, 'known_hosts');
let keys = '';
for (const port of [sourceSsh, restoreSsh]) {
  await new Promise((ok, fail) => {
    const deadline = Date.now() + Number(env.VM_BOOT_TIMEOUT_MS ?? 1_800_000);
    const attempt = () => {
      const scanner = process.env.SSH_KEYSCAN ?? (process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/ssh-keyscan.exe')
        ? 'C:/Program Files/Git/usr/bin/ssh-keyscan.exe' : 'ssh-keyscan');
      const child = spawn(scanner, ['-T', '3', '-p', String(port), '-t', 'ed25519', '127.0.0.1'], { windowsHide: true });
      let result = '';
      child.stdout.on('data', (data) => { result += data; });
      child.on('error', fail);
      child.on('exit', (code) => {
        if (code === 0 && result.includes('ssh-ed25519')) { keys += result; ok(); }
        else if (Date.now() > deadline) fail(new Error('Local guest did not boot; inspect docker compose logs'));
        else setTimeout(attempt, 3000);
      });
    };
    attempt();
  });
}
await writeFile(knownHosts, keys);
const gateway = await new Promise((ok, fail) => {
  const child = spawn('docker', ['inspect', project + '-source-1', '--format', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'], { windowsHide: true });
  let value = ''; child.stdout.on('data', (data) => { value += data; });
  child.on('error', fail); child.on('exit', (code) => code === 0 ? ok(value.trim()) : fail(new Error('Cannot inspect fixture gateway')));
});
const target = (port, address, connectPort) => ({ url: 'https://gym.localhost', address, connectPort, fresh: true,
  ssh: { host: '127.0.0.1', port, user: 'root', identity: key, knownHosts } });
const config = previous ?? { localFixture: true, localGateway: gateway, source: target(sourceSsh, '127.0.0.1', sourceHttps), restore: target(restoreSsh, '127.0.0.2', restoreHttps),
  bundle: { file: resolve(here, '../../deploy/dist/plaingym-amd64.tar') },
  email: 'qa@example.org', s3: { endpoint: 'http://10.0.2.2:9000', region: 'auto', bucket: 'qa-backups',
    accessKeyId: env.VM_S3_USER, secretAccessKey: env.VM_S3_PASSWORD },
  artifacts: directory, project };
await writeFile(resolve(directory, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
await writeFile(resolve(directory, 'compose.env'), ['VM_SEEDS=' + env.VM_SEEDS, 'VM_S3_USER=' + env.VM_S3_USER, 'VM_S3_PASSWORD=' + env.VM_S3_PASSWORD,
  'VM_SOURCE_SSH_PORT=' + sourceSsh, 'VM_RESTORE_SSH_PORT=' + restoreSsh, 'VM_SOURCE_HTTPS_PORT=' + sourceHttps, 'VM_RESTORE_HTTPS_PORT=' + restoreHttps,
  'VM_CACHE_VOLUME=' + (env.VM_CACHE_VOLUME ?? 'plaingym-vm-cloud-images'), ''].join('\n'), { mode: 0o600 });
console.log('Local VM config: ' + resolve(directory, 'config.json') + '\nCompose project: ' + project + '\nAfter local QA, take this project down with --volumes; its shared cloud-image cache is external.');
