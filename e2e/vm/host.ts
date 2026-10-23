// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export interface Target {
  url: string; address?: string; connectPort?: number; fresh: boolean;
  ssh: { host: string; port?: number; user: string; identity?: string; knownHosts?: string };
}
export interface Config {
  localFixture?: boolean; localGateway?: string; resume?: boolean; localSnapshotRetry?: boolean;
  source: Target; restore: Target;
  /** A bundle from deploy/test/prepare-bundle.ps1. Remote runs install from its HTTPS URLs, exactly as an operator does. */
  email: string; bundle: { file: string; url?: string; bootstrapUrl?: string };
  s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  artifacts: string;
}
export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function configuration(): Promise<Config> {
  if(!process.env.E2E_VM_CONFIG) throw new Error('Use node run.mjs --vm PRIVATE_CONFIG_JSON');
  const config = JSON.parse((await readFile(process.env.E2E_VM_CONFIG, 'utf8')).replace(/^\uFEFF/, '')) as Config;
  if(config.localGateway && (!config.localFixture || !/^\d{1,3}(\.\d{1,3}){3}$/.test(config.localGateway))) throw new Error('The fixture gateway is local-only');
  if(config.localSnapshotRetry && !config.localFixture) throw new Error('Snapshot retry is local-only');
  const base = dirname(resolve(process.env.E2E_VM_CONFIG));
  for(const target of [config.source, config.restore]) {
    const url = new URL(target.url);
    if(url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash)
      throw new Error('VM URLs must be canonical HTTPS origins on port 443');
    if(target.fresh !== true || !/^[a-zA-Z0-9.:[\]-]+$/.test(target.ssh.host) || target.ssh.host.startsWith('-') || !/^[a-z_][a-z0-9_-]*$/.test(target.ssh.user))
      throw new Error('Expected explicit fresh:true and a valid SSH host/user');
    if(target.ssh.port !== undefined && (!Number.isInteger(target.ssh.port) || target.ssh.port < 1 || target.ssh.port > 65535)) throw new Error('Invalid SSH port');
    if(target.address && !/^[0-9a-fA-F:.]+$/.test(target.address)) throw new Error('Connection address must be an IP');
    if(target.connectPort !== undefined && (!config.localFixture || !Number.isInteger(target.connectPort) || target.connectPort < 1 || target.connectPort > 65535)) throw new Error('Connection-port overrides are local-only');
    if(config.localFixture && (!/^127\.0\.0\.\d+$/.test(target.address ?? '') || target.ssh.host !== '127.0.0.1'))
      throw new Error('The local TLS exception is restricted to loopback guests');
    if(target.ssh.identity) target.ssh.identity = resolve(base, target.ssh.identity);
    if(target.ssh.knownHosts) target.ssh.knownHosts = resolve(base, target.ssh.knownHosts);
  }
  if(config.source.ssh.host === config.restore.ssh.host && (config.source.ssh.port ?? 22) === (config.restore.ssh.port ?? 22)) throw new Error('Restore requires a second fresh host');
  if(new URL(config.source.url).hostname !== new URL(config.restore.url).hostname) throw new Error('Restore retains the gym hostname; use address to test the second VM before switching DNS');
  if(!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(config.email)) throw new Error('Expected an ACME email');
  for(const value of Object.values(config.s3)) if(typeof value !== 'string' || !value) throw new Error('Missing S3 input');
  config.bundle = { ...config.bundle, file: resolve(base, config.bundle.file) };
  if(!(await stat(config.bundle.file)).isFile()) throw new Error('Expected a bundle file');
  for(const url of [config.bundle.url, config.bundle.bootstrapUrl])
    if(url !== undefined && !/^https:\/\/[^\s']+$/.test(url)) throw new Error('Bundle URLs must be HTTPS');
  if(!config.localFixture && (!config.bundle.url || !config.bundle.bootstrapUrl))
    throw new Error('A remote install runs the operator command: set bundle.url and bundle.bootstrapUrl');
  config.artifacts = resolve(base, config.artifacts);
  await mkdir(config.artifacts, { recursive: true });
  return config;
}
function options(target: Target) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    ...(target.ssh.identity ? ['-i', target.ssh.identity] : []),
    ...(target.ssh.knownHosts ? ['-o', 'UserKnownHostsFile=' + target.ssh.knownHosts] : [])];
}
export function processResult(binary: string, args: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise((ok, fail) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (data: Buffer) => { out += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { out += data.toString(); });
    child.stdin.on('error', () => { });
    const timer = setTimeout(() => { child.kill(); fail(new Error(binary + ' timed out')); }, 30 * 60_000);
    child.on('error', (error) => { clearTimeout(timer); fail(error); });
    child.on('exit', (code) => { clearTimeout(timer); ok({ code: code ?? 255, out }); });
    child.stdin.end(input);
  });
}
export const ssh = (target: Target, script: string) => processResult('ssh', [...options(target), '-p', String(target.ssh.port ?? 22),
target.ssh.user + '@' + target.ssh.host, 'sudo -n sh -s'], script);
export async function checked(target: Target, script: string): Promise<string> {
  const result = await ssh(target, script);
  if(result.code !== 0) throw new Error('Remote QA operation failed (retain output in private artifacts)');
  return result.out.trim();
}
export const compose = (args: string) => 'docker compose --project-directory /opt/plaingym --env-file /opt/plaingym/.env -f /opt/plaingym/compose.yaml ' + args;
export const sql = (query: string) => compose('exec -T postgres psql -X -U postgres -d plaingym -v ON_ERROR_STOP=1 -Atc ' + quote(query));

