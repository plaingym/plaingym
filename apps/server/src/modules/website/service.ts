// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray } from 'drizzle-orm';
import { forGym, uuidv7, RevisionConflictError, classTemplatePrograms, classTemplates, planTaxRates, plans, programs,
  staffProfiles, taxRates, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { GymAddress, GymBranding } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Uploads } from '../../infra/storage/index.js';
import { readGymSettings } from '../../areas/settings/settings.js';
import { createModuleSettings, readModuleSettings, type ModuleSettings } from '../../areas/settings/module-settings.js';
import { addsTaxOnTop } from '../../areas/billing/invoicing/adds-tax-on-top.js';
import { validatePhoto } from '../../areas/members/photos.js';
import { maxPhotos, photoTypes, storedContent, type StoredContent, type UpdateWebsiteRequest, type WebsiteSettings,
  uploadLogoRequestSchema, uploadPhotoRequestSchema, removeLogoRequestSchema, updateWebsiteRequestSchema } from './content.js';

export const moduleId = 'website';
export interface WebsiteOptions {
  readonly scope?: typeof forGym;
  readonly clock?: Clock;
  /** The runtime passes `uploads.forGym`; without it photo and logo uploads and photo reads fail closed. */
  readonly uploadsFor?: (gymId: string) => Promise<Uploads>;
}
export interface SiteClass {
  readonly id: string; readonly name: string; readonly weekday: number; readonly localStartTime: string;
  readonly durationMinutes: number; readonly kind: 'class' | 'open_mat'; readonly coach: string | null; readonly programIds: readonly string[];
}
export interface SitePlan {
  readonly id: string; readonly name: string; readonly amountCents: number; readonly currency: string; readonly interval: 'monthly' | 'annual';
  readonly plusTax: boolean; readonly signupFeeCents: number; readonly trialDays: number; readonly commitmentMonths: number | null;
}
export interface SiteCoach { readonly id: string; readonly displayName: string; readonly bio: string | null; readonly rank: string | null; readonly photo: boolean }
/** Everything a website page shows: public gym data only, read in one short transaction. */
export interface Site {
  readonly gym: { readonly name: string; readonly revision: number; readonly timezone: string; readonly address: GymAddress;
    readonly logo: boolean; readonly primaryColor: string | null; readonly updatedAt: string };
  readonly content: StoredContent;
  readonly programs: readonly { readonly id: string; readonly name: string }[];
  readonly classes: readonly SiteClass[];
  readonly plans: readonly SitePlan[];
  readonly coaches: readonly SiteCoach[];
}
export type SitePart = 'programs' | 'classes' | 'plans' | 'coaches';

const missing = (what = 'Not found'): never => { throw new AppError('not_found', what); };
const ownLogo = (gymId: string, key: string | null | undefined): key is string => !!key && key.startsWith(`${gymId}/website/logo/`);
/** Monday first, the order a weekly timetable reads in most places; weekday 0 is Sunday. */
const weekOrder = (weekday: number) => (weekday + 6) % 7;

function present(saved: ModuleSettings): WebsiteSettings {
  const content = storedContent(saved.value);
  return { revision: saved.revision, tagline: content.tagline, about: content.about, phone: content.phone, email: content.email,
    accentColor: content.accentColor, primaryColor: saved.branding.primaryColor ?? null, logo: !!saved.branding.logoKey,
    photos: content.photos.map(({ id, alt }) => ({ id, alt })) };
}
/** The branding with a new primary color, or none (the default theme). */
function withPrimaryColor(branding: GymBranding, primaryColor: string | null): GymBranding {
  const next: GymBranding = { ...branding };
  delete next.primaryColor;
  return primaryColor ? { ...next, primaryColor } : next;
}

