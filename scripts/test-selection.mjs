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

/**
 * @template {{ moduleId: string, project: { name: string } }} T
 * @param {{
 *   globTestSpecifications(): Promise<T[]>,
 *   standalone(): Promise<void>,
 *   runTestSpecifications(specifications: T[]): Promise<{
 *     unhandledErrors: unknown[], testModules: { state(): string }[]
 *   }>
 * }} vitest
 */
export async function runDocumentationTests(vitest) {
  const docs = documentationTests(await vitest.globTestSpecifications());
  // createVitest prepares discovery; standalone initializes reporters/coverage before execution.
  await vitest.standalone();
  const result = await vitest.runTestSpecifications(docs);
  if (result.testModules.length !== docs.length) throw new Error('Not every documentation test module ran');
  return result.unhandledErrors.length === 0 && result.testModules.every(module => ['passed', 'skipped'].includes(module.state()));
}