export interface InstallEvidence { setupLink: string; findings: string[]; before: string; rerunCode: number; sourceHash: string; hostChecks: string; configurationUnchanged: boolean; installCommand: string }
const remote = '/root/plaingym-qa';
const redact = (output: string) => output.replace(/#token=[^\s]+/g, '#token=[redacted]');
function bundleSha256(file: string) {
  return new Promise<string>((ok, fail) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', fail).on('data', (chunk) => hash.update(chunk)).on('end', () => ok(hash.digest('hex')));
  });
}
const operatorUrls = (config: Config) => !config.localFixture && config.bundle.url && config.bundle.bootstrapUrl
  ? { bundle: config.bundle.url, bootstrap: config.bundle.bootstrapUrl } : undefined;
/** Puts the bundle and bootstrap on the host for the preflight probes; the local fixture also installs from them. */
async function stage(config: Config, target: Target) {
  await checked(target, 'install -d -m 0700 ' + remote);
  const urls = operatorUrls(config);
  if(urls) {
    const download = (url: string, file: string) => "curl --fail --silent --show-error --location --proto '=https' " + quote(url) + ' -o ' + remote + '/' + file;
    await checked(target, ['set -eu', download(urls.bundle, 'bundle.tar'), download(urls.bootstrap, 'bootstrap.sh'), ''].join('\n'));
    return;
  }
  const bootstrap = fileURLToPath(new URL('../../deploy/bootstrap.sh', import.meta.url));
  for(const [file, name] of [[config.bundle.file, 'bundle.tar'], [bootstrap, 'bootstrap.sh']]) {
    const result = await processResult('scp', [...options(target), '-P', String(target.ssh.port ?? 22), file,
      target.ssh.user + '@' + target.ssh.host + ':/tmp/qa-' + name]);
    if(result.code !== 0) throw new Error('Maintainer bundle transfer failed');
    await checked(target, 'mv /tmp/qa-' + name + ' ' + remote + '/' + name + '; chmod 0600 ' + remote + '/' + name);
  }
  // Local ACME stand-in only: Caddy uses its internal CA, which the guest trusts. The bundle is otherwise unchanged.
  if(config.localFixture) await checked(target, [
    'set -eu', 'staging=$(mktemp -d /root/qa-bundle.XXXXXXXX)', 'tar -xf ' + remote + '/bundle.tar -C "$staging"',
    "sed -i '/encode zstd gzip/a\\\ttls internal' \"$staging/deploy/Caddyfile\"",
    'tar -cf ' + remote + '/bundle.tar -C "$staging" deploy', 'rm -rf -- "$staging"', '',
  ].join('\n'));
}
/** The bootstrap run against the staged bundle, verified by its own checksum. */
const stagedCommand = (args: string) => 'sh ' + remote + '/bootstrap.sh --bundle-file ' + remote + '/bundle.tar --sha256 "$(sha256sum '
  + remote + "/bundle.tar | cut -d ' ' -f1)\" -- " + args;
