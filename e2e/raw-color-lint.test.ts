// SPDX-License-Identifier: AGPL-3.0-only
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
