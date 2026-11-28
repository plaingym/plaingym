// SPDX-License-Identifier: AGPL-3.0-only
// Keeps the last 14 nightly prereleases (deploy/README.md, "Prereleases"). The Prerelease workflow's run on main
// deletes every older nightly's GitHub release with its tag, and the ghcr.io/OWNER/app versions tagged only for those
// nightlies. Stable releases, drafts, earlier v0.Y.Z prereleases and their images are never touched.
//
//   prune-nightlies.mjs OWNER/REPO
import { pathToFileURL } from 'node:url';
import { compare, defaultGh } from './release.mjs';
import { nightlyPattern } from './prerelease.mjs';

export const keepNightlies = 14;
/** The image tags publish.sh pushes for a version: the multi-arch index and one per architecture. */
const imageSuffixes = ['', '-amd64', '-arm64'];

/**
 * Which nightlies to delete. A nightly is a published (non-draft) release GitHub marks prerelease whose tag matches
 * the nightly pattern; the `keep` highest stay. A package version is deleted only when it has at least one tag and
 * every tag is a deleted nightly's TAG, TAG-amd64 or TAG-arm64.
 * @param {{ releases: { tagName: string, isDraft?: boolean, isPrerelease?: boolean }[],
 *   versions: { id: number, metadata?: { container?: { tags?: string[] } } }[], keep?: number }} input
 */
export function planPrune({ releases, versions, keep = keepNightlies }) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Keep at least one nightly.');
  const nightlies = [...new Set(releases.filter((release) => !release.isDraft && release.isPrerelease === true && nightlyPattern.test(release.tagName))
    .map((release) => release.tagName))].sort((a, b) => compare(b, a));
  const pruned = nightlies.slice(keep).sort(compare);
  const names = new Set(pruned.flatMap((tag) => imageSuffixes.map((suffix) => tag + suffix)));
  const images = versions.map((version) => ({ id: version.id, tags: version.metadata?.container?.tags ?? [] }))
    .filter(({ tags }) => tags.length > 0 && tags.every((tag) => names.has(tag)));
  return { kept: nightlies.slice(0, keep), releases: pruned, versions: images };
}

/** Every package version of OWNER's app image, from all pages of the list. */
function packageVersions(gh, owner) {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `/orgs/${owner}/packages/container/app/versions?per_page=100`]));
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error('The package versions are not a list of pages.');
  return pages.flat();
}

const reason = (error) => String(error?.stderr || error?.message || error).trim().split('\n')[0];

/**
 * Deletes the nightlies `planPrune` picks. Every delete is tried, also after one failed; the result says how many
 * failed. A failure to list releases or package versions deletes nothing and throws.
 * @param {{ repo: string, gh?: (args: string[]) => string, log?: (line: string) => void, keep?: number }} options
 */
export function pruneNightlies({ repo, gh = (args) => defaultGh(args, process.cwd()), log = console.log, keep = keepNightlies }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('Usage: prune-nightlies.mjs OWNER/REPO');
  const owner = repo.split('/')[0].toLowerCase();
  const releases = JSON.parse(gh(['release', 'list', '-R', repo, '--limit', '1000', '--json', 'tagName,isDraft,isPrerelease']));
  if (!Array.isArray(releases)) throw new Error('The release list is not a list.');
  const plan = planPrune({ releases, versions: packageVersions(gh, owner), keep });
  let failed = 0;
  const attempt = (what, args) => {
    try { gh(args); log(`Deleted ${what}.`); }
    catch (error) { failed += 1; log(`::error::Could not delete ${what}: ${reason(error)}`); }
  };
  for (const tag of plan.releases) attempt(`the ${tag} release and its tag`, ['release', 'delete', tag, '-R', repo, '--cleanup-tag', '--yes']);
  for (const { id, tags } of plan.versions)
    attempt(`package version ${id} (${tags.join(', ')})`, ['api', '-X', 'DELETE', `/orgs/${owner}/packages/container/app/versions/${id}`]);
  log(`::notice::Kept ${plan.kept.length} nightlies${plan.kept.length ? ` (${plan.kept.at(-1)} to ${plan.kept[0]})` : ''}; `
    + `${plan.releases.length} older releases and ${plan.versions.length} package versions to delete, ${failed} failed.`);
  return { ...plan, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failed } = pruneNightlies({ repo: process.argv[2] ?? '' });
  if (failed) process.exitCode = 1;
}
