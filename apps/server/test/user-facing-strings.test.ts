// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
async function violations(source: string, filePath = 'apps/web/src/features/example/page.tsx') {
  const results = await eslint.lintText(source, { filePath });
  return results.flatMap(result => result.messages).filter(message => message.ruleId === 'i18n/user-facing-strings');
}

describe('user-facing strings use the locale catalog', () => {
  it.each([
    '<button>Book a class</button>',
    '<input placeholder="Your name" />',
    '<button aria-label="Dismiss" />',
    '<img alt="Gym logo" />',
    '<PageHeader title="Schedule" />',
    '<p>{"Please wait"}</p>',
    '<p>{ready ? "Ready" : "Waiting"}</p>',
    '<p>{failed && "Try again"}</p>',
    '<p>{`Hello ${name}`}</p>',
    '<p>{"Hello " + name}</p>',
    '<input placeholder={ready ? "Your name" : t("shell/shell:loading")} />',
    '<Dialog closeLabel="Close" />',
    '<ErrorState message="Unavailable" />',
    '<EmptyState emptyText={"Nothing yet"} />',
  ])('rejects a newly hard-coded component: %s', async source => {
    expect(await violations(source)).not.toHaveLength(0);
  });
  it.each([
    '<button>{t("portal/schedule:book")}</button>',
    '<PageHeader title={t("portal/schedule:title")} />',
    '<img alt="" />',
    '<p>{member.name}</p>',
    '<p>{ready ? t("example:ready") : t("example:waiting")}</p>',
    '<p>{` · ${name}`}</p>',
    '<button>0</button>',
    '<span aria-hidden>⌫</span>',
    '<div className={`${open ? "block" : "hidden"} p-4`} />',
    '<input type="text" name="name" autoComplete="given-name" />',
    '<button aria-label={t("example:close")}>&times;</button>',
    '<Dialog closeLabel={t("example:close")} labelKey="example:close" />',
  ])('allows translations, user data and non-text attributes: %s', async source => {
    expect(await violations(source)).toHaveLength(0);
  });
  it('keeps English fixtures out of the production check', async () => {
    expect(await violations('<button>Fixture</button>', 'apps/web/src/features/example/page.test.tsx')).toHaveLength(0);
  });
  it.each([
    'h("p", null, "Welcome")',
    'createElement("a", { title: "Open the portal" }, name)',
  ])('rejects text in server-rendered templates: %s', async source => {
    expect(await violations(source, 'apps/server/src/public/pages/example.ts')).not.toHaveLength(0);
  });
  it('allows translated server templates and embedded scripts', async () => {
    expect(await violations('h("p", { title: text("help") }, text("welcome")); h("script", null, "const ready = true");',
      'apps/server/src/public/pages/example.ts')).toHaveLength(0);
  });
});
