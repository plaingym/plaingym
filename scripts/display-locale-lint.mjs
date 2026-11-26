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
  while (current && (typeWrappers.has(current.type) || current.type === 'ChainExpression')) {
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

/**
 * The outermost type wrapper or optional chain around `node` (or `node` itself), and its parent.
 * @param {Syntax} node @returns {{ child: Syntax, parent: Syntax | undefined }}
 */
function climb(node) {
  let child = node, parent = syntax(node.parent);
  while (parent && (typeWrappers.has(parent.type) || parent.type === 'ChainExpression') && parent.expression === child) {
    child = parent;
    parent = syntax(parent.parent);
  }
  return { child, parent };
}

/** @param {Syntax | undefined} node @param {string} name @returns {boolean} */
function readsProperty(node, name) {
  if (node?.type !== 'MemberExpression' || node.computed) return false;
  const prop = syntax(node.property);
  return prop?.type === 'Identifier' && prop.name === name;
}

/**
 * Whether the constructed object only has `resolvedOptions()` called on it, and the result is read
 * for `.timeZone` or not used at all (the call is a whole statement).
 * @param {Syntax} node @returns {boolean}
 */
function isTimeZoneRead(node) {
  const object = climb(node);
  const member = object.parent;
  if (!member || member.object !== object.child || !readsProperty(member, 'resolvedOptions')) return false;
  const method = climb(member);
  const call = method.parent;
  if (call?.type !== 'CallExpression' || call.callee !== method.child) return false;
  const result = climb(call);
  if (result.parent?.type === 'ExpressionStatement') return true;
  return result.parent?.object === result.child && readsProperty(result.parent, 'timeZone');
}

/**
 * `Intl`, `globalThis.Intl`, `window.Intl` or `self.Intl`, each part possibly in a type wrapper.
 * @param {Syntax | undefined} node @returns {boolean}
 */
function isIntlObject(node) {
  const target = unwrap(node);
  if (target?.type === 'Identifier') return target.name === 'Intl';
  if (target?.type !== 'MemberExpression' || target.computed) return false;
  const object = unwrap(target.object), property = syntax(target.property);
  return object?.type === 'Identifier'
    && (object.name === 'globalThis' || object.name === 'window' || object.name === 'self')
    && property?.type === 'Identifier'
    && property.name === 'Intl';
}

/** @param {Syntax} node @returns {boolean} */
function isTarget(node) {
  const callee = unwrap(node.callee);
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
  const prop = syntax(callee.property);
  if (!prop || prop.type !== 'Identifier' || !prop.name) return false;
  if (node.type === 'CallExpression' && localeStringMethods.has(prop.name)) return true;
  return isIntlObject(syntax(callee.object))
    && intlConstructors.has(prop.name)
    && !isTimeZoneRead(node);
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