export async function provision(config: Config, target: Target, name: string): Promise<InstallEvidence> {
  const evidenceFile = resolve(config.artifacts, name + '-install.json');
  // QEMU preserves the outer client's source address. Keep the outer bridge
  // gateway reachable after the guest creates its own Docker bridge subnets.
  if(config.localFixture && config.localGateway) await checked(target, 'ip route replace ' + quote(config.localGateway + '/32') + ' via 10.0.2.2\n');
  if(config.resume) {
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8')) as InstallEvidence & { preflight?: { validHost: number } };
    if(evidence.hostChecks && evidence.preflight?.validHost === 97) return evidence;
    return auditInstall(config, target, name, evidence);
  }
  const baseline = await ssh(target, [
    'set -eu', 'test "$(id -u)" -eq 0', 'test ! -e /opt/plaingym', '! command -v docker',
    '. /etc/os-release', 'test "$ID" = ubuntu', 'case "$VERSION_ID" in 24.04|26.04) ;; *) exit 1 ;; esac',
    'printf "os=%s architecture=%s kernel=%s\\n" "$VERSION_ID" "$(uname -m)" "$(uname -r)"',
    'head -3 /proc/meminfo', '',
  ].join('\n'));
  if(baseline.code !== 0) throw new Error(name + ' must be a clean Ubuntu VM without Docker or /opt/plaingym');
  await stage(config, target);
  const sourceHash = await bundleSha256(config.bundle.file);
  const args = '--hostname ' + quote(new URL(target.url).hostname) + ' --email ' + quote(config.email);
  // A remote run pastes the operator's one command; the local fixture installs its staged, CA-adjusted bundle.
  const urls = operatorUrls(config);
  const installCommand = urls
    ? "curl --fail --silent --show-error --location --proto '=https' " + quote(urls.bootstrap) + ' | sh -s -- --bundle-url ' + quote(urls.bundle)
      + ' --sha256 ' + sourceHash + ' -- ' + args
    : stagedCommand(args);
  const result = await ssh(target, 'set -eu\numask 077\n' + installCommand + '\n');
  const setupLink = result.out.match(/https:\/\/[^\s]+\/setup#token=[a-zA-Z0-9_-]+/)?.[0];
  await writeFile(resolve(config.artifacts, name + '-install.log'), redact(result.out), { mode: 0o600 });
  if(result.code !== 0 || !setupLink) throw new Error(name + ' bootstrap failed; see ' + name + '-install.log');
  return auditInstall(config, target, name, {
    setupLink, findings: [], before: baseline.out, sourceHash, rerunCode: 0, hostChecks: '', configurationUnchanged: true, installCommand,
  });
}
async function auditInstall(config: Config, target: Target, name: string, original: InstallEvidence): Promise<InstallEvidence> {
  if((await ssh(target, 'test -f ' + remote + '/bundle.tar && test -f ' + remote + '/bootstrap.sh\n')).code !== 0) await stage(config, target);
  const hostChecks = await checked(target, [
    'set -eu', 'test "$(stat -c %a /opt/plaingym/.env)" = 600',
    'systemctl is-active docker unattended-upgrades',
    "ufw status | grep 'Status: active'", 'test -n "$(swapon --noheadings --show)"',
    'for port in $(/usr/sbin/sshd -T | awk \'$1 == "port" {print $2}\'); do ufw status | grep "$port/tcp" | grep ALLOW; done',
    'ufw status | grep "80/tcp" | grep ALLOW', 'ufw status | grep "443/tcp" | grep ALLOW',
    compose("ps -q") + " | xargs docker inspect --format '{{.Name}} memory={{.HostConfig.Memory}} logs={{json .HostConfig.LogConfig}}'",
    'free -m', '',
  ].join('\n'));
  const hashCommand = 'sha256sum /opt/plaingym/.env /opt/plaingym/compose.yaml /opt/plaingym/Caddyfile';
  const hashesBefore = await checked(target, hashCommand);
  // Pasting the same command again must succeed, print the same link, and change nothing.
  const rerun = await ssh(target, 'set -eu\numask 077\n' + original.installCommand + '\n');
  await writeFile(resolve(config.artifacts, name + '-rerun.log'), redact(rerun.out), { mode: 0o600 });
  const findings = rerun.code === 0 ? [] : ['INSTALL-RERUN: repeating the install command fails instead of succeeding without changes'];
  if(rerun.code === 0 && !rerun.out.includes(original.setupLink)) findings.push('INSTALL-RERUN: the repeated command did not print the setup link');
  const configurationUnchanged = hashesBefore === await checked(target, hashCommand);
  if(!configurationUnchanged) findings.push('INSTALL-RERUN: configuration or secrets changed');
  // A controlled apt shim aborts at the first host mutation. The valid-host
  // control must reach it; a known non-resolving hostname must fail before it.
  await checked(target, 'install -d -m 0700 ' + remote + '/preflight-bin\nprintf \'#!/bin/sh\\nexit 97\\n\' >' + remote + '/preflight-bin/apt-get\nchmod 0700 ' + remote + '/preflight-bin/apt-get\n');
  const probe = (hostname: string, email: string) => ssh(target, 'PATH=' + remote + '/preflight-bin:$PATH '
    + stagedCommand('--directory ' + remote + '/preflight-target --hostname ' + quote(hostname) + ' --email ' + quote(email)) + '\n');
  const valid = await probe(new URL(target.url).hostname, config.email);
  if(valid.code !== 97) throw new Error('The preflight control did not reach the guarded host-mutation boundary');
  const invalidDns = await probe('does-not-exist.invalid', config.email);
  if(invalidDns.code === 97) findings.push('INSTALL-DNS: an unresolvable hostname reaches apt before DNS validation');
  const invalidEmail = await probe(new URL(target.url).hostname, 'invalid-email');
  if(invalidEmail.code === 97) findings.push('INSTALL-EMAIL: invalid email reaches a host mutation');
  const evidence = {
    ...original, findings, rerunCode: rerun.code, hostChecks, configurationUnchanged,
    preflight: { validHost: valid.code, invalidDns: invalidDns.code, invalidEmail: invalidEmail.code }
  };
  await writeFile(resolve(config.artifacts, name + '-install.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  return evidence;
}
