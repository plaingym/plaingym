// SPDX-License-Identifier: AGPL-3.0-only
import type { EndpointContract } from '@plaingym/shared/contracts';
type Schema = EndpointContract['response'];
export type ResponseSchema<T> = Pick<Schema, 'safeParse'> & { parse(input: unknown): T };
type Issue = NonNullable<ReturnType<Schema['safeParse']>['error']>['issues'][number];
type UnknownKeys = Extract<Issue, { code: 'unrecognized_keys' }>;

/** Client answers tolerate additive fields; the shared request and OpenAPI schemas stay strict. */
export function parseResponse<S extends ResponseSchema<unknown>>(schema: S, value: unknown): ReturnType<S['parse']> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as ReturnType<S['parse']>;
  const copy: unknown = structuredClone(value);
  // Only remove keys the schema explicitly identifies as unknown. Required fields, types and refinements still fail.
  const unknownKeys = (issues: readonly Issue[]): UnknownKeys[] | undefined => {
    const keys: UnknownKeys[] = [];
    for (const issue of issues) {
      if (issue.code === 'unrecognized_keys') keys.push(issue);
      else if (issue.code === 'invalid_union') {
        const branch = issue.errors.map(unknownKeys).find(result => result !== undefined);
        if (!branch) return undefined;
        keys.push(...branch.map(item => ({ ...item, path: [...issue.path, ...item.path] })));
      } else return undefined;
    }
    return keys;
  };
  const keys = unknownKeys(parsed.error.issues);
  if (!keys?.length) throw parsed.error;
  for (const issue of keys) {
    let object = copy;
    for (const segment of issue.path) object = (object as Record<PropertyKey, unknown>)[segment];
    for (const key of issue.keys) delete (object as Record<string, unknown>)[key];
  }
  return schema.parse(copy) as ReturnType<S['parse']>;
}
