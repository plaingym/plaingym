// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Locator, type Page } from '@playwright/test';
import type { Client } from '../support.js';
import { settle } from './capture.js';

export interface AdminDialog { name: string; button: string | RegExp; then?: (dialog: Locator, page: Page) => Promise<void> }
export interface AdminScreen {
  name: string; path: string;
  /** Reaches the screen some other way than its menu link (a detail page). */
  open?: (page: Page, origin: string) => Promise<void>;
  /** Capture each tab as well. */
  tabs?: boolean;
  dialogs?: AdminDialog[];
  /** Other states of the screen, each reached from the screen itself. */
  extras?: { name: string; reach: (page: Page, origin: string) => Promise<void> }[];
}

/** Opens the first detail link on a list screen. */
const firstLink = (list: string, prefix: string) => async (page: Page, origin: string) => {
  await page.goto(origin + list);
  await settle(page);
  const link = page.locator(`#main-content a[href^="${prefix}"]`).first();
  await expect(link).toBeVisible();
  await link.click();
  await settle(page);
};

const csv = 'externalId,firstName,lastName,email,householdExternalId,householdName,status\n'
  + 'ux-ana,Ana,Lopez,ana.lopez@example.invalid,ux-family,Lopez family,active\n'
  + 'ux-ben,Ben,Lopez,,ux-family,Lopez family,active\n';

/** Every admin screen in the menu, with the dialogs its main actions open. The populated walk adds detail pages. */
export function adminScreens({ populated, owner }: { populated: boolean; owner?: Client }): AdminScreen[] {
  const screens: AdminScreen[] = [
    { name: 'dashboard', path: '/admin' },
    { name: 'members', path: '/admin/members', dialogs: [{ name: 'add-member', button: 'Add member' }, { name: 'create-tag', button: 'Create tag' }],
      extras: [{ name: 'search-no-match', reach: async (page) => {
        await page.getByLabel('Search members', { exact: true }).fill('Zz no such person');
        await settle(page);
      } }] },
    { name: 'leads', path: '/admin/leads', tabs: true },
    { name: 'schedule', path: '/admin/schedule', dialogs: [{ name: 'new-weekly-class', button: 'New weekly class' }, { name: 'new-session', button: 'New one-off session' }] },
    { name: 'ranks', path: '/admin/ranks', dialogs: [{ name: 'add-rank', button: 'Add rank' }, { name: 'edit-rank', button: /^Edit / }] },
    { name: 'staff', path: '/admin/staff', dialogs: [{ name: 'invite', button: 'Invite staff' }, { name: 'add-profile', button: 'Add profile' }] },
    { name: 'invoices', path: '/admin/billing/invoices', dialogs: [{ name: 'one-off', button: 'Add one-off charge' }] },
    { name: 'plans', path: '/admin/billing/plans', tabs: true,
      dialogs: [{ name: 'new-plan', button: /^(New plan|Add plan|Add Plans)$/ }, { name: 'new-pack', button: 'Create class pack' }, { name: 'new-discount', button: 'Create discount' }] },
    { name: 'waivers', path: '/admin/waivers', dialogs: [{ name: 'new-template', button: 'New template' }] },
    { name: 'announcements', path: '/admin/announcements', dialogs: [{ name: 'compose', button: 'New announcement' }] },
    { name: 'campaigns', path: '/admin/campaigns', dialogs: [{ name: 'new', button: /^(New|New campaign|Create campaign)$/ }] },
    { name: 'imports', path: '/admin/imports', extras: [{ name: 'preview', reach: async (page) => {
      await page.getByLabel('CSV file (UTF-8, up to 20 MB)', { exact: true }).setInputFiles({ name: 'ux-people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.getByRole('cell', { name: /Ana/ })).toBeVisible();
    } }] },
    { name: 'reports', path: '/admin/reports', tabs: true },
    { name: 'settings', path: '/admin/settings', dialogs: [{ name: 'register-device', button: 'Register device' }] },
    { name: 'health', path: '/admin/health' },
    { name: 'account', path: '/admin/account' },
  ];
  if (!populated) return screens;
  return [...screens,
    { name: 'outbox', path: '/admin/outbox' },
    { name: 'member-profile', path: '', open: firstLink('/admin/members', '/admin/members/'), tabs: true },
    { name: 'lead-detail', path: '', open: firstLink('/admin/leads', '/admin/leads/') },
    // An unpaid invoice (open or past due), so its payment actions show.
    { name: 'invoice-detail', path: '', open: async (page, origin) => {
      const invoices = (await owner!.json<{ data: { id: string; status: string }[] }>('/api/billing/invoices?limit=100')).data;
      const unpaid = invoices.find((invoice) => ['open', 'past_due'].includes(invoice.status));
      if (!unpaid) throw new Error('The demo seed has no unpaid invoice');
      await page.goto(origin + '/admin/billing/invoices/' + unpaid.id);
      await settle(page);
    },
      dialogs: [{ name: 'record-payment', button: 'Record cash or check' }, { name: 'pay-link', button: 'Send or share pay link' }] },
    { name: 'invoice-review-hold', path: '', open: async (page, origin) => {
      const invoices = (await owner!.json<{ data: { id: string; needsReview: boolean; status: string }[] }>('/api/billing/invoices?limit=100')).data;
      const held = invoices.find((invoice) => invoice.needsReview && invoice.status === 'open');
      if (!held) throw new Error('The demo seed has no open invoice on review hold');
      await page.goto(origin + '/admin/billing/invoices/' + held.id);
      await settle(page);
    }, dialogs: [{ name: 'release', button: 'Release review hold' }] },
    { name: 'session', path: '', open: async (page, origin) => {
      await page.goto(origin + '/admin/schedule');
      await settle(page);
      await page.locator('#main-content').getByRole('button', { name: /^\d{2}:\d{2}–\d{2}:\d{2} / }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
    } },
  ];
}

/** What the release check can answer while the banner shows, worded as the server words it. */
export function updateStates() {
  const checkedAt = new Date().toISOString();
  const tile = (message: string, latestVersion: string, releaseUrl: string | null) => ({ id: 'update_available', status: 'warning', checkedAt, message,
    details: { currentVersion: '1.2.3', latestVersion, available: true, releaseUrl } });
  return {
    minor: tile('Version 1.3.0 is available. This install runs 1.2.3. Run the updater on the server to install it.', '1.3.0',
      'https://github.com/plaingym/plaingym/releases/tag/v1.3.0'),
    'patch-held': tile('Version 1.2.4, a patch release, has not installed by itself. Automatic updates are off. To install it now, update by hand as the updating guide describes. This install runs 1.2.3.',
      '1.2.4', 'https://github.com/plaingym/plaingym/releases/tag/v1.2.4'),
    'bad-repository': tile('Patch releases cannot install because RELEASE_REPOSITORY is invalid. Set it to a GitHub owner/name, with neither segment made only of dots, and restart the app.',
      'unknown', null),
  };
}
