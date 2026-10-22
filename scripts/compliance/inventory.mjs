// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { assertLicenseAllowed, licenseAllowed, noticeFiles, packageLicense, validateApprovals } from './license.mjs';
import { trackedFiles } from './headers.mjs';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

function pnpm(root, args) {
  // pnpm exposes its JS entrypoint when invoked by "pnpm compliance".
  // Direct node invocation also works through the Windows command shim.
  const entry = process.env.npm_execpath;
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true };
  if (entry && /pnpm[^/\\]*[.](?:c?js)$/.test(entry)) return execFileSync(process.execPath, [entry, ...args], options);
  if (process.platform === 'win32') return execFileSync('cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd ' + args.join(' ')], options);
  return execFileSync('pnpm', args, options);
}

export function graphPaths(roots, skipped = new Set(), { skipOptionalPeers = false } = {}) {
  const paths = new Set();
  const manifests = new Map();
  function walk(node, optional = false) {
    let manifest;
    if (node.path) {
      if (!existsSync(node.path)) {
        if (optional || skipped.has(`${node.from}@${node.version}`)) return; // pnpm reports uninstalled optional packages for other platforms.
        throw new Error(`Required dependency is not installed: ${node.path}`);
      }
      paths.add(realpathSync(node.path));
      if (skipOptionalPeers) {
        if (!manifests.has(node.path)) manifests.set(node.path, json(join(node.path, 'package.json')));
        manifest = manifests.get(node.path);
      }
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, child] of Object.entries(node[field] ?? {})) {
        // pnpm folds linked peers into dependencies, including workspace dev tools.
        // Keep real dependency edges; bundle evidence separately covers optional
        // integrations that are actually included in a release.
        if (skipOptionalPeers && manifest?.peerDependenciesMeta?.[name]?.optional
          && !Object.hasOwn(manifest.dependencies ?? {}, name)
          && !Object.hasOwn(manifest.optionalDependencies ?? {}, name)) continue;
        walk(child, optional || field === 'optionalDependencies');
      }
    }
  }
  roots.forEach((node) => walk(node));
  return paths;
}