async function readPlans(tx: Transaction, currency: string): Promise<SitePlan[]> {
  const rows = await tx.select().from(plans).where(and(eq(plans.active, true), eq(plans.currency, currency)))
    .orderBy(asc(plans.amountCents), asc(plans.name), asc(plans.id));
  // Invoicing adds tax on top for an attached rate that is exclusive and above zero (the join page's rule).
  const taxed = rows.length ? new Set((await tx.selectDistinct({ planId: planTaxRates.planId }).from(planTaxRates)
    .innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId))
    .where(and(inArray(planTaxRates.planId, rows.map((row) => row.id)), addsTaxOnTop))).map((row) => row.planId)) : new Set<string>();
  return rows.map((row) => ({ id: row.id, name: row.name, amountCents: row.amountCents, currency: row.currency,
    interval: row.interval as SitePlan['interval'], plusTax: taxed.has(row.id), signupFeeCents: row.signupFeeCents,
    trialDays: row.trialDays, commitmentMonths: row.commitmentMonths }));
}
async function readClasses(tx: Transaction, active: ReadonlySet<string>): Promise<SiteClass[]> {
  const rows = await tx.select({ id: classTemplates.id, name: classTemplates.name, weekday: classTemplates.weekday,
    localStartTime: classTemplates.localStartTime, durationMinutes: classTemplates.durationMinutes, kind: classTemplates.kind,
    coach: staffProfiles.displayName, coachPublic: staffProfiles.isPublic })
    .from(classTemplates).leftJoin(staffProfiles, eq(staffProfiles.id, classTemplates.coachId));
  const links = rows.length ? await tx.select({ templateId: classTemplatePrograms.templateId, programId: classTemplatePrograms.programId })
    .from(classTemplatePrograms).where(inArray(classTemplatePrograms.templateId, rows.map((row) => row.id))) : [];
  return rows.map((row) => ({ id: row.id, name: row.name, weekday: row.weekday, localStartTime: row.localStartTime,
    durationMinutes: row.durationMinutes, kind: row.kind === 'open_mat' ? 'open_mat' as const : 'class' as const,
    // Only a coach whose profile is public is named on the website.
    coach: row.coachPublic ? row.coach : null,
    programIds: links.filter((link) => link.templateId === row.id && active.has(link.programId)).map((link) => link.programId) }))
    .sort((a, b) => weekOrder(a.weekday) - weekOrder(b.weekday) || a.localStartTime.localeCompare(b.localStartTime) || a.name.localeCompare(b.name));
}

