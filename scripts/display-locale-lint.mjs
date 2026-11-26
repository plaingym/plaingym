// SPDX-License-Identifier: AGPL-3.0-only

const localeStringMethods = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
const intlConstructors = new Set([
  'NumberFormat',
  'DateTimeFormat',
  'RelativeTimeFormat',
  'PluralRules',
  'ListFormat',
  'DisplayNames',
  'Collator',
  'Segmenter',
]);
const typeWrappers = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
]);

/** @typedef {import('eslint').Rule.Node} Node */
/** @typedef {Node & { type: string, name?: string, value?: unknown, regex?: unknown, operator?: string, elements?: unknown[], argument?: unknown, expression?: unknown, computed?: boolean, object?: unknown, property?: unknown, callee?: unknown, arguments?: unknown[], parent?: Syntax }} Syntax */

/** @param {unknown} node @returns {Syntax | undefined} */
function syntax(node) {
  return node ? /** @type {Syntax} */ (node) : undefined;
}

/** @param {unknown} node @returns {Syntax | undefined} */
function unwrap(node) {
  let current = syntax(node);
  while (current && typeWrappers.has(current.type)) {
    current = syntax(current.expression);
  }
  return current;
}

/** An array with no values: `[]`, or only holes such as `[,]`. @param {Syntax | undefined} node @returns {boolean} */
function isEmptyArray(node) {
  return node?.type === 'ArrayExpression' && (node.elements ?? []).every(element => element === null);
}

/** @param {Syntax} node @returns {boolean} */
function isEmptyLocaleArg(node) {
  const unwrapped = unwrap(node);
  if (!unwrapped) return false;
  if (unwrapped.type === 'Identifier' && unwrapped.name === 'undefined') return true;
  if (unwrapped.type === 'Literal' && unwrapped.value === null && !unwrapped.regex) return true;
  if (unwrapped.type === 'UnaryExpression' && unwrapped.operator === 'void') return true;
  if (isEmptyArray(unwrapped)) return true;
  if (unwrapped.type === 'SpreadElement') return isEmptyArray(unwrap(unwrapped.argument));
  return false;
}

/** @param {Syntax} node @returns {boolean} */
function isResolvedOptionsObject(node) {
  const parent = syntax(node.parent);
  if (!parent || parent.type !== 'MemberExpression' || parent.object !== node || parent.computed) return false;
  const prop = syntax(parent.property);
  return prop?.type === 'Identifier' && prop.name === 'resolvedOptions';
}

/** `Intl`, `globalThis.Intl` or `window.Intl`. @param {Syntax | undefined} node @returns {boolean} */
function isIntlObject(node) {
  if (node?.type === 'Identifier') return node.name === 'Intl';
  if (node?.type !== 'MemberExpression' || node.computed) return false;
  const object = syntax(node.object), property = syntax(node.property);
  return object?.type === 'Identifier'
    && (object.name === 'globalThis' || object.name === 'window')
    && property?.type === 'Identifier'
    && property.name === 'Intl';
}

/** @param {Syntax} node @returns {boolean} */
function isTarget(node) {
  const callee = syntax(node.callee);
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
  const prop = syntax(callee.property);
  if (!prop || prop.type !== 'Identifier' || !prop.name) return false;
  if (node.type === 'CallExpression' && localeStringMethods.has(prop.name)) return true;
  return isIntlObject(syntax(callee.object))
    && intlConstructors.has(prop.name)
    && !isResolvedOptionsObject(node);
}

/** @type {import('eslint').Rule.RuleModule} */
export const displayLocaleRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      locale: "Display formatting uses the fixed en locale: formatCount (lib/count.ts), lib/instant.ts, or an explicit 'en'.",
    },
  },
  create(context) {
    /** @param {Node} raw */
    function check(raw) {
      const node = /** @type {Syntax} */ (raw);
      if (!isTarget(node)) return;
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (args.length === 0 || isEmptyLocaleArg(/** @type {Syntax} */ (args[0]))) {
        context.report({ node: raw, messageId: 'locale' });
      }
    }
    return {
      CallExpression: check,
      NewExpression: check,
    };
  },
};
