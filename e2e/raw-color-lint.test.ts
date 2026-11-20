// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../', import.meta.url)) });

async function violations(source: string, path = 'components/fixture.tsx') {
  const [result] = await eslint.lintText(source, { filePath: 'apps/web/src/' + path });
  expect(result?.fatalErrorCount).toBe(0);
  return result!.messages.filter(message => message.ruleId === 'theme/raw-color').map(message => message.message);
}

it('rejects literal palette utilities and colors flowing into classes and styles', async () => {
  const messages = await violations(`
    const palette = ok ? 'dark:hover:bg-red-300/50' : 'text-gray-500!';
    const styles = { borderColor: 'rgb(1 2 3)', backgroundColor: '#aabbccdd' };
    const button = cva('border-red-300', { variants: { active: { true: 'text-black' } } });
    export const Example = <div className={cn(palette, 'bg-white', 'bg-[linear-gradient(#fff_50%,hsl(0_0%_0%))]', button())} style={styles}/>;
  `);
  expect(messages).toHaveLength(9);
  for (const color of ['bg-red-300', 'text-gray-500', 'rgb(', '#aabbccdd', 'border-red-300', 'text-black', 'bg-white', '#fff', 'hsl(']) {
    expect(messages).toContain('Use a theme token in place of ' + color + '.');
  }
});

it('rejects every palette family Tailwind ships and modern color functions', async () => {
  const messages = await violations(`
    export const Example = <div className="bg-mist-100 text-taupe-900 border-olive-300 ring-mauve-500 bg-[oklch(0.97_0_0)]"/>;
  `);
  expect(messages).toHaveLength(5);
  for (const color of ['bg-mist-100', 'text-taupe-900', 'border-olive-300', 'ring-mauve-500', 'oklch(']) {
    expect(messages).toContain('Use a theme token in place of ' + color + '.');
  }
});

it.each(['routes/login.tsx', 'routes/__root.tsx', 'app/admin-shell.tsx'])('checks styling in %s', async path => {
  await expect(violations('export const Example = <div className="bg-red-500"/>;', path))
    .resolves.toEqual(['Use a theme token in place of bg-red-500.']);
});

it('follows computed and static member lookups, joins and twMerge arguments', async () => {
  const messages = await violations(`
    const tones = ['text-primary', 'dark:text-pink-500'] as const;
    const badges = { active: 'bg-foreground', inactive: 'bg-gray-500' } as const;
    const presets = { default: { ring: 'ring-indigo-500' }, other: { ring: 'ring-border' } };
    const classes = [tones[index], badges[status], presets.default.ring].join(' ');
    const merged = twMerge(classes, 'border-cyan-300');
    export const Example = <div className={merged}/>;
  `);
  expect(messages).toHaveLength(4);
  for (const color of ['text-pink-500', 'bg-gray-500', 'ring-indigo-500', 'border-cyan-300']) {
    expect(messages).toContain('Use a theme token in place of ' + color + '.');
  }
});

it('only reads selected static members, and handles cyclic lookups', async () => {
  await expect(violations(`
    const tones = [, 'text-primary', 'text-pink-500'];
    const badges = { active: 'bg-foreground', inactive: 'bg-gray-500' };
    const cyclic = { next: cyclic.next, tone: 'text-foreground' };
    export const Example = <div className={cn(tones[1], badges['active'], cyclic.next)}/>;
  `)).resolves.toEqual([]);
});

it('rejects CSS named colors in arbitrary utility values and inline styles', async () => {
  const messages = await violations(`
    const styles = { border: '1px solid RebeccaPurple', background: 'white', color: 'navy' };
    export const Example = <div className="bg-[red] dark:bg-[linear-gradient(cornflowerblue,white)]" style={styles}/>;
  `);
  expect(messages).toHaveLength(6);
  for (const color of ['red', 'cornflowerblue', 'white', 'RebeccaPurple', 'navy']) {
    expect(messages).toContain('Use a theme token in place of ' + color + '.');
  }
});

it('accepts color keywords that adapt, custom properties, and named words used as data', async () => {
  await expect(violations(`
    export const Example = <div
      className="text-[var(--red)] bg-[url(/red.svg)] before:content-['red'] bg-[transparent]"
      style={{ color: 'currentColor', backgroundColor: 'var(--white)', fontFamily: 'black' }}/>;
  `)).resolves.toEqual([]);
});

it('does not treat mask images as color properties', async () => {
  await expect(violations(`
    const styles = { maskImage: 'linear-gradient(black, transparent)', mask: 'url(/mask.png)' };
    export const Example = <div style={styles}/>;
  `)).resolves.toEqual([]);
});

it('does not read named colors from an unknown computed style key', async () => {
  await expect(violations(`
    export const Example = <div style={{ [fontProp]: 'Arial Black' }}/>;
  `)).resolves.toEqual([]);
});

it('rejects named colors in Tailwind arbitrary properties', async () => {
  const messages = await violations(`
    export const Example = <div className="[color:red] [background-color:navy] [font-family:Arial_Black] [mask-image:linear-gradient(black,transparent)]"/>;
  `);
  expect(messages).toEqual([
    'Use a theme token in place of red.',
    'Use a theme token in place of navy.',
  ]);
});

it('reports a literal reached through a color and a non-color property once', async () => {
  const messages = await violations(`
    const ink = '#123456';
    export const Example = <div style={{ color: ink, fontFamily: ink }}/>;
  `);
  expect(messages).toEqual(['Use a theme token in place of #123456.']);
});

it('documents that imported or destructured class tables are checked where defined', () => {
  const readme = readFileSync(fileURLToPath(new URL('../apps/web/README.md', import.meta.url)), 'utf8');
  expect(readme.replace(/\s+/g, ' ')).toContain(
    'Class tables imported from another file, or reached through destructuring, are checked only where they are defined',
  );
});

it('finds the exact light-media exception when ESLint runs from apps/web', async () => {
  const webLint = new ESLint({ cwd: fileURLToPath(new URL('../apps/web/', import.meta.url)) });
  const [result] = await webLint.lintText('export const Example = <img className="mx-auto h-auto w-full max-w-72 rounded-lg bg-white p-2"/>;', {
    filePath: 'src/features/portal/checkin/page.tsx',
  });
  expect(result?.messages.filter(message => message.ruleId === 'theme/raw-color')).toEqual([]);
});

it('accepts semantic tokens, data defaults and an exact light-media exception', async () => {
  const src = `
    context.strokeStyle = '#000';
    export const Example = <><input type="color" defaultValue="#123456"
      className="border-border text-muted-foreground text-[12px]" style={{ color: 'var(--color-primary)' }}/>
      <img className="mx-auto h-auto w-full max-w-72 rounded-lg bg-white p-2"/></>;
  `;
  await expect(violations(src, 'features/portal/checkin/page.tsx')).resolves.toEqual([]);
  await expect(violations(src)).resolves.toHaveLength(1);
  await expect(violations(src.replace('<img', '<div'), 'features/portal/checkin/page.tsx')).resolves.toHaveLength(1);
});
