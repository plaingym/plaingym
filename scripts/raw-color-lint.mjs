// SPDX-License-Identifier: AGPL-3.0-only
import { relative } from 'node:path';

// Include utility modifiers, e.g. dark:hover:bg-red-300/50 and text-black!.
const families = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe';
const utilities = 'accent|bg|border(?:-[xysetrbl])?|caret|decoration|divide|drop-shadow|fill|from|inset-ring|inset-shadow|outline|placeholder|ring(?:-offset)?|shadow|stroke|text|to|via';
const palette = new RegExp(`(?:^|[\\s:])!?((?:${utilities})-(?:white|black|(?:${families})-\\d{2,3}))(?=$|[\\s!/])`, 'g');
const arbitrary = new RegExp(`(?:^|[\\s:])!?(?:${utilities})-\\[([^\\]\\s]+)\\]`, 'g');
const arbitraryProperty = /\[([a-z-]+):([^\]\s]+)\]/g;
const cssColor = /(?:#[\da-f]{3}(?:[\da-f]{5}|[\da-f]{3}|[\da-f])?(?![a-z\d-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\()/gi;
const namedColors = new Set(`
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
  cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod
  darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
  darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray
  dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green
  greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
  lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta
  maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
  mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive
  olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru
  pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
  seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle
  tomato turquoise violet wheat white whitesmoke yellow yellowgreen
`.trim().split(/\s+/));
// Skip quoted strings, URLs, hex values and custom property identifiers before reading color keywords.
const cssWord = /url\([^)]*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[\w-]+|--[\w-]+|[a-z][\w-]*/gi;
const colorProperty = /^(?:background|border|boxShadow|columnRule|fill|filter|outline|scrollbarColor|stroke|textDecoration|textShadow|color$)|(?:Color|-color)$/;
const classCalls = new Set(['cn', 'clsx', 'cva', 'twMerge']);

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

/** @param {Syntax} node @param {unknown} key */
function propertyKey(node, key) {
  const property = syntax(key);
  const value = node.computed && property?.type !== 'Literal' ? undefined : nameOf(property);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** @typedef {'classes' | 'style' | 'color-style' | 'white'} Mode */

/** @type {import('eslint').Rule.RuleModule} */
export const rawColorRule = {
  meta: { type: 'problem', schema: [], messages: { token: 'Use a theme token in place of {{color}}.' } },
  create(context) {
    const path = relative(context.cwd, context.filename).replaceAll('\\', '/');
    // Match from `src/features/` so a run started in apps/web finds the same entry.
    const exception = fixedWhite.get(path.replace(/^(?:.*\/)?src\/features\//, ''));
    const visited = new Map();
    const active = new Set();
    const reported = new Map();

    /** @param {Syntax} node @param {string} text @param {Mode} mode */
    function check(node, text, mode) {
      /** @param {string} color */
      const report = color => {
        const colors = reported.get(node) ?? new Set();
        if (colors.has(color)) return;
        colors.add(color);
        reported.set(node, colors);
        context.report({ node, messageId: 'token', data: { color } });
      };
      /** @param {string} value */
      const checkNames = value => {
        for (const [word] of value.matchAll(cssWord)) if (namedColors.has(word.toLowerCase())) report(word);
      };
      for (const [color] of text.matchAll(cssColor)) report(color);
      if (mode === 'classes' || mode === 'white') {
        for (const [, color] of text.matchAll(palette)) if (color && (color !== 'bg-white' || mode !== 'white')) report(color);
        for (const [, value] of text.matchAll(arbitrary)) if (value) checkNames(value.replaceAll('_', ' '));
        for (const [, property, value] of text.matchAll(arbitraryProperty)) {
          if (!property || !value) continue;
          const styleProperty = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          if (colorProperty.test(styleProperty)) checkNames(value.replaceAll('_', ' '));
        }
      }
      if (mode === 'color-style') checkNames(text);
    }

    /** Follow static styling values and branches without reading unrelated data or conditions.
     * An unknown member key may select any entry. Known keys skip unrelated entries.
     * @param {unknown} value @param {Mode} mode @param {(string | undefined)[]} [members] */
    function inspect(value, mode, members = []) {
      const node = syntax(value);
      if (!node) return;
      const visitKey = mode + JSON.stringify(members);
      const modes = visited.get(node) ?? new Set();
      if (modes.has(visitKey)) return;
      // Only recursive references can revisit an active node with a longer member path.
      if (active.has(node)) return;
      modes.add(visitKey);
      visited.set(node, modes);
      active.add(node);
      const classes = mode === 'classes' || mode === 'white';
      const [member, ...rest] = members;
      switch (String(node.type)) {
        case 'Literal':
          if (!members.length && typeof node.value === 'string') check(node, node.value, mode);
          break;
        case 'TemplateLiteral':
          if (!members.length) {
            for (const part of list(node.quasis)) check(part, /** @type {{ raw: string }} */ (part.value).raw, mode);
            for (const part of list(node.expressions)) inspect(part, mode);
          }
          break;
        case 'ChainExpression':
        case 'JSXExpressionContainer':
        case 'TSAsExpression':
        case 'TSTypeAssertion':
        case 'TSSatisfiesExpression':
        case 'TSNonNullExpression':
          inspect(node.expression, mode, members);
          break;
        case 'ConditionalExpression':
          inspect(node.consequent, mode, members);
          inspect(node.alternate, mode, members);
          break;
        case 'LogicalExpression':
          if (node.operator !== '&&') inspect(node.left, mode, members);
          inspect(node.right, mode, members);
          break;
        case 'BinaryExpression':
          if (!members.length && node.operator === '+') {
            inspect(node.left, mode);
            inspect(node.right, mode);
          }
          break;
        case 'MemberExpression':
          inspect(node.object, mode, [propertyKey(node, node.property), ...members]);
          break;
        case 'CallExpression': {
          const callee = syntax(node.callee);
          if (!members.length && callee?.type === 'MemberExpression' && propertyKey(callee, callee.property) === 'join') {
            inspect(callee.object, mode);
            inspect(list(node.arguments)[0], mode);
          }
          break;
        }
        case 'Identifier': {
          let scope = context.sourceCode.getScope(node);
          for (;;) {
            const variable = scope.set.get(String(node.name));
            if (variable) {
              const def = variable.defs[0];
              if (def?.type === 'Variable' && def.node.id.type === 'Identifier') inspect(def.node.init, mode, members);
              break;
            }
            if (!scope.upper) break;
            scope = scope.upper;
          }
          break;
        }
        case 'ObjectExpression':
          for (const prop of list(node.properties)) {
            if (prop.type === 'SpreadElement') {
              inspect(prop.argument, mode, members);
              continue;
            }
            const key = propertyKey(prop, prop.key);
            if (member !== undefined && key !== undefined && member !== key) continue;
            const styleProperty = !members.length && !classes && (key === undefined || (key && !key.startsWith('--')));
            if (!members.length && classes && syntax(prop.key)?.type === 'Literal') inspect(prop.key, mode);
            inspect(prop.value, styleProperty && (key === undefined || !colorProperty.test(key)) ? 'style' : mode, rest);
          }
          break;
        case 'ArrayExpression': {
          const elements = Array.isArray(node.elements) ? node.elements : [];
          // Spreads can shift array indices, so use all possible entries when present.
          if (member !== undefined && !elements.some(entry => syntax(entry)?.type === 'SpreadElement')) {
            if (/^(?:0|[1-9]\d*)$/.test(member)) inspect(elements[Number(member)], mode, rest);
          } else {
            for (const entry of elements) {
              const spread = members.length && syntax(entry)?.type === 'SpreadElement';
              inspect(entry, mode, spread ? [undefined, ...rest] : rest);
            }
          }
          break;
        }
        case 'SpreadElement':
          inspect(node.argument, mode, members);
          break;
      }
      active.delete(node);
    }

    return {
      /** @param {Node} raw */
      JSXAttribute(raw) {
        const node = /** @type {Syntax} */ (raw);
        const attr = nameOf(node.name);
        if (attr !== 'className' && attr !== 'style') return;
        const white = attr === 'className' && exception?.[0] === nameOf(syntax(node.parent)?.name)
          && exception?.[1] === syntax(node.value)?.value;
        inspect(node.value, white ? 'white' : attr === 'className' ? 'classes' : 'color-style');
      },
      Property(raw) {
        const node = /** @type {Syntax} */ (raw);
        const key = nameOf(node.key);
        if (key === 'className' || key === 'style') inspect(node.value, key === 'className' ? 'classes' : 'color-style');
      },
      CallExpression(raw) {
        const node = /** @type {Syntax} */ (raw);
        if (classCalls.has(String(nameOf(node.callee)))) {
          for (const arg of list(node.arguments)) inspect(arg, 'classes');
        }
      },
    };
  },
};
