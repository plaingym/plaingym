// SPDX-License-Identifier: AGPL-3.0-only
import { relative } from 'node:path';

// Include utility modifiers, e.g. dark:hover:bg-red-300/50 and text-black!.
const families = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe';
const utilities = 'accent|bg|border(?:-[xysetrbl])?|caret|decoration|divide|drop-shadow|fill|from|inset-ring|inset-shadow|outline|placeholder|ring(?:-offset)?|shadow|stroke|text|to|via';
const palette = new RegExp(`(?:^|[\\s:])!?((?:${utilities})-(?:white|black|(?:${families})-\\d{2,3}))(?=$|[\\s!/])`, 'g');
const cssColor = /(?:#[\da-f]{3}(?:[\da-f]{5}|[\da-f]{3}|[\da-f])?(?![a-z\d-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\()/gi;

// File, element and complete class attribute. Each exception applies only to
// the named light media surface, including when it shares a file with other UI.
const fixedWhite = new Map([
  ['kiosk-devices/settings.tsx', ['img', 'my-2 h-auto w-full max-w-64 bg-white']], // Device pairing QR.
  ['portal/checkin/page.tsx', ['img', 'mx-auto h-auto w-full max-w-72 rounded-lg bg-white p-2']], // Member check-in QR.
  ['portal/waivers/page.tsx', ['canvas', 'h-36 w-full touch-none rounded-lg border border-border bg-white']], // Member signature ink.
  ['waivers/screens.tsx', ['canvas', 'h-36 w-full touch-none rounded-lg border border-border bg-white']], // Staff signature ink.
  ['website/settings.tsx', ['img', 'h-20 w-20 rounded-md border border-border bg-white object-contain p-1']], // Gym logo artwork.
]);

/** @typedef {import('eslint').Rule.Node} Node */
/** @typedef {Node & { value?: unknown, name?: string, [key: string]: unknown }} Syntax */

/** @param {unknown} node @returns {Syntax | undefined} */
function syntax(node) {
  return node ? /** @type {Syntax} */ (node) : undefined;
}

/** @param {unknown} node */
function nameOf(node) {
  const key = syntax(node);
  return key?.name ?? (key?.type === 'Literal' ? key.value : undefined);
}

/** @param {unknown} nodes @returns {Syntax[]} */
function list(nodes) {
  return Array.isArray(nodes) ? nodes.filter(Boolean) : [];
}

/** @type {import('eslint').Rule.RuleModule} */
export const rawColorRule = {
  meta: { type: 'problem', schema: [], messages: { token: 'Use a theme token in place of {{color}}.' } },
  create(context) {
    const path = relative(context.cwd, context.filename).replaceAll('\\', '/');
    // Match from `src/features/` so a run started in apps/web finds the same entry.
    const exception = fixedWhite.get(path.replace(/^(?:.*\/)?src\/features\//, ''));
    const visited = new Map();

    /** @param {Syntax} node @param {string} text @param {boolean} classes @param {boolean} white */
    function check(node, text, classes, white) {
      for (const match of text.matchAll(cssColor)) context.report({ node, messageId: 'token', data: { color: match[0] } });
      if (classes) for (const [, color] of text.matchAll(palette)) {
        if (color !== 'bg-white' || !white) context.report({ node, messageId: 'token', data: { color } });
      }
    }

    /** Follow static styling values and branches without reading unrelated data or conditions.
     * @param {unknown} value @param {boolean} classes @param {boolean} [white] */
    function inspect(value, classes, white = false) {
      const node = syntax(value);
      if (!node) return;
      const mode = white ? 'white' : classes ? 'classes' : 'style';
      const modes = visited.get(node) ?? new Set();
      if (modes.has(mode)) return;
      modes.add(mode);
      visited.set(node, modes);
      switch (String(node.type)) {
        case 'Literal':
          if (typeof node.value === 'string') check(node, node.value, classes, white);
          break;
        case 'TemplateLiteral':
          for (const part of list(node.quasis)) check(part, /** @type {{ raw: string }} */ (part.value).raw, classes, white);
          for (const part of list(node.expressions)) inspect(part, classes);
          break;
        case 'JSXExpressionContainer':
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
        case 'TSNonNullExpression':
          inspect(node.expression, classes);
          break;
        case 'ConditionalExpression':
          inspect(node.consequent, classes);
          inspect(node.alternate, classes);
          break;
        case 'LogicalExpression':
          if (node.operator !== '&&') inspect(node.left, classes);
          inspect(node.right, classes);
          break;
        case 'BinaryExpression':
          if (node.operator === '+') {
            inspect(node.left, classes);
            inspect(node.right, classes);
          }
          break;
        case 'Identifier': {
          let scope = context.sourceCode.getScope(node);
          for (;;) {
            const variable = scope.set.get(String(node.name));
            if (variable) {
              const def = variable.defs[0];
              if (def?.type === 'Variable' && def.node.id.type === 'Identifier') inspect(def.node.init, classes);
              break;
            }
            if (!scope.upper) break;
            scope = scope.upper;
          }
          break;
        }
        case 'ObjectExpression':
          for (const prop of list(node.properties)) {
            if (classes && prop.type === 'Property') {
              const key = syntax(prop.key);
              if (key?.type === 'Literal') inspect(key, true);
            }
            inspect(prop.type === 'SpreadElement' ? prop.argument : prop.value, classes);
          }
          break;
        case 'ArrayExpression':
          for (const entry of list(node.elements)) inspect(entry, classes);
          break;
        case 'SpreadElement':
          inspect(node.argument, classes);
          break;
      }
    }

    return {
      /** @param {Node} raw */
      JSXAttribute(raw) {
        const node = /** @type {Syntax} */ (raw);
        const attr = nameOf(node.name);
        if (attr !== 'className' && attr !== 'style') return;
        const white = attr === 'className' && exception?.[0] === nameOf(syntax(node.parent)?.name)
          && exception?.[1] === syntax(node.value)?.value;
        inspect(node.value, attr === 'className', white);
      },
      Property(raw) {
        const node = /** @type {Syntax} */ (raw);
        const key = nameOf(node.key);
        if (key === 'className' || key === 'style') inspect(node.value, key === 'className');
      },
      CallExpression(raw) {
        const node = /** @type {Syntax} */ (raw);
        const callee = nameOf(node.callee);
        if (callee === 'cn' || callee === 'clsx' || callee === 'cva') {
          for (const arg of list(node.arguments)) inspect(arg, true);
        }
      },
    };
  },
};
