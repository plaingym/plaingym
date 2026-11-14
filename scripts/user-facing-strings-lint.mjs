// SPDX-License-Identifier: AGPL-3.0-only
/** @typedef {import('eslint').Rule.Node & { value?: unknown, name?: unknown, expression?: UIExpression }} UINode */
/** @typedef {{ type: string, value?: unknown, consequent?: UIExpression, alternate?: UIExpression, left?: UIExpression, right?: UIExpression, expressions?: UIExpression[], quasis?: { value: { cooked: string | null } }[] }} UIExpression */
const attributes = new Set(['title', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'placeholder', 'alt', 'label', 'description', 'message', 'heading', 'hint']);
/** Component text props follow the same names: `closeLabel`, `emptyText`, `confirmTitle`, `errorMessage`. @param {string} name */
const textAttribute = name => attributes.has(name) || /[a-z](?:Label|Title|Text|Message|Heading|Hint|Description|Placeholder)$/.test(name);
const words = /\p{L}/u;

/** Literal branches and template text are visible too; arguments to t() and dynamic names are not UI literals. @param {UIExpression | undefined} node @returns {boolean} */
function hasText(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string' && words.test(node.value);
  if (node.type === 'ConditionalExpression') return hasText(node.consequent) || hasText(node.alternate);
  if (node.type === 'LogicalExpression') return hasText(node.right);
  if (node.type === 'BinaryExpression') return hasText(node.left) || hasText(node.right);
  if (node.type === 'TemplateLiteral') return !!(node.quasis?.some(part => words.test(part.value.cooked ?? '')) || node.expressions?.some(hasText));
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export const userFacingStringsRule = {
  meta: { type: 'problem', schema: [], messages: { translate: 'Put user-facing text in the area locale catalog and render it with t().' } },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || !['h', 'jsx', 'createElement'].includes(node.callee.name)) return;
        const [tag, props, ...children] = node.arguments;
        if (tag?.type === 'Literal' && ['script', 'style'].includes(String(tag.value))) return;
        for (const child of children) if (hasText(/** @type {UIExpression} */ (child))) context.report({ node: child, messageId: 'translate' });
        if (props?.type === 'ObjectExpression') for (const prop of props.properties) {
          if (prop.type !== 'Property') continue;
          const name = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'Literal' ? String(prop.key.value) : '';
          if (textAttribute(name) && hasText(/** @type {UIExpression} */ (prop.value))) context.report({ node: prop.value, messageId: 'translate' });
        }
      },
      /** @param {import('eslint').Rule.Node} node */
      JSXText(node) {
        if (words.test(String(/** @type {UINode} */ (node).value ?? ''))) context.report({ node, messageId: 'translate' });
      },
      /** @param {import('eslint').Rule.Node} node */
      JSXAttribute(node) {
        const attribute = /** @type {UINode & { name: { name: string }, value?: UIExpression }} */ (node);
        if (textAttribute(String(attribute.name.name)) && hasText(attribute.value)) context.report({ node, messageId: 'translate' });
      },
      /** @param {import('eslint').Rule.Node} node */
      JSXExpressionContainer(node) {
        const parent = /** @type {{ type: string, name?: { name: string } } | null} */ (/** @type {unknown} */ (node.parent));
        if (parent?.type === 'JSXAttribute' && !textAttribute(String(parent.name?.name ?? ''))) return;
        if (hasText(/** @type {UINode} */ (node).expression)) context.report({ node, messageId: 'translate' });
      },
    };
  },
};
