// SPDX-License-Identifier: AGPL-3.0-only

/** The project repository's root, which the app treats like an unset SOURCE_URL when the image bakes its own link. */
export const repositoryRoot = 'https://github.com/plaingym/plaingym';

/**
 * The `/source` redirect the app should give when started with `sourceUrl` from an image that bakes `imageSourceUrl`:
 * an empty value, or the bare repository root (one trailing slash and host case ignored), yields to the image's link.
 * The app redirects to the parsed link, so the expectation is normalized the same way (lower-case host, root path `/`).
 */
export function expectedSourceLocation(sourceUrl, imageSourceUrl) {
  const href = (value) => (value && URL.canParse(value) ? new URL(value).href : value);
  if (!sourceUrl) return href(imageSourceUrl);
  if (imageSourceUrl && URL.canParse(sourceUrl) && new URL(sourceUrl).href.replace(/\/$/, '') === repositoryRoot) return href(imageSourceUrl);
  return href(sourceUrl);
}
