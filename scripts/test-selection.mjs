// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Keep discovery and execution on Vitest's specifications, including files outside apps/packages.
 * @template {{ moduleId: string, project: { name: string } }} T
 * @param {T[]} specifications
 * @returns {T[]}
 */
export function documentationTests(specifications) {
  const docs = specifications.filter(spec => /\.docs\.test\.ts$/.test(spec.moduleId));
  if (!docs.length) throw new Error('No documentation tests found');
  const misplaced = docs.filter(spec => spec.project.name !== 'unit');
  if (misplaced.length) throw new Error(`Documentation tests must belong to unit: ${misplaced.map(spec => spec.moduleId).join(', ')}`);
  return docs;
}