// bundles: { server, web } sets of real input paths from bundleInputs(root).
export function inventory(root, bundles) {
  const modulesText = readFileSync(join(root, 'node_modules/.modules.yaml'), 'utf8');
  // pnpm's list tree folds optional nodes into dependencies; its install manifest
  // identifies exactly which platform packages were intentionally skipped.
  const skipped = new Set(modulesText.trimStart().startsWith('{') ? JSON.parse(modulesText).skipped ?? []
    : [...(modulesText.match(/^skipped:\r?\n((?:[ \t]+.*\r?\n)*)/m)?.[1] ?? '').matchAll(/^\s+-\s+['"]?([^'"\r\n]+)['"]?\s*$/gm)].map((match) => match[1]));
  const all = JSON.parse(pnpm(root, ['list', '--recursive', '--depth', 'Infinity', '--json']));
  const production = graphPaths(JSON.parse(pnpm(root, ['list', '--recursive', '--prod', '--depth', 'Infinity', '--json'])), skipped, { skipOptionalPeers: true });
  const workspacePaths = new Set(all.map((pkg) => realpathSync(pkg.path)));
  const config = json(join(root, 'scripts/compliance/allowlist.json'));
  validateApprovals(config.approvals);
  validateApprovals(config.buildTimePackages);
  // Missing or empty evidence leaves bundled undefined, so build-time allowances fail closed.
  const bundled = bundles?.server?.size && bundles?.web?.size ? [...bundles.server, ...bundles.web] : undefined;
  const supplemental = json(join(root, 'scripts/compliance/notices/provenance.json'));
  const packages = [];
  for (const path of graphPaths(all, skipped)) {
    if (workspacePaths.has(path)) continue; // Our own workspace packages use the application license.
    const manifest = json(join(path, 'package.json'));
    const notices = noticeFiles(path);
    // Some upstream tarballs omit their license text. Supplemental notices are
    // package/version/license-bound, sourced from immutable upstream URLs and hashed.
    for (const entry of supplemental.filter((entry) => entry.name === manifest.name && entry.version === manifest.version && entry.license === manifest.license)) {
      const bytes = readFileSync(join(root, entry.path));
      if (sha256(bytes) !== entry.sha256) throw new Error(`Supplemental notice hash mismatch: ${entry.path}`);
      notices.push({ name: `LICENSE (upstream: ${entry.upstream})`, text: bytes.toString('utf8').trim() });
    }
    const pkg = {
      name: manifest.name, version: manifest.version, path,
      license: packageLicense(manifest, notices), notices,
      upstream: manifest.homepage ?? (typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url) ?? '',
      runtime: production.has(path),
      buildTimeOnly: config.buildTimePackages.some((entry) => entry.name === manifest.name && entry.version === manifest.version && entry.license === manifest.license),
      bundled: bundled ? bundled.some((input) => input === path || input.startsWith(path + sep)) : undefined,
    };
    assertLicenseAllowed(pkg, config.approvals);
    packages.push(pkg);
  }
  if (!packages.length) throw new Error('No installed dependencies; run pnpm install --frozen-lockfile first');
  const assets = json(join(root, 'scripts/compliance/assets.json'));
  const assetPaths = new Set(assets.map((asset) => asset.path));
  for (const path of trackedFiles(root)) {
    if (/\.(?:ttf|otf|woff2?)$/i.test(path) && !assetPaths.has(path)) throw new Error(`Font missing from bundled asset inventory: ${path}`);
    if (/\/assets\//.test(path) && !/\.(?:md|txt)$/i.test(path) && !assetPaths.has(path)) throw new Error(`Bundled asset missing from inventory: ${path}`);
  }
  for (const asset of assets) {
    for (const path of [asset.path, asset.notice]) {
      const absolute = resolve(root, path);
      if (relative(root, absolute).startsWith('..') || !absolute.startsWith(resolve(root) + sep)) throw new Error('Asset must stay inside the repository');
    }
    if (!licenseAllowed(asset, config.approvals)) throw new Error(`Disallowed asset license: ${asset.path}`);
    if (sha256(readFileSync(join(root, asset.path))) !== asset.sha256) throw new Error(`Bundled asset hash changed: ${asset.path}`);
    asset.noticeText = readFileSync(join(root, asset.notice), 'utf8').replace(/\r\n/g, '\n').trim();
    if (!asset.noticeText) throw new Error(`Empty asset notice: ${asset.notice}`);
  }
  return { packages, assets };
}

export function generateNotices({ packages, assets }) {
  const sections = [
    'THIRD-PARTY LICENSES',
    'Generated by node scripts/compliance/cli.mjs --write. Do not edit by hand.',
    'Includes declared production dependency closures and inventoried bundle inputs/assets.',
    '',
  ];
  const unique = new Map();
  for (const pkg of packages.filter((pkg) => pkg.runtime || pkg.bundled)) {
    if (!pkg.notices.length) throw new Error(`Runtime dependency has no redistributable license notice: ${pkg.name}@${pkg.version}`);
    unique.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  for (const [id, pkg] of [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    sections.push('='.repeat(78), id, `License: ${pkg.license}`, `Upstream: ${pkg.upstream}`, '');
    for (const notice of pkg.notices) sections.push(`--- ${notice.name} ---`, notice.text, '');
  }
  for (const asset of [...assets].sort((a, b) => a.path < b.path ? -1 : 1)) {
    sections.push('='.repeat(78), asset.name, `File: ${asset.path}`, `SHA-256: ${asset.sha256}`,
      `License: ${asset.license}`, `Upstream: ${asset.upstream}`, `Notice: ${asset.notice}`, '', asset.noticeText, '');
  }
  return sections.join('\n').trimEnd() + '\n';
}
