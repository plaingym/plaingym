// SPDX-License-Identifier: AGPL-3.0-only
import { compile } from 'tailwindcss';

const utilities = await compile('@tailwind utilities;');
const cache = new Map<string, string | undefined>();
/** The `overflow-wrap` value an unconditional class sets, if any. */
const setsOverflowWrap = (name: string) => {
  if (!cache.has(name)) {
    // `build` returns the CSS of every class asked for so far: read only this class's rule.
    const selector = ('.' + name.replace(/[^\w-]/g, '\\$&')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cache.set(name, new RegExp('(?:^|\\n)\\s*' + selector + '\\s*\\{[^}]*overflow-wrap:\\s*([\\w-]+)').exec(utilities.build([name]))?.[1]);
  }
  return cache.get(name);
};

/** Whether a user-supplied name in this element can break anywhere, so it can't widen its flex or grid item.
 * `overflow-wrap` is inherited: the closest element at or above this one that sets it decides, so a nearer
 * `wrap-normal` overrides a `wrap-anywhere` further up. jsdom has no layout, so this compiles each class with Tailwind
 * and reads the declaration it produces: a class that does nothing, or a typo, doesn't pass.
 * The 360 px overflow itself is checked in the End-to-end suite (`e2e/specs/long-names.spec.ts`). */
export function breaksAnywhere(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const values = [...node.classList].map(setsOverflowWrap).filter((value) => value !== undefined);
    if (values.length) return values.at(-1) === 'anywhere';
  }
  return false;
}
