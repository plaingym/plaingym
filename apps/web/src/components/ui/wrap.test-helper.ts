// SPDX-License-Identifier: AGPL-3.0-only
import { compile } from 'tailwindcss';

interface Rule { selector: string; value: string; specificity: number; order: number }

const utilities = await compile('@tailwind utilities;');
const known = new Set<string>();
let rules: Rule[] = [];

/** (class, attribute and pseudo-class selectors, then type and pseudo-element selectors) of one selector, as one comparable
 * number. `:is(…)` counts for its argument (one level, which is what Tailwind emits; it is unwrapped first, so the `in-*`
 * variants' `:where(:is(…))` counts for nothing), `:where(…)` for nothing, `:not(…)` and `:has(…)` for their argument, and
 * `::x` is a type. Not modelled, since no wrap class the app uses emits them: selector lists (an `:is()` list adds up its
 * entries instead of taking the largest) and `!important`. */
function specificity(selector: string): number {
  const bare = selector.replace(/\\./g, 'x').replace(/:is\(([^()]*)\)/g, '$1').replace(/:where\([^()]*\)/g, '').replace(/:(?:not|has)\(/g, '(');
  const elements = (bare.match(/::[\w-]+/g) ?? []).length, plain = bare.replace(/::[\w-]+/g, '');
  const classes = (plain.match(/[.[:]/g) ?? []).length, types = (plain.match(/(?:^|[\s>+~(])[a-z][\w-]*/gi) ?? []).length + elements;
  return classes * 1000 + types;
}
/** Compiles every class in the document once (and again only when a new class appears) and reads the unconditional
 * `overflow-wrap` rules of the generated CSS in the order Tailwind emits them. Conditional rules (`hover:`, media queries)
 * are left out: they don't apply to a resting element. */
function load(document: Document) {
  const fresh = [...document.querySelectorAll('[class]')].flatMap((node) => [...node.classList]).filter((name) => !known.has(name));
  if (!fresh.length) return;
  for (const name of fresh) known.add(name);
  // Drop comments (the build opens with Tailwind's license banner), so none joins the first rule's selector.
  const css = utilities.build([...known]).replace(/\/\*[\s\S]*?\*\//g, '');
  rules = [];
  for (const [, selector, body] of css.matchAll(/^([^\s@{}][^{}]*)\{([^{}]*)\}/gm)) {
    const value = /overflow-wrap:\s*([\w-]+)/.exec(body!)?.[1];
    if (value) rules.push({ selector: selector!.trim(), value, specificity: specificity(selector!.trim()), order: rules.length });
  }
}

/** The `overflow-wrap` this element's own rules give it, if any: the highest specificity wins, then the later rule. */
function declared(element: Element): string | undefined {
  let winner: Rule | undefined;
  for (const rule of rules) {
    if (!element.matches(rule.selector)) continue;
    if (!winner || rule.specificity > winner.specificity || (rule.specificity === winner.specificity && rule.order > winner.order)) winner = rule;
  }
  return winner?.value;
}

/** Whether a user-supplied name in this element can break anywhere, so it can't widen its flex or grid item.
 * `overflow-wrap` is inherited: the closest element at or above this one that a rule sets it on decides. jsdom has no
 * layout and doesn't inherit it, so this compiles the document's classes with Tailwind once, and applies the generated
 * rules the way a browser does: descendant rules such as `[&_table]:wrap-normal` reach this element from an ancestor, the more
 * specific rule wins, then the later one (not the later class name). A class that does nothing, or a typo, doesn't pass.
 * The 360 px overflow itself is checked in the End-to-end suite (`e2e/specs/long-names.spec.ts`). */
export function breaksAnywhere(element: Element): boolean {
  load(element.ownerDocument);
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = declared(node);
    if (value !== undefined) return value === 'anywhere';
  }
  return false;
}