export function createWebsiteService(options: WebsiteOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const store = createModuleSettings({ scope, clock });
  const uploads = async (gymId: string) => options.uploadsFor ? options.uploadsFor(gymId) : missing();
  /** Streams one of the gym's own uploads, or 404 for a key from elsewhere, a deleted file or an unexpected type. */
  async function stream(gymId: string, key: string, prefix: string) {
    if (!key.startsWith(`${gymId}/${prefix}`)) return missing();
    const files = await uploads(gymId), info = await files.head(key);
    if (!info || info.deletedAt || !(photoTypes as readonly string[]).includes(info.contentType)) return missing();
    const body = await files.get(key);
    return body ? { body, contentType: info.contentType } : missing();
  }
  async function current(gymId: string, revision: number) {
    const saved = await store.get(gymId, moduleId);
    if (saved.revision !== revision) throw new RevisionConflictError();
    return saved;
  }
  /** Stores the bytes under a new key, then saves; a save that fails marks the new file deleted. */
  async function stored<T>(gymId: string, prefix: string, bytes: Uint8Array, contentType: string, save: (key: string) => Promise<T>) {
    validatePhoto(bytes, contentType);
    const files = await uploads(gymId), key = `${gymId}/website/${prefix}/${uuidv7(clock.now().getTime())}`;
    await files.put(key, bytes, contentType);
    try { return await save(key); }
    catch (error) { await files.markDeleted(key); throw error; }
  }
  return {
    async site(gymId: string, parts: readonly SitePart[] = []): Promise<Site> {
      const want = new Set(parts);
      return scope(gymId, async (tx) => {
        const gym = await readGymSettings(tx, gymId), saved = await readModuleSettings(tx, gymId, moduleId);
        const active = want.has('programs') || want.has('classes')
          ? await tx.select({ id: programs.id, name: programs.name }).from(programs).where(eq(programs.active, true)).orderBy(asc(programs.name)) : [];
        const coaches = want.has('coaches') ? await tx.select({ id: staffProfiles.id, displayName: staffProfiles.displayName, bio: staffProfiles.bio,
          rank: staffProfiles.rank, photoKey: staffProfiles.photoKey }).from(staffProfiles).where(eq(staffProfiles.isPublic, true))
          .orderBy(asc(staffProfiles.displayName), asc(staffProfiles.id)) : [];
        return {
          gym: { name: gym.name, revision: gym.revision, timezone: gym.timezone, address: gym.address, logo: !!gym.branding.logoKey,
            primaryColor: gym.branding.primaryColor ?? null, updatedAt: gym.updatedAt },
          content: storedContent(saved.value),
          programs: want.has('programs') ? active : [],
          classes: want.has('classes') ? await readClasses(tx, new Set(active.map((program) => program.id))) : [],
          plans: want.has('plans') ? await readPlans(tx, gym.currency) : [],
          coaches: coaches.map(({ photoKey, ...coach }) => ({ ...coach, photo: !!photoKey })),
        };
      });
    },
    async settings(gymId: string) { return present(await store.get(gymId, moduleId)); },
    async update(context: MutationContext, body: UpdateWebsiteRequest) {
      const input = updateWebsiteRequestSchema.parse(body);
      let removed: string[] = [];
      const saved = await store.save(context, moduleId, input.revision, ({ value, branding }) => {
        const content = storedContent(value);
        const photos = input.photos.map(({ id, alt }) => ({ ...(content.photos.find((photo) => photo.id === id) ?? missing('Photo not found')), alt }));
        removed = content.photos.filter((photo) => !photos.some((kept) => kept.id === photo.id)).map((photo) => photo.key);
        return { value: { ...content, tagline: input.tagline || null, about: input.about || null, phone: input.phone || null,
          email: input.email, accentColor: input.accentColor, photos }, branding: withPrimaryColor(branding, input.primaryColor) };
      });
      // Storage calls run after the save commits: a removed photo stays readable until the uploads sweep.
      if (removed.length) { const files = await uploads(context.gymId); for (const key of removed) await files.markDeleted(key); }
      return present(saved);
    },
    async uploadPhoto(context: MutationContext, body: unknown) {
      const input = uploadPhotoRequestSchema.parse(body);
      const before = storedContent((await current(context.gymId, input.revision)).value);
      if (before.photos.length >= maxPhotos) throw new AppError('conflict', 'Remove a photo before adding another');
      return present(await stored(context.gymId, 'photos', Buffer.from(input.base64, 'base64'), input.contentType, (key) =>
        store.save(context, moduleId, input.revision, ({ value }) => {
          const content = storedContent(value);
          if (content.photos.length >= maxPhotos) throw new AppError('conflict', 'Remove a photo before adding another');
          return { value: { ...content, photos: [...content.photos, { id: uuidv7(clock.now().getTime()), key, contentType: input.contentType, alt: input.alt }] } };
        })));
    },
    async uploadLogo(context: MutationContext, body: unknown) {
      const input = uploadLogoRequestSchema.parse(body);
      await current(context.gymId, input.revision);
      let previous: string | null | undefined;
      const saved = await stored(context.gymId, 'logo', Buffer.from(input.base64, 'base64'), input.contentType, (key) =>
        store.save(context, moduleId, input.revision, ({ value, branding }) => {
          previous = branding.logoKey;
          return { value, branding: { ...branding, logoKey: key } };
        }));
      // Only a logo this module uploaded is released; a key set some other way may still be in use.
      if (ownLogo(context.gymId, previous)) await (await uploads(context.gymId)).markDeleted(previous);
      return present(saved);
    },
    async removeLogo(context: MutationContext, body: unknown) {
      const input = removeLogoRequestSchema.parse(body);
      let previous: string | null | undefined;
      const saved = await store.save(context, moduleId, input.revision, ({ value, branding }) => {
        previous = branding.logoKey;
        return { value, branding: { ...branding, logoKey: null } };
      });
      if (ownLogo(context.gymId, previous)) await (await uploads(context.gymId)).markDeleted(previous);
      return present(saved);
    },
    async photo(gymId: string, photoId: string) {
      const content = storedContent((await store.get(gymId, moduleId)).value);
      const photo = content.photos.find((item) => item.id === photoId) ?? missing('Photo not found');
      return stream(gymId, photo.key, 'website/photos/');
    },
    /** A coach's photo, only while the profile is public. */
    async coachPhoto(gymId: string, staffProfileId: string) {
      const [profile] = await scope(gymId, (tx) => tx.select({ photoKey: staffProfiles.photoKey }).from(staffProfiles)
        .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.isPublic, true))));
      return profile?.photoKey ? stream(gymId, profile.photoKey, 'staff/') : missing('Photo not found');
    },
  };
}
export type WebsiteService = ReturnType<typeof createWebsiteService>;
